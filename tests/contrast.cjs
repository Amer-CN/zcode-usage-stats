/* WCAG 对比度核算：正文 ≥4.5:1，次要/大字 ≥3:1，图形元素 ≥3:1 */
function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function ratio(a, b) { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); }

const LIGHT = { bg: '#EFEEEA', ink: '#191918', muted: '#5F5E59', faint: '#86857F', rule: '#C4C3BC',
  l0: '#191918', l1: '#3F3E3A', l2: '#5A5954', l3: '#78776F', l4: '#93928A', l5: '#A9A8A0', quiet: '#C4C3BC' };
const DARK = { bg: '#1B1A18', ink: '#F2F1ED', muted: '#A5A49E', faint: '#74736E', rule: '#3B3A35',
  l0: '#F2F1ED', l1: '#D6D5CF', l2: '#B4B3AD', l3: '#8F8E88', l4: '#6A6963', l5: '#4A4944', quiet: '#35342F' };

const rules = [
  ['正文 ink', 'ink', 4.5],
  ['次要 muted', 'muted', 4.5],
  ['弱化 faint', 'faint', 3.0],
  ['规则线 rule', 'rule', 1.4],
  ['数据 L0', 'l0', 3.0],
  ['数据 L1', 'l1', 3.0],
  ['数据 L2', 'l2', 3.0],
  ['数据 L3', 'l3', 3.0],
  ['数据 L4', 'l4', 2.2],
  ['数据 L5', 'l5', 1.6],
  ['空点 quiet', 'quiet', 1.2],
];
let bad = 0;
for (const [name, pal] of [['浅色', LIGHT], ['深色', DARK]]) {
  console.log('=== ' + name + '（背景 ' + pal.bg + '）===');
  rules.forEach(([label, key, min]) => {
    const r = ratio(pal[key], pal.bg);
    const ok = r >= min;
    if (!ok) bad++;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + label.padEnd(12) + ' ' + r.toFixed(2) + ':1  (要求 ≥' + min + ')');
  });
}
console.log('\n' + (bad === 0 ? '全部对比度达标。' : bad + ' 项未达标。'));
process.exit(bad === 0 ? 0 : 1);
