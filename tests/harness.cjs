/* 用真实容器宽度渲染，模拟 DSH 设置面板（约 410px 内容宽） */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const FRAG = Symbol('Fragment');
const STORES = new Map();
let DIRTY = false;
const WIDTH = Number(process.env.W || 410);
const PANEL_W = WIDTH - 32;
const HEIGHT = Number(process.env.H || 900);
const THEME = process.env.THEME || 'dark';

function storeOf(t) { let s = STORES.get(t); if (!s) { s = { slots: [], effects: [] }; STORES.set(t, s); } return s; }
function makeReact() {
  const element = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const cur = { s: null, idx: 0 };
  return {
    createElement: element, Fragment: FRAG,
    useState(init) {
      const s = cur.s, i = cur.idx++;
      if (s.slots.length <= i) {
        let v = typeof init === 'function' ? init() : init;
        // 测试注入：热力图模式初始值是 'daily'，用 HEAT_MODE 替换以真实渲染每周/累计档
        if (v === 'daily' && process.env.HEAT_MODE) v = process.env.HEAT_MODE;
        s.slots[i] = { v };
      }
      return [s.slots[i].v, (nv) => { s.slots[i].v = typeof nv === 'function' ? nv(s.slots[i].v) : nv; DIRTY = true; }];
    },
    useMemo(fn) { cur.idx++; return fn(); },
    useCallback(fn) { cur.idx++; return fn; },
    useRef() { const i = cur.idx++, s = cur.s; if (!s.slots[i]) s.slots[i] = { v: { current: { getBoundingClientRect: () => ({ width: PANEL_W, height: 300 }) } } }; return s.slots[i].v; },
    useEffect(fn) { cur.idx++; cur.s.effects.push(fn); },
    __cur: cur,
  };
}
// 缓存解析：USAGE_CACHE 显式指定优先（文件不可用则直接用合成数据，不回退默认路径）；
// 未指定则读本机默认缓存；两者都不可用 → 内置合成数据生成器
function loadCache() {
  const file = process.env.USAGE_CACHE || path.join(os.homedir(), '.dsh', 'profiles', 'web', 'usage-stats-cache.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return synthetic(); }
}
// 合成数据：确定性 LCG（种子 261，禁用裸 Math.random），锚定「今天」，字段结构同真实 API 响应
function synthetic() {
  let s = 261;
  const rnd = () => ((s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296);
  const NAMES = ['model-a', 'model-b', 'model-c', 'model-d', 'model-e', 'model-f'];
  const MODELS = NAMES.slice(0, 4 + Math.floor(rnd() * 3)); // 4~6 个模型
  const COLORS = ['#5ad0ce', '#ff4d4f', '#7ac04f', '#a684ff', '#e28a5a', '#50d682'];
  const DAY = 86400000, today = new Date(); today.setHours(0, 0, 0, 0);
  const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  // 单日单模型 token 量级 1e4~1e7；input/output/cacheRead 与真实响应同字段
  const mk = (m, t) => { const i = Math.round(t * 0.12), o = Math.round(t * 0.03);
    return { model: m, color: COLORS[NAMES.indexOf(m) % COLORS.length], input: i, output: o, cacheRead: t - i - o, cacheWrite: 0, total: t }; };
  const days = [];
  for (let i = 44; i >= 0; i--) { // 最近 45 天
    if (i >= 7 && rnd() >= 0.85) continue; // ~85% 天活跃（最近 7 天保底活跃，保证有 hours 明细）
    const date = key(new Date(today.getTime() - i * DAY)), byModel = [];
    for (let k = 0, n = 1 + Math.floor(rnd() * 3); k < n; k++) {
      const m = MODELS[Math.floor(rnd() * MODELS.length)];
      if (!byModel.some((b) => b.model === m)) byModel.push(mk(m, Math.round(1e4 * Math.pow(10, rnd() * 3)))); // 同日同模型去重
    }
    const total = byModel.reduce((a, b) => a + b.total, 0);
    const day = { date, total, turns: 1 + Math.floor(rnd() * 60), byModel };
    if (i < 7) { // 最近 7 天带 hours 明细
      let left = total; day.hours = [];
      for (let h = 0; left > 0; h++) {
        const t = h >= 23 ? left : Math.round(left * rnd() * 0.5);
        day.hours.push({ hour: h, total: t, byModel: [mk(byModel[h % byModel.length].model, t)] });
        left -= t;
      }
    }
    days.push(day);
  }
  const agg = new Map();
  for (const d of days) for (const b of d.byModel) {
    const t = agg.get(b.model) || { ...b, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    t.input += b.input; t.output += b.output; t.cacheRead += b.cacheRead; t.cacheWrite += b.cacheWrite; t.total += b.total;
    agg.set(b.model, t);
  }
  const totals = [...agg.values()].sort((a, b) => b.total - a.total), grandTotal = totals.reduce((a, b) => a + b.total, 0), top = totals[0];
  const peak = days.reduce((mx, d) => Math.max(mx, d.total), 0);
  return {
    ok: true, generatedAt: Date.now(), sessionCount: days.length * 2, messageCount: days.reduce((a, d) => a + d.turns, 0) * 3,
    dayCount: days.length, currentStreak: 0,
    summary: { totalTokens: grandTotal, peakDayTokens: peak, longestSessionMs: 0, currentStreak: 0, longestStreak: 0 },
    grandTotal,
    topModel: top ? { name: top.model, color: top.color, tokens: top.total, percent: grandTotal > 0 ? Math.round((top.total / grandTotal) * 100) : 0 } : null,
    totals, days, warnings: [],
  };
}
const CACHE = loadCache();
function loadPlugin() {
  const src = fs.readFileSync(path.join(ROOT, 'build', 'client.new.js'), 'utf8');
  let cap = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (d) => { cap = d; } }, innerWidth: 1400, innerHeight: 900, addEventListener() {}, removeEventListener() {} },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    fetch: async () => ({ ok: true, json: async () => CACHE }),
    requestAnimationFrame: (fn) => fn(),
    ResizeObserver: class { constructor(cb) { this.cb = cb; } observe() { this.cb(); } disconnect() {} },
    Math, Date, Number, String, Array, Object, Map, Set, JSON, console, isNaN, parseInt, parseFloat, Symbol, Boolean, Error,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return cap;
}
// 仅 HTML 空元素不闭合；SVG 元素必须闭合（否则解析器会把后续兄弟节点吞成子节点）
const VOID = new Set(['br','img','input','hr','meta','link']);
const ATTR = { className:'class', viewBox:'viewBox', preserveAspectRatio:'preserveAspectRatio', strokeWidth:'stroke-width', strokeLinecap:'stroke-linecap', strokeLinejoin:'stroke-linejoin', strokeDasharray:'stroke-dasharray', strokeDashoffset:'stroke-dashoffset', textAnchor:'text-anchor', fillOpacity:'fill-opacity', strokeOpacity:'stroke-opacity', ariaLabel:'aria-label', role:'role', tabIndex:'tabindex' };
function ser(node, out, react) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) { node.forEach((n) => ser(n, out, react)); return; }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
  if (typeof node.type === 'function') {
    const ps = react.__cur.s, pi = react.__cur.idx;
    react.__cur.s = storeOf(node.type); react.__cur.idx = 0; react.__cur.s.effects = [];
    const r = node.type({ ...node.props, children: node.children });
    react.__cur.s = ps; react.__cur.idx = pi;
    ser(r, out, react); return;
  }
  if (node.type === FRAG) { ser(node.children, out, react); return; }
  const tag = node.type, attrs = [];
  for (const [k, v] of Object.entries(node.props || {})) {
    if (k === 'children' || k === 'key') continue;
    if (typeof v === 'function') continue;
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style' && typeof v === 'object') { attrs.push('style="' + Object.entries(v).map(([a, b]) => a.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()) + ':' + b).join(';') + '"'); continue; }
    const name = ATTR[k] || (k.indexOf('-') >= 0 ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()));
    attrs.push(name + '="' + String(v).replace(/"/g, '&quot;') + '"');
  }
  out.push('<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>');
  ser(node.children, out, react);
  if (!VOID.has(tag)) out.push('</' + tag + '>');
}
(async () => {
  const def = loadPlugin();
  const react = makeReact();
  const mod = def.factory((n) => { if (n === 'react') return react; throw new Error('mod ' + n); });
  let View = null;
  mod.apply({ effect: () => {}, slots: { inject: (n, cb) => cb(), register: (a, c) => { View = c; } } });
  const html = [];
  for (let pass = 0; pass < 6; pass++) {
    DIRTY = false; html.length = 0;
    const ps = react.__cur.s; react.__cur.s = storeOf(View); react.__cur.idx = 0;
    ser(View({}), html, react);
    react.__cur.s = ps;
    const fx = [];
    for (const s of STORES.values()) { fx.push(...s.effects); s.effects = []; }
    fx.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 40));
    if (!DIRTY && fx.length === 0) break;
  }
  const css = fs.readFileSync(path.join(ROOT, 'build', 'panel.css'), 'utf8');
  const bodyAttr = THEME === 'dark' ? ' data-ds-dark-theme=""' : '';
  const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:${THEME === 'dark' ? '#1B1A18' : '#EFEEEA'}}
#frame{width:${WIDTH}px;margin:0 auto;padding:20px 16px;background:${THEME === 'dark' ? '#1B1A18' : '#EFEEEA'};min-height:${HEIGHT}px}
${css}</style></head><body${bodyAttr}><div id="frame">${html.join('')}</div></body></html>`;
  const out = path.join(__dirname, 'preview-' + THEME + '-' + WIDTH + '.html');
  fs.writeFileSync(out, page, 'utf8');
  const s = html.join('');
  const nan = (s.match(/NaN/g) || []).length;
  console.log('W=' + WIDTH, 'bytes=' + page.length, 'NaN=' + nan,
    '| circle=' + (s.match(/<circle/g) || []).length,
    'line=' + (s.match(/<line/g) || []).length,
    'path=' + (s.match(/<path/g) || []).length,
    'text=' + (s.match(/<text/g) || []).length);
  console.log('out:', out);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
