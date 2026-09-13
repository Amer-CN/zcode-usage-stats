/* custom 色板合规校验（按 skill 的自定义色板规则）
   1) 每个类目色相对主题底色 >=3:1（数据形状硬门）
   2) 类目色两两 RGB 距离 >=60（一眼可分辨）
   3) 序数色明度单调 + 最深档 >=3:1
   4) INK_BOOST：彩色下线宽必须 x1.8
   5) 颜色不单独承载信息：图例/列表必须带模型名
*/
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'build', 'panel.css'), 'utf8');
const body = fs.readFileSync(path.join(__dirname, '..', 'build', 'body.js'), 'utf8');

function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) { const h = hex.replace('#', ''); return 0.2126 * srgb(parseInt(h.slice(0, 2), 16)) + 0.7152 * srgb(parseInt(h.slice(2, 4), 16)) + 0.0722 * srgb(parseInt(h.slice(4, 6), 16)); }
function ratio(a, b) { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }
function dist(a, b) {
  const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}
// 直接按 CSS 声明行解析，避免多层正则转义
function varsOf(blockRe) {
  const blk = blockRe.exec(css);
  if (!blk) return null;
  const out = {};
  const lineRe = /--([cq])(\d)\s*:\s*(#[0-9A-Fa-f]{6})/g;
  let m;
  while ((m = lineRe.exec(blk[1])) !== null) {
    const key = (m[1] === 'c' ? 'cat' : 'q') + m[2];
    if (!out[key]) out[key] = m[3];
  }
  return out;
}
const LIGHT_BLOCK = /\.ust-root\s*\{([^}]*)\}/;
const DARK_BLOCK = /body\[data-ds-dark-theme\]\s*\.ust-root\s*\{([^}]*)\}/;
const L = varsOf(LIGHT_BLOCK), D = varsOf(DARK_BLOCK);
const pick = (v, pre, n) => { const a = []; for (let i = 1; i <= n; i++) { const k = pre + i; if (v && v[k]) a.push(v[k]); } return a; };
const catsOf = (v) => { const a = []; for (let i = 0; i < 6; i++) { if (v && v['cat' + i]) a.push(v['cat' + i]); } return a; };

const THEMES = [
  { name: '浅色', bg: '#FFFFFF', cats: catsOf(L), ramp: pick(L, 'q', 4), rampDarkerAtEnd: true },
  { name: '深色', bg: '#171614', cats: catsOf(D), ramp: pick(D, 'q', 4), rampDarkerAtEnd: false },
];
let bad = 0;
const chk = (ok, msg) => { if (!ok) bad++; console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + msg); };
for (const T of THEMES) {
  console.log('=== ' + T.name + ' ===');
  chk(T.cats.length === 6, T.name + ' 类目色 6 档齐全（实际 ' + T.cats.length + '）');
  T.cats.forEach((c, i) => { const r = ratio(c, T.bg); chk(r >= 3, T.name + ' cat' + i + ' ' + c + ' 对比 ' + r.toFixed(2) + ':1 >=3'); });
  let worst = 999, pair = '';
  for (let i = 0; i < T.cats.length; i++) for (let j = i + 1; j < T.cats.length; j++) {
    const d = dist(T.cats[i], T.cats[j]);
    if (d < worst) { worst = d; pair = i + '/' + j; }
  }
  chk(worst >= 60, T.name + ' 类目色两两可分辨（最近一对 ' + pair + ' 距离 ' + worst.toFixed(0) + ' >=60）');
  chk(T.ramp.length === 4, T.name + ' 序数色 4 档齐全（实际 ' + T.ramp.length + '）');
  if (T.ramp.length === 4) {
    const ls = T.ramp.map(lum);
    const mono = T.rampDarkerAtEnd ? ls.every((v, i) => i === 0 || v < ls[i - 1]) : ls.every((v, i) => i === 0 || v > ls[i - 1]);
    chk(mono, T.name + ' 序数色明度单调（深浅如实表达大小）');
    const deep = T.ramp[T.ramp.length - 1];
    chk(ratio(deep, T.bg) >= 3, T.name + ' 序数最深档 ' + deep + ' 对比 ' + ratio(deep, T.bg).toFixed(2) + ':1 >=3');
  }
}
const hair = /ust-hair[^}]*stroke-width:\s*([\d.]+)/.exec(css);
chk(!!hair && parseFloat(hair[1]) >= 2.7, 'INK_BOOST 折线 >=2.7px（x1.8）' + (hair ? hair[1] + 'px' : '缺失'));
const tick = /ust-tick[^}]*stroke-width:\s*([\d.]+)/.exec(css);
chk(!!tick && parseFloat(tick[1]) >= 3.6, 'INK_BOOST 刻度 >=3.6px（x1.8）' + (tick ? tick[1] + 'px' : '缺失'));
chk(/ust-model-name/.test(body) && /ust-legend-item/.test(body), '颜色不单独承载信息：图例与模型列表均带模型名');
console.log('\n' + (bad === 0 ? 'custom 色板合规。' : bad + ' 项不合规。'));
process.exit(bad ? 1 : 0);
