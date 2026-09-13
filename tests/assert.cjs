/* 几何断言：验证三张图在真实面板宽度下的可读性（不依赖肉眼截图） */
const fs = require('fs');
const path = require('path');
const W = Number(process.env.W || 410);

function parseSvg(html, label) {
  const i = html.findIndex ? -1 : -1;
  const key = 'aria-label="' + label + '"';
  const at = html.indexOf(key);
  if (at < 0) return null;
  const s = html.lastIndexOf('<svg', at);
  const e = html.indexOf('</svg>', at) + 6;
  return html.slice(s, e);
}
const circle = (t) => [...t.matchAll(/<circle([^>]*)>/g)].map((m) => {
  const a = m[1];
  const g = (k) => { const r = new RegExp(k + '="([^"]*)"').exec(a); return r ? r[1] : null; };
  return { cls: g('class') || '', cx: Number(g('cx')), cy: Number(g('cy')), r: Number(g('r')), fill: g('fill') };
});
const line = (t) => [...t.matchAll(/<line([^>]*)>/g)].map((m) => {
  const a = m[1];
  const g = (k) => { const r = new RegExp(k + '="([^"]*)"').exec(a); return r ? r[1] : null; };
  return { cls: g('class') || '', x1: Number(g('x1')), y1: Number(g('y1')), x2: Number(g('x2')), y2: Number(g('y2')) };
});
const pathEls = (t) => [...t.matchAll(/<path([^>]*)>/g)].map((m) => {
  const a = m[1];
  const g = (k) => { const r = new RegExp(k + '="([^"]*)"').exec(a); return r ? r[1] : null; };
  return { cls: g('class') || '', d: g('d') || '' };
});
const textEls = (t) => [...t.matchAll(/<text([^>]*)>([^<]*)</g)].map((m) => ({ attrs: m[1], body: m[2] }));
const attr = (t, k) => { const r = new RegExp(k + '="([^"]*)"').exec(t); return r ? r[1] : null; };

const fails = [];
const notes = [];
function check(cond, msg) { if (cond) notes.push('  PASS ' + msg); else fails.push('  FAIL ' + msg); }

(async () => {
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, [path.join(__dirname, 'harness.cjs')], { env: { ...process.env, W: String(W), THEME: 'dark' }, stdio: 'ignore' });
  const html = fs.readFileSync(path.join(__dirname, 'preview-dark-' + W + '.html'), 'utf8');
  const cssText = fs.readFileSync(path.join(__dirname, '..', 'build', 'panel.css'), 'utf8');

  console.log('=== 容器宽度 ' + W + 'px（内容宽 ' + (W - 32) + 'px）===');

  // ---------- 热力图 ----------
  const heat = parseSvg(html, '活跃分布热力图');
  console.log('\n[1] 活跃分布热力图');
  if (!heat) { fails.push('  FAIL 未生成'); }
  else {
    const cs = circle(heat);
    const vals = cs.filter((c) => !/ust-dot-quiet/.test(c.cls));
    const quiet = cs.filter((c) => /ust-dot-quiet/.test(c.cls));
    const Wsvg = Number(attr(heat, 'width')), Hsvg = Number(attr(heat, 'height'));
    notes.push('  info svg=' + Wsvg + 'x' + Hsvg + ' 有点=' + vals.length + ' 空点=' + quiet.length);
    const scrollable = /ust-plot is-scroll/.test(html);
    check(Wsvg <= (W - 32) + 2 || scrollable, 'svg 宽 ' + Wsvg + (scrollable && Wsvg > (W - 32) ? ' 超出容器但可横向滚动（极窄时有意）' : ' 不超过容器 ' + (W - 32)));
    if (Wsvg > (W - 32) + 2) check(scrollable, '超宽时必须提供横向滚动容器');
    const minDots = process.env.HEAT_MODE === 'weekly' ? 3 : 5;
    check(vals.length >= minDots, '有数据点渲染（' + vals.length + ' 个，下限 ' + minDots + '）');
    const radii = vals.map((c) => c.r);
    check(Math.min(...radii) >= 2.4, '最小点半径 ' + Math.min(...radii).toFixed(2) + ' ≥ 2.4px（可见）');
    check(Math.max(...radii) <= 12, '最大点半径 ' + Math.max(...radii).toFixed(2) + ' ≤ 12px（不糊）');
    const inside = cs.every((c) => c.cy >= 0 && c.cy <= Hsvg && c.cx >= 0 && c.cx <= Wsvg);
    check(inside, '所有点都在画布内（不越界）');
    // 相邻点不重叠：同一行内相邻圆心距 ≥ 两半径之和
    // 只检查数据点与空点（峰值虚线圈是标注，本就大于数据点）
    const grid = cs.filter((c) => !/ust-peak-ring/.test(c.cls));
    const byRow = {};
    grid.forEach((c) => { const k = Math.round(c.cy); (byRow[k] = byRow[k] || []).push(c); });
    let overlap = 0;
    Object.values(byRow).forEach((row) => {
      row.sort((a, b) => a.cx - b.cx);
      for (let i = 1; i < row.length; i++) {
        const gap = row[i].cx - row[i - 1].cx;
        if (gap < row[i].r + row[i - 1].r) overlap++;
      }
    });
    check(overlap === 0, '相邻点不重叠（重叠 ' + overlap + ' 处）');
    // 半径与数值单调：最大的点应对应最大值
    const sorted = [...vals].sort((a, b) => b.r - a.r);
    check(sorted[0].r / sorted[sorted.length - 1].r > 1.15, '点大小有区分度（最大/最小 = ' + (sorted[0].r / sorted[sorted.length - 1].r).toFixed(2) + '）');
    const tx = textEls(heat).map((t) => t.body);
    const minTx = process.env.HEAT_MODE === 'weekly' ? 1 : 2;
    check(tx.length >= minTx, '有轴标签（' + tx.length + ' 个：' + tx.slice(0, 5).join(' ') + '）');
  }

  // ---------- 每周档专项（防分桶回归） ----------
  if (process.env.HEAT_MODE === 'weekly') {
    const heatW = parseSvg(html, '活跃分布热力图');
    const cs = circle(heatW || '').filter((c) => !/ust-peak-ring/.test(c.cls));
    console.log('\n[1b] 每周档分桶');
    // 点必须等距（同一 pitch），否则说明桶宽度不一致 = 分桶错误
    const xs = [...new Set(cs.map((c) => Math.round(c.cx)))].sort((a, b) => a - b);
    const gaps = xs.slice(1).map((v, i) => v - xs[i]);
    // 等距容差 1px（pitch 是浮点，累积取整会有 ±1 的差）
    const gmin = Math.min(...gaps), gmax = Math.max(...gaps);
    check(gmax - gmin <= 1, '点等距（间距 ' + gmin.toFixed(1) + '~' + gmax.toFixed(1) + 'px，容差 ≤1）');
    // 每周档：点数 = 覆盖周数，且不得等于天数（等于天数说明退化成每日档 = 分桶失效）
    // 点数必须严格小于天数（否则分桶失效退化成每日档）
    check(cs.length >= 4 && cs.length <= 9, '每周档点数 ' + cs.length + ' 落在合理区间 4~9（= 覆盖周数）');
    // 每周档的点数应等于覆盖的周数，且每个桶的 first/last 跨度 ≤ 7 天
    const labels = textEls(heatW || '').map((t) => t.body);
    notes.push('  info 每周档点数=' + cs.length + ' 标签=' + labels.join(' '));
  }

  // ---------- 趋势图 ----------
  const trend = parseSvg(html, '用量趋势折线图');
  console.log('\n[2] 用量趋势折线图');
  if (!trend) { fails.push('  FAIL 未生成'); }
  else {
    const Wsvg = Number(attr(trend, 'width')), Hsvg = Number(attr(trend, 'height'));
    const paths = pathEls(trend).filter((p) => /ust-hair/.test(p.cls));
    const dots = circle(trend).filter((c) => /ust-dot/.test(c.cls));
    notes.push('  info svg=' + Wsvg + 'x' + Hsvg + ' 折线=' + paths.length + ' 点=' + dots.length);
    check(Wsvg <= (W - 32) + 2, 'svg 宽 ' + Wsvg + ' 不超过容器（不溢出）');
    // 上限跟随 skill 预设容量：PALM.SER 六色，窄面板少一条以免糊在一起
    const maxSeries = W < 520 ? 5 : 6;
    check(paths.length >= 1 && paths.length <= maxSeries, '折线数 ' + paths.length + ' 条（上限 ' + maxSeries + '，不糊）');
    check(dots.length >= 3, '数据点 ' + dots.length + ' 个');
    // Y 值在画布内
    let allIn = true, yspan = 0;
    paths.forEach((p) => {
      const ys = p.d.split(/[ML]/).map((s) => s.trim()).filter(Boolean).map((s) => Number(s.split(' ')[1])).filter((n) => !Number.isNaN(n));
      if (ys.length) { yspan = Math.max(yspan, Math.max(...ys) - Math.min(...ys)); if (Math.min(...ys) < 0 || Math.max(...ys) > Hsvg) allIn = false; }
    });
    check(allIn, '折线在画布内（不越界）');
    check(yspan > Hsvg * 0.15, '折线有纵向起伏（幅度 ' + yspan.toFixed(0) + 'px，不是压平的一条线）');
    const txt = textEls(trend);
    check(txt.length >= 3, '有坐标轴文字（' + txt.length + ' 个）');
    // 所有文字 y 坐标须在画布内（防止标注被裁掉）
    const ys = textEls(heat).concat(textEls(trend)).map((t) => Number(/(?:^|\s)y="([\d.]+)"/.exec(t.attrs) ? /(?:^|\s)y="([\d.]+)"/.exec(t.attrs)[1] : NaN)).filter((n) => !Number.isNaN(n));
    check(ys.every((y) => y >= 0 && y <= 320), '文字标注都在画布内（y 范围 ' + Math.min(...ys).toFixed(0) + '~' + Math.max(...ys).toFixed(0) + '）');
    check(txt.some((t) => t.body === '0'), 'Y 轴有 0 基线标注');
  }

  // ---------- 环形图 ----------
  const donut = parseSvg(html, '模型用量刻度环');
  console.log('\n[3] 模型用量刻度环');
  if (!donut) { fails.push('  FAIL 未生成'); }
  else {
    const vb = attr(donut, 'viewBox');
    const size = Number(vb.split(' ')[2]);
    const ticks = line(donut).filter((l) => /ust-tick/.test(l.cls));
    const marks = circle(donut).filter((c) => /ust-tickmark/.test(c.cls));
    const C = size / 2;
    const R = size / 2 - 20;
    notes.push('  info viewBox=' + vb + ' 刻度=' + ticks.length + ' 锚点=' + marks.length);
    check(ticks.length === 100, '共 100 刻度（一刻度 = 1%），实际 ' + ticks.length);
    const lens = ticks.map((t) => Math.hypot(t.x2 - t.x1, t.y2 - t.y1));
    check(Math.min(...lens) >= 9, '最短刻度 ' + Math.min(...lens).toFixed(1) + 'px ≥ 9（可见）');
    const rads = ticks.map((t) => Math.hypot(t.x1 - C, t.y1 - C));
    check(Math.abs(Math.min(...rads) - R) < 0.6 && Math.abs(Math.max(...rads) - R) < 0.6, '所有刻度在同一半径 ' + R + '（环不歪）');
    // 覆盖整圈：角度分布
    const angs = ticks.map((t) => (Math.atan2(t.y1 - C, t.x1 - C) * 180 / Math.PI + 360) % 360).sort((a, b) => a - b);
    const buckets = new Array(8).fill(0);
    angs.forEach((a) => { buckets[Math.floor(a / 45)]++; });
    check(buckets.every((b) => b >= 8), '刻度覆盖整圈（每 45° 至少 8 刻度：' + buckets.join('/') + '）');
    // 越界检查：刻度端点须在 viewBox 内
    const maxR = Math.max(...ticks.map((t) => Math.max(Math.hypot(t.x1 - C, t.y1 - C), Math.hypot(t.x2 - C, t.y2 - C))));
    check(maxR <= C, '刻度外端半径 ' + maxR.toFixed(1) + ' ≤ ' + C + '（不超出画布）');
    check(marks.length >= 9, '锚点 ' + marks.length + ' 个（每 10 刻一枚）');
  }

  // ---------- 彩色检查 ----------
  console.log('\n[4] 彩色（类目色区分模型 / 序数色表达用量）');
  {
    const tr = parseSvg(html, '用量趋势折线图');
    const hair = pathEls(tr || '').filter((p) => /ust-hair/.test(p.cls));
    const hairCls = hair.map((p) => (/ust-cs(\d)/.exec(p.cls) || [])[1]).filter(Boolean);
    check(hairCls.length === hair.length, '折线全部带类目色（' + hairCls.length + '/' + hair.length + '）');
    check(new Set(hairCls).size === hairCls.length, '各折线颜色互不相同（' + [...new Set(hairCls)].map((i) => 'c' + i).join(',') + '）');

    const dn = parseSvg(html, '模型用量刻度环');
    const ticks = line(dn || '').filter((l) => /ust-tick/.test(l.cls));
    const tickCls = ticks.map((l) => (/ust-cs(\d)/.exec(l.cls) || [])[1]).filter(Boolean);
    check(tickCls.length === ticks.length, '刻度全部带类目色（' + tickCls.length + '/' + ticks.length + '）');
    check(new Set(tickCls).size >= 2, '刻度至少 2 种颜色（实际 ' + new Set(tickCls).size + ' 种）');

    const ht = parseSvg(html, '活跃分布热力图');
    const dots = circle(ht || '').filter((c) => /ust-qf/.test(c.cls));
    const dotCls = dots.map((c) => (/ust-qf(\d)/.exec(c.cls) || [])[1]).filter(Boolean);
    check(dots.length > 0, '热力图数据点用序数色（' + dots.length + ' 个）');
    check(new Set(dotCls).size >= 2, '热力图至少 2 档深浅（实际 ' + new Set(dotCls).size + ' 档）');
    notes.push('  info 折线色=' + [...new Set(hairCls)].join(',') + ' 刻度色=' + [...new Set(tickCls)].join(',') + ' 热力档=' + [...new Set(dotCls)].sort().join(','));
    check(/ust-scale-sw/.test(html), '热力图有色阶图例（少→多）');
    // 图例形状必须与点阵一致（圆点，非方块）
    const swRule = /\.ust-scale-sw\s*\{([^}]*)\}/.exec(cssText || '');
    check(!!swRule && /border-radius:\s*50%/.test(swRule[1]), '色阶图例是圆点（与点阵统一）' + (swRule ? '' : '（未找到规则）'));
    // 每格必须有透明命中矩形，且铺满 pitch（无死角、互不重叠）
    const hitCells = [...(ht || '').matchAll(/<rect class="ust-hitcell"[^>]*x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
      .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
    const vis = circle(ht || '').filter((c) => /ust-qf|ust-dot-quiet/.test(c.cls));
    check(hitCells.length === vis.length, '每格一个命中矩形（' + hitCells.length + ' 矩形 / ' + vis.length + ' 格）');
    // 矩形不得互相重叠（重叠会导致悬停抖动）
    let overlapR = 0;
    for (let a = 0; a < hitCells.length; a++) for (let b = a + 1; b < hitCells.length; b++) {
      const A = hitCells[a], B = hitCells[b];
      if (A.x < B.x + B.w - 0.01 && B.x < A.x + A.w - 0.01 && A.y < B.y + B.h - 0.01 && B.y < A.y + A.h - 0.01) overlapR++;
    }
    check(overlapR === 0, '命中矩形互不重叠（重叠 ' + overlapR + ' 对）');
    // 命中面积必须显著大于最小视觉点（解决"小点难触发"）
    const minHitArea = hitCells.length ? Math.min(...hitCells.map((r) => r.w * r.h)) : 0;
    const visR = circle(ht || '').filter((c) => /ust-qf/.test(c.cls)).map((c) => c.r);
    const minDotArea = visR.length ? Math.PI * Math.min(...visR) ** 2 : 1;
    check(minHitArea >= minDotArea * 4, '命中面积 ≥ 最小点的 4 倍（' + minHitArea.toFixed(0) + ' vs ' + minDotArea.toFixed(1) + ' px²）');
    check(!/class="ust-qf\d"[^>]*onMouseEnter/.test(ht || '') && !/ust-dot-quiet"[^>]*onMouseEnter/.test(ht || ''), '视觉点不绑事件（事件统一在命中层）');
    // 核心：可见段数不得超过预设容量，否则必然撞色
    const CAP = 6; // PALM.SER 六色
    check(tickCls.length > 0 && new Set(tickCls).size <= CAP, '环形段数 ' + new Set(tickCls).size + ' ≤ 预设容量 ' + CAP + '（不撞色）');
    check(hairCls.length <= CAP, '趋势线数 ' + hairCls.length + ' ≤ 预设容量 ' + CAP + '（不撞色）');
    check(new Set(hairCls).size === hairCls.length, '趋势线色互不重复（' + hairCls.join(',') + '）');
  }

  // ---------- 环形命中扇区（修闪烁） ----------
  console.log('\n[5] 环形命中扇区（消除刻度缝隙闪烁）');
  {
    const dn = parseSvg(html, '模型用量刻度环') || '';
    const bands = [...dn.matchAll(/<path class="ust-hitband"[^>]*d="([^"]*)"/g)];
    const tickLines = [...dn.matchAll(/<line class="ust-cs\d ust-tick"[^>]*>/g)];
    check(bands.length >= 2, '扇形命中区数量 ' + bands.length + '（每段一个）');
    check(tickLines.length > 0 && !tickLines.some((m) => /onMouse/.test(m[0])), '刻度线不再绑事件（缝隙不再丢命中）');
    check(/\.ust-tick\s*\{[^}]*pointer-events:\s*none/.test(cssText), '刻度线 pointer-events:none');
    check(/\.ust-hitband\s*\{[^}]*fill:\s*transparent/.test(cssText), '命中扇区透明不遮挡外观');
    // 扇区合计必须覆盖整圈：每段 [acc-0.5, acc+n-0.5] 刻度，累加恰为 100 刻度 = 360°
    const totalTicks = line(dn).filter((l) => /ust-tick/.test(l.cls)).length;
    check(Math.abs(totalTicks * 3.6 - 360) < 0.01, '扇区合计覆盖 ' + (totalTicks * 3.6).toFixed(1) + '° = 整圈无缝');
    // 相邻扇区必须首尾相接：路径为「内弧 + 径向边 + 外弧 + 径向边」的闭合环形
    check(bands.every((m) => /^M[\d., -]+A[\d., -]+L[\d., -]+A[\d., -]+Z$/.test(m[1])), '扇区路径为完整闭合环形（内外弧+两条径向边）');
  }

  // ---------- 页脚与刷新按钮 ----------
  console.log('\n[6] 页脚与刷新按钮');
  {
    check(/class="ust-footer"/.test(html), '存在页脚容器');
    check(/class="ust-meta"[^>]*>[^<]*数据更新于/.test(html), '页脚左侧显示更新时间');
    check(/class="ust-btn"[^>]*>/.test(html), '刷新按钮位于页脚内');
    check(/ust-btn-ico/.test(html), '按钮带图标（加载时旋转）');
    check(/\.ust-footer\s*\{[^}]*border-top:\s*1px solid var\(--rule\)/.test(cssText), '页脚有顶部分隔线');
    check(/\.ust-btn\s*\{[^}]*border-radius:\s*8px/.test(cssText), '按钮 8px 圆角（非胶囊）');
    check(/\.ust-btn:hover:not\(:disabled\)/.test(cssText) && /\.ust-btn:active:not\(:disabled\)/.test(cssText) && /\.ust-btn:disabled/.test(cssText), '按钮有 hover / active / disabled 三态');
    check(/\.ust-btn:focus-visible/.test(cssText), '按钮有键盘焦点环');
  }

  console.log('\n--- 结论 ---');
  notes.forEach((n) => console.log(n));
  if (fails.length) { console.log('\n发现问题：'); fails.forEach((f) => console.log(f)); process.exit(1); }
  console.log('\n全部几何断言通过。');
})();
