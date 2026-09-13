// dsh-usage-stats —— 使用统计(客户端)
// 排版：固定 px 字阶、WCAG 对比度达标、4 的倍数间距阶梯
// 图表：日历点阵 / 发丝折线 / 刻度环，配色与排版自研
// 关键：按实测容器宽度 1:1 出图，不做 viewBox 缩放（缩放会让小字号变成看不见）
window.__ModuleLoader__.load({
	id: "zcode-usage-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const element = react.createElement;

		const inject = ["slots"];

		// ---------- 格式化 ----------
		function fmtLarge(n) {
			n = Number(n) || 0;
			if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
			if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
			return String(Math.round(n));
		}
		function fmtFull(n) {
			return (Number(n) || 0).toLocaleString("zh-CN");
		}
		function fmtDuration(ms) {
			const totalMin = Math.floor((Number(ms) || 0) / 60000);
			if (totalMin <= 0) return "0 分";
			const d = Math.floor(totalMin / 1440);
			const h = Math.floor((totalMin % 1440) / 60);
			const m = totalMin % 60;
			if (d > 0) return d + " 天 " + h + " 时";
			if (h > 0) return h + " 时 " + m + " 分";
			return m + " 分";
		}
		function fmtClock(ms) {
			const n = Number(ms);
			if (!n) return "";
			const d = new Date(n);
			return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
		}
		function fmtDayLabel(dateStr) {
			const p = String(dateStr || "").split("-");
			if (p.length !== 3) return dateStr;
			return Number(p[1]) + " 月 " + Number(p[2]) + " 日";
		}
		function dateKey(d) {
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		}
		function addDays(key, n) {
			const p = key.split("-").map(Number);
			const d = new Date(p[0], p[1] - 1, p[2]);
			d.setDate(d.getDate() + n);
			return dateKey(d);
		}
		function rangeKeyOf(y, m, d) {
			return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
		}

		// ---------- 容器宽度实测：图表 1:1 出图，不缩放 ----------
		function useMeasure() {
			const ref = react.useRef(null);
			const [w, setW] = react.useState(0);
			react.useEffect(() => {
				const el = ref.current;
				if (!el) return;
				const read = () => {
					const next = Math.round(el.getBoundingClientRect().width);
					setW((cur) => (Math.abs(cur - next) >= 2 ? next : cur));
				};
				read();
				if (typeof ResizeObserver !== "undefined") {
					const ro = new ResizeObserver(read);
					ro.observe(el);
					return () => ro.disconnect();
				}
				window.addEventListener("resize", read);
				return () => window.removeEventListener("resize", read);
			}, []);
			return [ref, w];
		}

		// ---------- 颜色 ----------
		// 类目色（色相 = 模型身份）：用于趋势线、环形刻度、图例、模型列表
		// 色相只在 6 个之间循环，超出时颜色不重复承担识别——列表里始终带模型名
		const CATN = 6;
		const cF = (i) => "ust-cf" + (i % CATN);
		const cS = (i) => "ust-cs" + (i % CATN);
		const cB = (i) => "ust-cb" + (i % CATN);
		const cVar = (i) => "var(--c" + (i % CATN) + ")";
		// 序数色（明度 = 用量大小）：只用于热力图，单色相蓝阶
		// 档位：0 无用量（quiet）/ 2 少量 / 3 中等 / 4 最多
		const HEAT_LEVELS = 3;
		const qLevel = (v, max) => {
			if (!(v > 0) || !(max > 0)) return 0;
			const f = v / max;
			return f > 0.66 ? HEAT_LEVELS : f > 0.33 ? 2 : 1;
		};
		const qF = (lv) => "ust-qf" + lv;
		const qB = (lv) => "ust-qb" + lv;
		const rnd = (i, k) => Math.abs(((i * 73856093) ^ (k * 19349663)) % 1000) / 1000;

		// ---------- 时间范围 ----------
		const RANGES = [
			{ id: "today", label: "今天", build: (now) => [rangeKeyOf(now.getFullYear(), now.getMonth() + 1, now.getDate())] },
			{ id: "yesterday", label: "昨天", build: (now) => { const d = new Date(now); d.setDate(now.getDate() - 1); return [rangeKeyOf(d.getFullYear(), d.getMonth() + 1, d.getDate())]; } },
			{ id: "last7", label: "近 7 天", build: (now) => { const a = []; for (let i = 6; i >= 0; i--) { const d = new Date(now); d.setDate(now.getDate() - i); a.push(rangeKeyOf(d.getFullYear(), d.getMonth() + 1, d.getDate())); } return a; } },
			{ id: "last30", label: "近 30 天", build: (now) => { const a = []; for (let i = 29; i >= 0; i--) { const d = new Date(now); d.setDate(now.getDate() - i); a.push(rangeKeyOf(d.getFullYear(), d.getMonth() + 1, d.getDate())); } return a; } },
			{ id: "month", label: "本月", build: (now) => { const y = now.getFullYear(), m = now.getMonth() + 1; const last = new Date(y, m, 0).getDate(); const to = Math.min(last, now.getDate()); const a = []; for (let i = 1; i <= to; i++) a.push(rangeKeyOf(y, m, i)); return a; } },
			{ id: "prevMonth", label: "上月", build: (now) => { const p = new Date(now.getFullYear(), now.getMonth() - 1, 1); const y = p.getFullYear(), m = p.getMonth() + 1; const last = new Date(y, m, 0).getDate(); const a = []; for (let i = 1; i <= last; i++) a.push(rangeKeyOf(y, m, i)); return a; } },
			{ id: "all", label: "全部", build: () => [] },
		];

		function customKeys(from, to) {
			const a = [];
			if (!from || !to || from > to) return a;
			let k = from, guard = 0;
			while (k <= to && guard < 3660) { a.push(k); k = addDays(k, 1); guard++; }
			return a;
		}
		function resolveWindow(range, now = new Date()) {
			const r = typeof range === "string" ? { id: range } : (range || {});
			if (r.id === "custom") {
				const dateKeys = customKeys(r.from, r.to);
				return { id: "custom", label: r.from || r.to ? (r.from + " 至 " + r.to) : "自定义", dateKeys };
			}
			const def = RANGES.find((x) => x.id === r.id) || RANGES[3];
			return { id: def.id, label: def.label, dateKeys: def.build(now) };
		}
		function fillDays(days, wnd) {
			const map = new Map();
			(days || []).forEach((d) => map.set(d.date, d));
			return (wnd.dateKeys || []).map((k) => map.get(k) || { date: k, total: 0, turns: 0, byModel: [] });
		}

		// ---------- 图标（1.5 描边，随字色） ----------
		function icon(paths) {
			return element("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				paths.map((d, i) => element("path", { key: i, d })));
		}
		const IconToken = () => icon(["M12 2L2 7l10 5 10-5-10-5z", "M2 17l10 5 10-5", "M2 12l10 5 10-5"]);
		const IconBolt = () => icon(["M13 2L3 14h9l-1 8 10-12h-9l1-8z"]);
		const IconChat = () => icon(["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"]);
		const IconCalendar = () => icon(["M3 4h18v18H3z", "M16 2v4", "M8 2v4", "M3 10h18"]);
		const IconTrend = () => icon(["M23 6l-9.5 9.5-5-5L1 18", "M17 6h6v6"]);
		const IconMail = () => icon(["M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z", "M22 6l-10 7L2 6"]);
		const IconRefresh = () => icon(["M23 4v6h-6", "M1 20v-6h6", "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"]);

		const CSS = `/* ═══════════════════════════════════════════════════════════════
   使用统计 · 设置面板样式
   排版：固定字阶 / 对比度达标 / 间距阶梯（详见下）
     · 固定 px 字阶（产品界面不用 fluid type），1.125–1.2 级差
     · 正文对比度 ≥ 4.5:1，次要文字 ≥ 3:1
     · 行高：正文 1.5 / 标题 1.25 / 说明 1.4
     · 间距取自 4 的倍数阶梯：4 8 12 16 24 32
     · 数字统一 tabular-nums 对齐
   图表配色：类目色 = 模型身份（跨色相），序数色 = 用量深浅（单色相明度阶）
   容器宽度自适应：图表按实测宽度 1:1 出图，不做缩放
   ═══════════════════════════════════════════════════════════════ */

.ust-root {
	/* 浅色（默认） */
	--ink: #191918;
	--muted: #5F5E59;
	--faint: #86857F;
	--rule: #C4C3BC;
	--surface: #F7F6F3;
	--hover: #EDECE7;
	--l0: #191918; --l1: #3F3E3A; --l2: #5A5954;
	--l3: #78776F; --l4: #93928A; --l5: #A9A8A0;
	--quiet: #C4C3BC;
	--tip-bg: #191918; --tip-fg: #F7F6F3;
	/* 类目色：6 个跨色相，承载模型身份；两两色距 >=60 保证一眼可分 */
	--c0: #C62828; --c1: #C77800; --c2: #2F7D4F; --c3: #1D5FD0; --c4: #6D4AC4; --c5: #0E7C86;
	/* 序数色：单色相蓝阶，明度 = 用量大小（浅→深） */
	--q1: #9CBEE6; --q2: #5B8FD4; --q3: #2C6BC4; --q4: #123C74;

	display: flex; flex-direction: column; gap: 32px;
	padding: 0; color: var(--ink);
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
	font-size: 13px; line-height: 1.5;
	font-variant-numeric: tabular-nums;
	-webkit-font-smoothing: antialiased;
}
body[data-ds-dark-theme] .ust-root {
	--ink: #F2F1ED;
	--muted: #A5A49E;
	--faint: #74736E;
	--rule: #3B3A35;
	--surface: #24231F;
	--hover: #2C2B27;
	--l0: #F2F1ED; --l1: #D6D5CF; --l2: #B4B3AD;
	--l3: #8F8E88; --l4: #6A6963; --l5: #4A4944;
	--quiet: #35342F;
	--tip-bg: #F2F1ED; --tip-fg: #191918;
	/* 类目色（暗色主题）：同 6 色相提亮，暗底对比 >=3:1 */
	--c0: #FF6B6B; --c1: #FFA53D; --c2: #52C77A; --c3: #5B9DFF; --c4: #A78BFA; --c5: #2DD4BF;
	/* 序数色（暗色主题）：越亮 = 用量越大 */
	--q1: #2A4C7A; --q2: #3F6EA8; --q3: #5F97D4; --q4: #9CC4EE;
}
.ust-root *, .ust-root *::before, .ust-root *::after { box-sizing: border-box; }
.ust-root svg text { font-family: inherit; font-variant-numeric: tabular-nums; }

/* ── 排版层级 ────────────────────────────────────────────── */
.ust-page-title { margin: 0; font-size: 18px; font-weight: 700; line-height: 1.25; letter-spacing: -.01em; color: var(--ink); }
.ust-h2 { margin: 0; font-size: 15px; font-weight: 650; line-height: 1.3; letter-spacing: -.005em; color: var(--ink); }
.ust-sub { margin: 3px 0 0; font-size: 12px; line-height: 1.45; color: var(--muted); }
.ust-src { margin: 12px 0 0; font-size: 10px; font-weight: 600; line-height: 1.4; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }

/* ── 顶部：标题 + 时间范围 ───────────────────────────────── */
.ust-header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px 16px; }
.ust-rangebox { position: relative; }
.ust-tabs { display: flex; flex-wrap: wrap; gap: 2px 4px; }
.ust-tab {
	padding: 4px 9px; font-size: 12px; font-weight: 600; line-height: 1.4;
	color: var(--muted); border-radius: 6px; cursor: pointer;
	transition: background-color .15s ease, color .15s ease;
}
.ust-tab:hover { background: var(--hover); color: var(--ink); }
.ust-tab.active { background: var(--ink); color: var(--surface); }
body[data-ds-dark-theme] .ust-tab.active { background: var(--ink); color: #191918; }
.ust-tab:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }

/* ── 指标组 ─────────────────────────────────────────────── */
.ust-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 16px 20px; }
.ust-metric { border-top: 1px solid var(--rule); padding-top: 10px; min-width: 0; }
.ust-metric-label {
	display: flex; align-items: center; gap: 5px;
	font-size: 11px; font-weight: 600; line-height: 1.4; letter-spacing: .04em;
	color: var(--muted); text-transform: uppercase;
}
.ust-metric-label svg { width: 11px; height: 11px; flex: none; opacity: .85; }
.ust-metric-value { margin-top: 6px; font-size: 25px; font-weight: 700; line-height: 1.15; letter-spacing: -.02em; color: var(--ink); overflow-wrap: anywhere; }
.ust-metric-value.is-text { font-size: 15px; font-weight: 650; line-height: 1.35; letter-spacing: 0; overflow-wrap: anywhere; hyphens: auto; }
.ust-metric-sub { margin-top: 4px; font-size: 12px; line-height: 1.4; color: var(--muted); }

/* ── 图表区块 ───────────────────────────────────────────── */
.ust-block { display: flex; flex-direction: column; }
.ust-block-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 16px; margin-bottom: 14px; }
.ust-block-head .ust-tabs { gap: 2px; }

/* 图表容器：等实测宽度后 1:1 出图 */
.ust-plot { width: 100%; }
.ust-plot svg { display: block; width: 100%; height: auto; }
.ust-plot.is-scroll { overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; scrollbar-color: var(--rule) transparent; cursor: pointer; }
.ust-plot.is-scroll svg { width: auto; max-width: none; }
.ust-plot.is-scroll::-webkit-scrollbar { height: 6px; }
.ust-plot.is-scroll::-webkit-scrollbar-track { background: transparent; }
.ust-plot.is-scroll::-webkit-scrollbar-thumb { background: var(--rule); border-radius: 3px; }
.ust-plot.is-scroll::-webkit-scrollbar-thumb:hover { background: var(--faint); }

/* ── 图表内的图形语法 ───────────────────────────────────── */
.ust-hitcell { fill: transparent; cursor: pointer; }
.ust-hitband { fill: transparent; cursor: pointer; }
.ust-axis { font-size: 11px; font-weight: 500; fill: var(--muted); }
.ust-axis-strong { font-size: 11px; font-weight: 650; fill: var(--ink); }
.ust-grid { stroke: var(--rule); stroke-width: 1; }
.ust-baseline { stroke: var(--faint); stroke-width: 1; }
.ust-floor-tick { stroke: var(--rule); stroke-width: 1; }
.ust-hair { fill: none; stroke-width: 2.7; stroke-linejoin: round; stroke-linecap: round; }
.ust-dot { stroke: none; }
.ust-dot-quiet { fill: var(--quiet); }
.ust-cursor { stroke: var(--faint); stroke-width: 1; stroke-dasharray: 3 3; pointer-events: none; }
.ust-hit { fill: transparent; cursor: crosshair; }
.ust-callout { font-size: 11px; font-weight: 700; fill: var(--ink); paint-order: stroke; stroke: var(--surface); stroke-width: 3px; }
.ust-peak-ring { fill: none; stroke: var(--ink); stroke-width: 1; stroke-dasharray: 2 3; }
.ust-tick { stroke-width: 3.6; stroke-linecap: round; pointer-events: none; }
.ust-tickmark { fill: var(--faint); }
.ust-caption { font-size: 10px; font-weight: 600; letter-spacing: .06em; fill: var(--faint); text-transform: uppercase; }

/* 类目色（模型身份）：填充 / 描边 / 圆点三套，色相区分模型 */
.ust-cf0 { fill: var(--c0); } .ust-cf1 { fill: var(--c1); } .ust-cf2 { fill: var(--c2); }
.ust-cf3 { fill: var(--c3); } .ust-cf4 { fill: var(--c4); } .ust-cf5 { fill: var(--c5); }
.ust-cs0 { stroke: var(--c0); } .ust-cs1 { stroke: var(--c1); } .ust-cs2 { stroke: var(--c2); }
.ust-cs3 { stroke: var(--c3); } .ust-cs4 { stroke: var(--c4); } .ust-cs5 { stroke: var(--c5); }
.ust-cb0 { background: var(--c0); } .ust-cb1 { background: var(--c1); } .ust-cb2 { background: var(--c2); }
.ust-cb3 { background: var(--c3); } .ust-cb4 { background: var(--c4); } .ust-cb5 { background: var(--c5); }

/* 序数色（用量深浅）：单色相，明度即数值 */
.ust-qf1 { fill: var(--q1); } .ust-qf2 { fill: var(--q2); } .ust-qf3 { fill: var(--q3); } .ust-qf4 { fill: var(--q4); }
.ust-qs1 { stroke: var(--q1); } .ust-qs2 { stroke: var(--q2); } .ust-qs3 { stroke: var(--q3); } .ust-qs4 { stroke: var(--q4); }
.ust-qb1 { background: var(--q1); } .ust-qb2 { background: var(--q2); } .ust-qb3 { background: var(--q3); } .ust-qb4 { background: var(--q4); }

/* 明度阶梯（明度即数据：最重要 = 对比度最高） */
.ust-f0 { fill: var(--l0); } .ust-f1 { fill: var(--l1); } .ust-f2 { fill: var(--l2); }
.ust-f3 { fill: var(--l3); } .ust-f4 { fill: var(--l4); } .ust-f5 { fill: var(--l5); }
.ust-s0 { stroke: var(--l0); } .ust-s1 { stroke: var(--l1); } .ust-s2 { stroke: var(--l2); }
.ust-s3 { stroke: var(--l3); } .ust-s4 { stroke: var(--l4); } .ust-s5 { stroke: var(--l5); }
.ust-b0 { background: var(--l0); } .ust-b1 { background: var(--l1); } .ust-b2 { background: var(--l2); }
.ust-b3 { background: var(--l3); } .ust-b4 { background: var(--l4); } .ust-b5 { background: var(--l5); }

/* ── 色阶图例（热力图：少 → 多） ───────────────────────── */
.ust-scale { display: flex; align-items: center; gap: 5px; margin-top: 6px; }
.ust-scale-lab { font-size: 11px; font-weight: 600; color: var(--muted); }
.ust-scale-sw { width: 9px; height: 9px; border-radius: 50%; }

/* ── 模型列表 ───────────────────────────────────────────── */
.ust-models { list-style: none; margin: 0; padding: 0; }
.ust-model {
	display: flex; align-items: center; justify-content: space-between; gap: 12px;
	padding: 9px 0; border-bottom: 1px solid var(--rule); cursor: default;
}
.ust-model:last-child { border-bottom: 0; }
.ust-model-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; font-weight: 600; color: var(--ink); }
.ust-model-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ust-model-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ust-model-val { flex: none; font-size: 13px; font-weight: 650; color: var(--ink); }
.ust-model-sub { flex: none; font-size: 12px; color: var(--muted); }
.ust-model-row { display: flex; align-items: baseline; gap: 10px; }

/* ── 图表下方的图例（可点击显隐） ───────────────────────── */
.ust-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 12px; }
.ust-legend-item {
	display: flex; align-items: center; gap: 7px;
	font-size: 12px; font-weight: 550; line-height: 1.5; color: var(--muted);
	cursor: pointer; transition: color .15s ease, opacity .15s ease;
}
.ust-legend-item:hover { color: var(--ink); }
.ust-legend-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }

/* ── 环形图 ─────────────────────────────────────────────── */
.ust-donut-wrap { display: flex; flex-direction: column; gap: 16px; }
.ust-donut { position: relative; width: 168px; height: 168px; margin: 4px auto 0; flex: none; }
.ust-donut svg { display: block; width: 100%; height: 100%; overflow: visible; }
.ust-donut-center {
	position: absolute; inset: 0; display: flex; flex-direction: column;
	align-items: center; justify-content: center; pointer-events: none;
}
.ust-donut-center .num { font-size: 22px; font-weight: 700; line-height: 1.1; letter-spacing: -.02em; color: var(--ink); }
.ust-donut-center .lab { margin-top: 2px; font-size: 10px; font-weight: 600; letter-spacing: .1em; color: var(--muted); }

/* ── 提示条 ─────────────────────────────────────────────── */
.ust-warn {
	padding: 10px 14px; font-size: 12px; line-height: 1.5; color: var(--ink);
	background: var(--surface); border: 1px solid var(--rule); border-radius: 8px;
}

/* ── 底部：页脚 + 按钮 ─────────────────────────────────── */
.ust-footer {
	display: flex; align-items: center; justify-content: space-between; gap: 16px;
	margin-top: 4px; padding-top: 16px; border-top: 1px solid var(--rule);
}
.ust-meta { font-size: 12px; line-height: 1.5; color: var(--muted); font-variant-numeric: tabular-nums; }
.ust-actions { display: flex; justify-content: flex-end; }
.ust-btn {
	display: inline-flex; align-items: center; gap: 7px;
	padding: 7px 14px; font-family: inherit; font-size: 12.5px; font-weight: 600; line-height: 1.4;
	letter-spacing: .01em; color: var(--ink);
	background: var(--surface); border: 1px solid var(--rule);
	border-radius: 8px; cursor: pointer;
	transition: background-color .15s ease, border-color .15s ease, color .15s ease;
}
.ust-btn:hover:not(:disabled) { background: var(--hover); border-color: var(--faint); }
.ust-btn:active:not(:disabled) { background: var(--rule); }
.ust-btn:disabled { opacity: .55; cursor: progress; }
.ust-btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.ust-btn--primary { background: var(--ink); border-color: var(--ink); color: var(--surface); }
body[data-ds-dark-theme] .ust-btn--primary { color: #191918; }
.ust-btn--primary:hover:not(:disabled) { background: var(--ink); border-color: var(--faint); }
.ust-btn--ghost { background: transparent; border-color: transparent; color: var(--muted); }
.ust-btn--ghost:hover:not(:disabled) { background: var(--hover); border-color: var(--rule); color: var(--ink); }
.ust-btn-ico { display: inline-flex; width: 13px; height: 13px; }
.ust-btn-ico svg { width: 13px; height: 13px; }
.ust-btn-ico.is-spin { animation: ustSpin 900ms linear infinite; }
@keyframes ustSpin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ust-btn-ico.is-spin { animation: none; } }

/* ── 自定义区间面板 ─────────────────────────────────────── */
.ust-custom {
	position: absolute; top: calc(100% + 8px); right: 0; z-index: 60;
	display: flex; flex-direction: column; gap: 10px;
	min-width: 272px; padding: 14px;
	background: var(--surface); border: 1px solid var(--rule); border-radius: 12px;
}
.ust-custom-row { display: flex; align-items: center; gap: 8px; }
.ust-custom-sep { font-size: 12px; color: var(--muted); }
.ust-custom-actions { display: flex; justify-content: flex-end; gap: 8px; }
.ust-date {
	flex: 1; min-width: 0; padding: 6px 10px;
	font-family: inherit; font-size: 12px; color: var(--ink);
	background: transparent; border: 1px solid var(--rule); border-radius: 8px;
}
.ust-date:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; border-color: transparent; }
.ust-date::-webkit-calendar-picker-indicator { filter: none; opacity: .6; cursor: pointer; }
body[data-ds-dark-theme] .ust-date::-webkit-calendar-picker-indicator { filter: invert(1); opacity: .7; }

/* ── 浮动提示 ───────────────────────────────────────────── */
.ust-tip {
	position: fixed; z-index: 10000; pointer-events: none;
	max-width: 260px; padding: 9px 12px;
	font-size: 12px; line-height: 1.45;
	color: var(--tip-fg); background: var(--tip-bg);
	border-radius: 8px;
}
.ust-tip-title { font-weight: 700; }
.ust-tip-body { margin-top: 2px; opacity: .75; }
.ust-tip-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 5px; }
.ust-tip-row:first-of-type { margin-top: 7px; }
.ust-tip-key { display: flex; align-items: center; gap: 7px; min-width: 0; }
.ust-tip-key span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ust-tip-swatch { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ust-tip-val { flex: none; opacity: .75; }

/* ── 载入 / 空态 ────────────────────────────────────────── */
.ust-placeholder { padding: 32px 0; font-size: 13px; line-height: 1.5; color: var(--muted); text-align: center; }
.ust-skeleton {
	height: 12px; margin-top: 10px; border-radius: 6px;
	background: var(--hover); animation: ustPulse 1.4s ease-in-out infinite;
}
@keyframes ustPulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }

/* ── 动画（150–250ms，只表达状态，不做装饰） ────────────── */
.ust-fade { animation: ustFade .24s ease-out both; }
@keyframes ustFade { from { opacity: 0; } }
.ust-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: ustDraw .5s ease-out both; }
@keyframes ustDraw { to { stroke-dashoffset: 0; } }
.ust-pop { transform-box: fill-box; transform-origin: center; animation: ustPop .22s ease-out both; }
@keyframes ustPop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
	.ust-fade, .ust-draw, .ust-pop, .ust-skeleton { animation: none; }
	.ust-draw { stroke-dasharray: none; stroke-dashoffset: 0; }
}
`;

		// ---------- 数据辅助 ----------
		const totalOf = (d) => (d ? d.total : 0);
		const turnsOf = (d) => (d ? d.turns : 0);
		function calcStats(days, wnd) {
			const list = fillDays(days, wnd);
			const total = list.reduce((s, d) => s + totalOf(d), 0);
			const turns = list.reduce((s, d) => s + turnsOf(d), 0);
			const activeDays = list.filter((d) => totalOf(d) > 0).length;
			return { total, turns, activeDays };
		}
		// 尾部模型并入「其他」：颜色才能落在阶梯上，且图例不爆
		function foldModels(list, n = 4) {
			const sorted = [...list].sort((a, b) => b.total - a.total);
			if (sorted.length <= n + 1) return sorted.map((m, i) => ({ ...m, rank: i }));
			const head = sorted.slice(0, n).map((m, i) => ({ ...m, rank: i }));
			const tail = sorted.slice(n);
			head.push({
				model: "其他 " + tail.length + " 个模型",
				total: tail.reduce((s, m) => s + m.total, 0),
				children: tail,
				rank: n,
			});
			return head;
		}
		function modelTotalsIn(days, wnd) {
			const m = new Map();
			fillDays(days, wnd).forEach((d) => (d.byModel || []).forEach((x) => m.set(x.model, (m.get(x.model) || 0) + x.total)));
			return [...m.entries()].map(([model, total]) => ({ model, total }));
		}

		// ---------- 指标 ----------
		function Metric({ icon, label, value, sub, text }) {
			return element("div", { className: "ust-metric" },
				element("div", { className: "ust-metric-label" }, icon, element("span", null, label)),
				element("div", { className: "ust-metric-value" + (text ? " is-text" : "") }, value),
				sub ? element("div", { className: "ust-metric-sub" }, sub) : null,
			);
		}

		function SummaryMetrics({ summary }) {
			const s = summary || {};
			return element("div", { className: "ust-metrics" },
				element(Metric, { icon: element(IconToken), label: "累计 Token", value: fmtLarge(s.totalTokens), sub: fmtFull(s.totalTokens || 0) }),
				element(Metric, { icon: element(IconBolt), label: "单日峰值", value: fmtLarge(s.peakDayTokens), sub: "历史最高一天" }),
				element(Metric, { icon: element(IconChat), label: "最长会话", value: fmtDuration(s.longestSessionMs), sub: "单个会话持续最久", text: true }),
				element(Metric, { icon: element(IconCalendar), label: "当前连续", value: String(s.currentStreak || 0) + " 天", sub: "有用量的连续天" }),
				element(Metric, { icon: element(IconTrend), label: "最长连续", value: String(s.longestStreak || 0) + " 天", sub: "历史最长连续" }),
			);
		}

		// ---------- 提示框（跟随鼠标，边界内翻转） ----------
		function useTip() {
			const [tip, setTip] = react.useState(null);
			const place = (e, node) => {
				const W = 260, H = 150;
				let x = e.clientX + 14, y = e.clientY + 14;
				if (x + W > window.innerWidth) x = e.clientX - W - 14;
				if (y + H > window.innerHeight) y = e.clientY - H - 14;
				if (x < 8) x = 8;
				if (y < 8) y = 8;
				setTip({ node, x, y });
			};
			const clear = () => setTip(null);
			const el = tip ? element("div", { className: "ust-tip", style: { left: tip.x + "px", top: tip.y + "px" } }, tip.node) : null;
			return [place, clear, el];
		}

		// ---------- 1) 活跃分布 ----------
		// 日历点阵：一格一天，点面积 = 当天用量（sqrt 换算，面积才与数值成正比）
		const HEAT_MODES = [
			{ id: "daily", label: "每日" },
			{ id: "weekly", label: "每周" },
			{ id: "cumulative", label: "累计" },
		];
		const WD = ["日", "一", "二", "三", "四", "五", "六"];

		function Heatmap({ days, window: wnd }) {
			const [mode, setMode] = react.useState("daily");
			const [boxRef, boxW] = useMeasure();
			const [placeTip, clearTip, tipEl] = useTip();
			const scrollRef = react.useRef(null);

			// 视窗：数据首日到今天，最少 30 天，最多 365 天
			const model = react.useMemo(() => {
				const map = new Map();
				(days || []).forEach((d) => map.set(d.date, d));
				const today = new Date();
				today.setHours(0, 0, 0, 0);
				let start = new Date(today);
				start.setDate(start.getDate() - 29);
				const keys = ((wnd && wnd.dateKeys) || []).filter(Boolean).sort();
				if (keys.length) {
					const first = new Date(keys[0] + "T00:00:00");
					if (!Number.isNaN(first.getTime()) && first < start) start = first;
				}
				const floorDate = new Date(today);
				floorDate.setDate(floorDate.getDate() - 364);
				if (start < floorDate) start = floorDate;
				// 首列对齐周日
				const gridStart = new Date(start);
				gridStart.setDate(gridStart.getDate() - gridStart.getDay());

				const cumMap = new Map();
				let cum = 0;
				(days || []).forEach((d) => { cum += totalOf(d); cumMap.set(d.date, cum); });

				const cells = [];
				const weeks = new Map();
				let maxDay = 0, maxCum = 0, peak = null;
				for (let cur = new Date(gridStart); cur <= today; cur.setDate(cur.getDate() + 1)) {
					const key = dateKey(cur);
					const day = map.get(key);
					const total = totalOf(day);
					if (cumMap.has(key)) cum = cumMap.get(key);
					const col = Math.round((cur - gridStart) / 86400000 / 7);
					const cell = { key, col, row: cur.getDay(), total, cum, turns: turnsOf(day), month: cur.getMonth() + 1, dom: cur.getDate(), idx: cells.length };
					cells.push(cell);
					if (total > maxDay) { maxDay = total; peak = cell; }
					if (cum > maxCum) maxCum = cum;
					// 每周档：同一「周列」(col 相同) 即同一周，按列号分桶
					const wk = col;
					let bucket = weeks.get(wk);
					if (!bucket) { bucket = { col, total: 0, first: key, last: key }; weeks.set(wk, bucket); }
					bucket.total += total;
					bucket.last = key;
					if (cur.getDate() === 1) bucket.mark = cur.getMonth() + 1;
				}
				const weekCells = [...weeks.values()];
				let maxWeek = 0;
				weekCells.forEach((w) => { if (w.total > maxWeek) maxWeek = w.total; });
				const cols = Math.max(1, ...cells.map((c) => c.col + 1), ...weekCells.map((w) => w.col + 1));
				return { cells, cols, maxDay, maxCum, weekCells, maxWeek, peak, today };
			}, [days, wnd]);

			const isWeekly = mode === "weekly";
			const isCum = mode === "cumulative";
			const maxVal = isCum ? model.maxCum : model.maxDay;
			const maxWk = model.maxWeek;

			// 窗口 ≤ 70 天：单行点阵（窄面板里最省空间、点最大）；
			// 更长：7 行日历（列 = 周，行 = 星期），列多时横向滚动。
			const singleRow = !isWeekly && model.cells.length <= 70;
			const rows = (isWeekly || singleRow) ? 1 : 7;
			const nCols = isWeekly ? model.weekCells.length : (singleRow ? model.cells.length : model.cols);
			const PAD_L = rows === 1 ? 6 : 26, PAD_T = 26, PAD_B = 30;
			const avail = Math.max(180, boxW - PAD_L - 6);
			const cap = rows === 1 ? 26 : 17;
			const floor = rows === 1 ? 9 : 11; // 单行档可压到 9px，优先一屏放下
			const pitch = Math.max(floor, Math.min(cap, avail / Math.max(1, nCols)));
			const gridW = nCols * pitch;
			const W = Math.max(boxW, PAD_L + gridW + 6);
			const H = PAD_T + rows * pitch + PAD_B;
			const scrolls = W > boxW + 2;
			// 单行档：点按序号排；7 行档：点按周列 × 星期行
			const colOf = (c) => (isWeekly ? c.col : (singleRow ? c.idx : c.col));
			const rowOf = (c) => (isWeekly || singleRow ? 0 : c.row);

			react.useEffect(() => {
				const el = scrollRef.current;
				if (el && scrolls) requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; });
			}, [mode, scrolls, model]);

			// 交互命中格：每格一个透明矩形铺满 pitch×pitch。
			// 圆点半径受 pitch 限制做不到 ≥7px 又不互相重叠，矩形可无缝铺满 = 无死角、零重叠
			const hitCell = (col, row, key, title, body) => element("rect", {
				key, className: "ust-hitcell",
				x: PAD_L + col * pitch, y: PAD_T + row * pitch, width: pitch, height: pitch,
				onMouseEnter: (e) => placeTip(e, element("div", null,
					element("div", { className: "ust-tip-title" }, title),
					element("div", { className: "ust-tip-body" }, body),
				)),
				onMouseLeave: clearTip,
			});
			// 半径上限 = 间距的 42%：相邻点直径不超过间距，永不重叠
			const rMax = pitch * 0.42;
			const rOf = (v, max) => (v > 0 && max > 0 ? Math.max(Math.min(2.4, rMax), Math.sqrt(v / max) * rMax) : 0);
			const cx = (col) => PAD_L + col * pitch + pitch / 2;
			const cy = (row) => PAD_T + row * pitch + pitch / 2;

			const marks = [];
			if (isWeekly) {
				model.weekCells.forEach((w, i) => {
					const x = cx(i), y = cy(0);
					const title = fmtDayLabel(w.first) + " 至 " + fmtDayLabel(w.last);
					if (!(w.total > 0)) {
						marks.push(element("circle", { key: "q" + i, className: "ust-dot-quiet", cx: x, cy: y, r: 1.4 }));
					} else {
						marks.push(element("circle", { key: "w" + i, className: qF(qLevel(w.total, maxWk)), cx: x, cy: y, r: rOf(w.total, maxWk) }));
					}
					marks.push(hitCell(i, 0, "h" + i, title, w.total > 0 ? fmtFull(w.total) + " tokens" : "当周无用量"));
					// 日期标签放在点带下方，不与点重叠
					if (i % 4 === 0) marks.push(element("text", { key: "wl" + i, className: "ust-axis", x: x, y: cy(0) + rMax + 13, textAnchor: "middle" }, fmtDayLabel(w.first).replace(" ", "")));
				});
			} else {
				model.cells.forEach((c, i) => {
					const x = cx(colOf(c)), y = cy(rowOf(c));
					const v = isCum ? c.cum : c.total;
					if (v > 0) {
						marks.push(element("circle", { key: "d" + i, className: qF(qLevel(v, maxVal)), cx: x, cy: y, r: rOf(v, maxVal) }));
					} else {
						marks.push(element("circle", { key: "q" + i, className: "ust-dot-quiet", cx: x, cy: y, r: 1.4 }));
					}
					// 视觉点不绑事件，交互统一交给命中格
					const body = isCum
						? "累计 " + fmtFull(c.cum) + " tokens"
						: (v > 0 ? fmtFull(c.total) + " tokens · " + c.turns + " 轮" : "当日无用量");
					marks.push(hitCell(colOf(c), rowOf(c), "h" + i, fmtDayLabel(c.key), body));
				});
			}

			// 星期轴（周日在上）
			const wdAxis = (isWeekly || singleRow) ? null : WD.map((lab, k) =>
				k % 2 === 0 ? element("text", { key: "wd" + k, className: "ust-axis", x: PAD_L - 8, y: cy(k) + 4, textAnchor: "end" }, lab) : null);

			// 月份标（该列含 1 号）
			const marks2 = (isWeekly ? model.weekCells : model.cells)
				.filter((c) => (isWeekly ? c.mark : (singleRow ? (c.dom === 1 || c.idx % 5 === 0) : c.dom === 1)))
				.map((c, i) => {
					const x = cx(isWeekly ? c.col : (singleRow ? c.idx : c.col));
					return element("g", { key: "m" + i },
						element("text", { className: "ust-axis", x: x, y: PAD_T - 9, textAnchor: "middle" }, singleRow ? (c.dom === 1 ? c.month + "月" : c.dom + "日") : (c.mark || c.month) + "月"),
						element("line", { className: "ust-floor-tick", x1: x, y1: PAD_T - 5, x2: x, y2: PAD_T - 2 }),
					);
				});

			// 峰值标注（仅每日档，且不与月份标冲突）
			// 峰值标注：默认放点的下方（上方是日期轴）；贴底时改放上方
			const peakMark = (!isWeekly && !isCum && model.peak && model.peak.total > 0)
				? (() => {
					const x = cx(colOf(model.peak)), y = cy(rowOf(model.peak)), r = rOf(model.peak.total, maxVal);
					const below = y + r + 16 <= H - 4;
					const ty = below ? y + r + 13 : y - r - 8;
					return element("g", null,
						element("circle", { className: "ust-peak-ring", cx: x, cy: y, r: r + 4 }),
						element("text", {
							className: "ust-callout", x: x, y: ty,
							textAnchor: x > W - 60 ? "end" : x < 60 ? "start" : "middle",
						}, "峰值 " + fmtLarge(model.peak.total)),
					);
				})()
				: null;

			const caption = isWeekly
				? "一点 = 一周，点面积 = 当周 Token，小点 = 当周无用量"
				: isCum
					? "一点 = 一天，点面积 = 累计 Token，小点 = 当日无用量"
					: "一点 = 一天，点面积 = 当日 Token，小点 = 当日无用量";

			return element("div", { className: "ust-block" },
				element("div", { className: "ust-block-head" },
					element("div", null,
						element("h2", { className: "ust-h2" }, "活跃分布"),
						element("div", { className: "ust-sub" }, caption),
						element("div", { className: "ust-scale" },
							element("span", { className: "ust-scale-lab" }, "少"),
							element("span", { className: "ust-scale-sw ust-qb1" }),
							element("span", { className: "ust-scale-sw ust-qb2" }),
							element("span", { className: "ust-scale-sw ust-qb3" }),
							element("span", { className: "ust-scale-lab" }, "多"),
						),
					),
					element("div", { className: "ust-tabs", role: "tablist" },
						HEAT_MODES.map((m) => element("span", {
							key: m.id, role: "tab", "aria-selected": mode === m.id,
							className: "ust-tab" + (mode === m.id ? " active" : ""),
							onClick: () => setMode(m.id),
						}, m.label)),
					),
				),
				element("div", { ref: boxRef },
					element("div", { className: "ust-plot" + (scrolls ? " is-scroll" : ""), ref: scrollRef },
						boxW > 0 ? element("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "活跃分布热力图" },
							wdAxis, marks2, marks, peakMark,
						) : null,
					),
				),
				scrolls ? element("div", { className: "ust-src", style: { marginTop: 8 } }, "← 左右滑动查看完整时间轴") : null,
				tipEl,
			);
		}

		// ---------- 2) 用量趋势 ----------
		// 一条线 = 一个模型，圆点 = 当天用量，峰值直接标数
		function Trend({ days, window: wnd }) {
			const [boxRef, boxW] = useMeasure();
			const [hidden, setHidden] = react.useState({});
			const [hover, setHover] = react.useState(null);
			const [placeTip, clearTip, tipEl] = useTip();
			const scrollRef = react.useRef(null);

			const isHour = (wnd.dateKeys || []).length === 1;
			const singleDate = isHour ? wnd.dateKeys[0] : null;
			const dayList = fillDays(days, wnd);
			const singleDay = dayList[0] || null;
			const hourMap = new Map((isHour && singleDay && Array.isArray(singleDay.hours) ? singleDay.hours : []).map((h) => [h.hour, h]));
			const xData = isHour
				? Array.from({ length: 24 }, (_, h) => hourMap.get(h) || { hour: h, total: 0, byModel: [] })
				: dayList;
			const xLabel = (d) => (isHour ? String(d.hour).padStart(2, "0") + ":00" : fmtDayLabel(d.date));

			// 窄面板里线太多会糊成一团：按宽度决定显示几条
			const series = react.useMemo(() => foldModels(modelTotalsIn(days, wnd), (boxW || 400) < 520 ? 4 : 5), [days, wnd, boxW]);
			const values = react.useMemo(() => xData.map((d) => {
				const by = d.byModel || [];
				const vals = series.map((s) => {
					if (s.children) return s.children.reduce((acc, c) => acc + ((by.find((x) => x.model === c.model) || {}).total || 0), 0);
					return (by.find((x) => x.model === s.model) || {}).total || 0;
				});
				return { total: vals.reduce((a, b) => a + b, 0), vals };
			}), [xData, series]);

			const visible = series.map((s) => !hidden[s.model]);
			const visTotals = values.map((v) => v.vals.reduce((a, b, i) => a + (visible[i] ? b : 0), 0));
			const peakTotal = Math.max(1, ...visTotals);

			const N = xData.length || 1;
			// 极窄容器压缩左右留白，保证 svg 不超容器宽（避免横向溢出）
			const narrow = (boxW || 400) < 380;
			const PAD_L = narrow ? 30 : 40, PAD_R = narrow ? 6 : 10, PAD_T = 20, PAD_B = 34;
			const avail = Math.max(120, boxW - PAD_L - PAD_R);
			const step = N > 1 ? avail / (N - 1) : 0;
			// 单点太挤时横向滚动，保证点间距不小于 9px
			const minStep = isHour ? 14 : (narrow ? 7.5 : 9);
			const needScroll = step > 0 && step < minStep;
			let plotW = needScroll ? (N - 1) * minStep : avail;
			// 不滚动时必须严丝合缝落在容器内（避免 1–2px 溢出触发横向滚动条）
			if (!needScroll) plotW = Math.max(80, Math.min(plotW, (boxW || 400) - PAD_L - PAD_R));
			const W = PAD_L + plotW + PAD_R;
			const H = (boxW || 400) < 520 ? 168 : 200;
			const baseY = H - PAD_B;
			const topY = PAD_T;
			const x = (i) => PAD_L + (needScroll ? i * minStep : i * (plotW / Math.max(1, N - 1)));
			const y = (v) => baseY - (v / peakTotal) * (baseY - topY);

			// Y 轴：0 与峰值两档刻度，避免密集小字
			const grid = [
				element("line", { key: "g0", className: "ust-grid", x1: PAD_L, y1: topY, x2: PAD_L + plotW, y2: topY }),
				element("line", { key: "g1", className: "ust-baseline", x1: PAD_L, y1: baseY, x2: PAD_L + plotW, y2: baseY }),
				element("text", { key: "t0", className: "ust-axis", x: PAD_L - 7, y: topY + 4, textAnchor: "end" }, fmtLarge(peakTotal)),
				element("text", { key: "t1", className: "ust-axis", x: PAD_L - 7, y: baseY + 4, textAnchor: "end" }, "0"),
			];

			// X 轴标签：首、尾、中间均匀 3 个，共 5 个
			const labelEvery = narrow ? Math.max(1, Math.ceil(N / 3)) : Math.max(1, Math.ceil(N / 5));
			const labelIdx = N <= 1 ? [0] : (() => {
				const set = new Set([0, N - 1]);
				for (let i = labelEvery; i < N - 1; i += labelEvery) set.add(i);
				return [...set].sort((a, b) => a - b);
			})();
			const xAxis = labelIdx.map((i) => element("text", {
				key: "x" + i, className: "ust-axis", x: x(i), y: baseY + 20, textAnchor: i === 0 ? "start" : i === N - 1 ? "end" : "middle",
			}, xLabel(xData[i])));

			// 峰值点
			let peakIdx = 0, peakVal = -1;
			visTotals.forEach((v, i) => { if (v > peakVal) { peakVal = v; peakIdx = i; } });

			const lines = series.map((s, k) => {
				if (!visible[k]) return null;
				const pts = values.map((v, i) => x(i) + " " + y(v.vals[k]));
				const dotR = (boxW || 400) < 520 ? 3 : 2.6;
				const dots = values.map((v, i) => (v.vals[k] > 0
					? element("circle", { key: "d" + i, className: cF(s.rank) + " ust-dot", cx: x(i), cy: y(v.vals[k]), r: dotR })
					: null));
				return element("g", { key: s.model },
					element("path", { className: cS(s.rank) + " ust-hair", d: "M" + pts.join(" L ") }),
					dots,
				);
			});

			// 峰值标注：优先放点下方（避开顶部 Y 轴刻度），贴底则放上方
			const peakMark = peakVal > 0 ? (() => {
				const py = y(peakVal);
				const below = py + 20 <= baseY - 2;
				return element("g", null,
					element("circle", { className: "ust-peak-ring", cx: x(peakIdx), cy: py, r: 6 }),
					element("text", {
						className: "ust-callout", x: x(peakIdx), y: below ? py + 20 : py - 11,
						textAnchor: peakIdx === 0 ? "start" : peakIdx === N - 1 ? "end" : "middle",
					}, fmtLarge(peakVal)),
				);
			})() : null;

			const onMove = (e) => {
				if (!boxW) return;
				const rect = e.currentTarget.getBoundingClientRect();
				const sc = scrollRef.current ? scrollRef.current.scrollLeft : 0;
				const local = e.clientX - rect.left + sc;
				const i = needScroll
					? Math.max(0, Math.min(N - 1, Math.round((local - PAD_L) / minStep)))
					: Math.max(0, Math.min(N - 1, Math.round(((local - PAD_L) / plotW) * (N - 1))));
				setHover(i);
				const rows = series.map((s, k) => visible[k]
					? element("div", { key: s.model, className: "ust-tip-row" },
						element("span", { className: "ust-tip-key" },
							element("span", { className: "ust-tip-swatch", style: { background: cVar(s.rank) } }),
							element("span", null, s.model)),
						element("span", { className: "ust-tip-val" }, fmtFull(values[i].vals[k])))
					: null);
				placeTip(e, element("div", null,
					element("div", { className: "ust-tip-title" }, (isHour ? fmtDayLabel(singleDate) + " " : "") + xLabel(xData[i])),
					element("div", { className: "ust-tip-body" }, fmtFull(visTotals[i]) + " tokens · " + fmtLarge(visTotals[i])),
					rows,
				));
			};

			return element("div", { className: "ust-block" },
				element("div", { className: "ust-block-head" },
					element("div", null,
						element("h2", { className: "ust-h2" }, isHour ? "按小时的用量分布" : "用量趋势"),
						element("div", { className: "ust-sub" }, "一条线 = 一个模型，圆点 = 当期用量，颜色 = 模型"),
					),
					element("div", { className: "ust-sub" }, wnd.label),
				),
				element("div", { ref: boxRef },
					element("div", { className: "ust-plot" + (needScroll ? " is-scroll" : ""), ref: scrollRef },
						boxW > 0 ? element("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "用量趋势折线图" },
							grid, xAxis, lines, peakMark,
							hover !== null && element("line", { className: "ust-cursor", x1: x(hover), y1: topY, x2: x(hover), y2: baseY }),
							element("rect", { className: "ust-hit", x: 0, y: 0, width: W, height: H, onMouseMove: onMove, onMouseLeave: () => { setHover(null); clearTip(); } }),
						) : null,
					),
				),
				element("div", { className: "ust-legend" },
					series.map((s) => element("span", {
						key: s.model,
						className: "ust-legend-item",
						style: { opacity: hidden[s.model] ? 0.4 : 1 },
						onClick: () => setHidden((h) => ({ ...h, [s.model]: !h[s.model] })),
						role: "button", tabIndex: 0,
					},
						element("span", { className: "ust-legend-dot " + cB(s.rank) }),
						element("span", null, s.model),
					)),
				),
				tipEl,
			);
		}

		// ---------- 3) 模型用量 ----------
		// 一刻度 = 1%，段内刻度同色，段名与数值由下方列表承担（窄容器不放外圈标签）
		function Donut({ days, window: wnd }) {
			const [boxRef, boxW] = useMeasure();
			const [active, setActive] = react.useState(null);
			const [placeTip, clearTip, tipEl] = useTip();

			const list = modelTotalsIn(days, wnd);
			const sum = list.reduce((s, m) => s + m.total, 0);
			const segs = foldModels(list, 5);
			const TICKS = 100;
			let used = 0;
			const counts = segs.map((m) => {
				const t = sum > 0 ? Math.round((m.total / sum) * TICKS) : 0;
				used += t;
				return t;
			});
			if (sum > 0 && counts.length) counts[0] += TICKS - used;

			const SIZE = Math.max(140, Math.min(176, boxW || 168));
			const CX = SIZE / 2, CY = SIZE / 2;
			const R = SIZE / 2 - 20;
			const C = SIZE / 2;

			// 极坐标：0° 指向 12 点，顺时针
			const pol = (r, deg) => {
				const a = (deg - 90) * Math.PI / 180;
				return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
			};
			// 环形扇区：内外两段弧 + 两条径向边
			const annulus = (d0, d1, r0, r1) => {
				const [ax0, ay0] = pol(r0, d0), [ax1, ay1] = pol(r0, d1);
				const [bx1, by1] = pol(r1, d1), [bx0, by0] = pol(r1, d0);
				const big = d1 - d0 > 180 ? 1 : 0;
				return "M" + ax0 + " " + ay0 + " A" + r0 + " " + r0 + " 0 " + big + " 1 " + ax1 + " " + ay1 +
					" L" + bx1 + " " + by1 + " A" + r1 + " " + r1 + " 0 " + big + " 0 " + bx0 + " " + by0 + " Z";
			};
			const TIP_MAX = 15; // 刻度最长 9 + 6
			const ticks = [];
			const hitBands = [];
			let acc = 0;
			segs.forEach((s, si) => {
				const n = counts[si];
				for (let k = 0; k < n; k++) {
					const idx = acc + k;
					const a = (idx * 3.6 - 90) * Math.PI / 180;
					const len = 9 + rnd(idx + 1, si + 2) * 6;
					// 视觉刻度不绑事件：缝隙处会丢命中，统一交给下面的扇区
					ticks.push(element("line", {
						key: "t" + idx,
						className: cS(s.rank) + " ust-tick",
						x1: CX + R * Math.cos(a), y1: CY + R * Math.sin(a),
						x2: CX + (R + len) * Math.cos(a), y2: CY + (R + len) * Math.sin(a),
					}));
					if (idx % 10 === 0) {
						ticks.push(element("circle", { key: "m" + idx, className: "ust-tickmark", cx: CX + (R - 6) * Math.cos(a), cy: CY + (R - 6) * Math.sin(a), r: 1.2 }));
					}
				}
				if (n > 0) {
					// 命中扇区：从本段第一刻中心到末刻中心，左右各扩半格 = 整圈无缝
					const tip = element("div", null,
						element("div", { className: "ust-tip-title" }, s.model),
						element("div", { className: "ust-tip-body" }, fmtFull(s.total) + " tokens · " + (sum > 0 ? (s.total / sum * 100).toFixed(1) : "0") + "%"),
						s.children ? element("div", { className: "ust-tip-body" }, "含 " + s.children.map((c) => c.model).join("、")) : null,
					);
					const show = (e) => { setActive(s.model); placeTip(e, tip); };
					hitBands.push(element("path", {
						key: "hb" + si, className: "ust-hitband",
						d: annulus((acc - 0.5) * 3.6, (acc + n - 0.5) * 3.6, R - 5, R + TIP_MAX + 6),
						onMouseEnter: show, onMouseMove: show,
						onMouseLeave: () => { setActive(null); clearTip(); },
					}));
				}
				acc += n;
			});

			return element("div", { className: "ust-block" },
				element("div", { className: "ust-block-head" },
					element("div", null,
						element("h2", { className: "ust-h2" }, "模型用量"),
						element("div", { className: "ust-sub" }, "一刻度 = 1%，每 10 刻一枚锚点，颜色 = 模型"),
					),
					element("div", { className: "ust-sub" }, wnd.label),
				),
				element("div", { ref: boxRef },
					element("div", { className: "ust-donut-wrap" },
						element("div", { className: "ust-donut", style: { width: SIZE + "px", height: SIZE + "px" } },
							element("svg", { viewBox: "0 0 " + SIZE + " " + SIZE, role: "img", "aria-label": "模型用量刻度环" }, ticks, hitBands),
							element("div", { className: "ust-donut-center" },
								element("div", { className: "num" }, fmtLarge(sum)),
								element("div", { className: "lab" }, "TOKENS"),
							),
						),
						element("ul", { className: "ust-models" },
							segs.map((s) => element("li", {
								key: s.model,
								className: "ust-model",
								style: { opacity: active && active !== s.model ? 0.45 : 1 },
								onMouseEnter: () => setActive(s.model),
								onMouseLeave: () => setActive(null),
							},
								element("span", { className: "ust-model-name" },
									element("span", { className: "ust-model-dot " + cB(s.rank) }),
									element("span", { title: s.children ? s.children.map((c) => c.model).join("、") : s.model }, s.model)),
								element("span", { className: "ust-model-row" },
									element("span", { className: "ust-model-sub" }, fmtLarge(s.total)),
									element("span", { className: "ust-model-val" }, (sum > 0 ? Math.round((s.total / sum) * 100) : 0) + "%")),
							)),
						),
					),
				),
				tipEl,
			);
		}

		// ---------- 主视图 ----------
		function UsageStatsView() {
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [loading, setLoading] = react.useState(true);
			const [range, setRange] = react.useState({ id: "last30" });
			const [showCustom, setShowCustom] = react.useState(false);
			const [from, setFrom] = react.useState("");
			const [to, setTo] = react.useState("");

			const load = react.useCallback(async (force) => {
				setLoading(true);
				try {
					const res = await fetch("/api/usage-stats" + (force ? "?refresh=1" : ""), { credentials: "same-origin" });
					if (!res.ok) throw new Error("HTTP " + res.status);
					const json = await res.json();
					if (!json || json.ok === false) throw new Error((json && json.error) || "响应异常");
					setData(json);
					setError(null);
				} catch (e) {
					setError(String((e && e.message) || e));
				}
				setLoading(false);
			}, []);

			react.useEffect(() => { load(false); }, [load]);

			const days = (data && data.days) || [];
			const hasData = days.length > 0;
			const wnd = react.useMemo(() => {
				if ((typeof range === "string" ? range : range.id) === "all") {
					return { id: "all", label: "全部", dateKeys: days.map((d) => d.date).sort() };
				}
				return resolveWindow(range);
			}, [range, days]);

			if (loading && !data) {
				return element("div", { className: "ust-root" },
					element("div", { className: "ust-skeleton", style: { width: "40%" } }),
					element("div", { className: "ust-skeleton", style: { width: "100%", height: 96 } }),
					element("div", { className: "ust-placeholder" }, "统计加载中"),
				);
			}
			if (error && !data) {
				return element("div", { className: "ust-root" },
					element("div", { className: "ust-warn" }, "加载失败：" + error),
					element("div", { className: "ust-actions", style: { marginTop: 16 } },
						element("button", { className: "ust-btn", onClick: () => load(true) }, "重试")),
				);
			}

			const stats = calcStats(days, wnd);
			const winList = modelTotalsIn(days, wnd);
			const winTop = winList.length ? [...winList].sort((a, b) => b.total - a.total)[0] : null;
			const topName = winTop ? winTop.model : ((data.topModel && data.topModel.name) || "无");
			const topSub = winTop && stats.total > 0
				? "占本窗口 " + Math.round((winTop.total / stats.total) * 100) + "%"
				: "";
			const avgPerActive = stats.activeDays > 0 ? stats.total / stats.activeDays : 0;
			const invalid = !!(from && to && from > to);

			return element("div", { className: "ust-root" },
				element(SummaryMetrics, { summary: data.summary }),
				element("div", { className: "ust-header" },
					element("h1", { className: "ust-page-title" }, "使用统计"),
					element("div", { className: "ust-rangebox" },
						element("div", { className: "ust-tabs", role: "tablist" },
							RANGES.map((r) => element("span", {
								key: r.id, role: "tab", "aria-selected": range.id === r.id,
								className: "ust-tab" + (range.id === r.id ? " active" : ""),
								onClick: () => { setRange({ id: r.id }); setShowCustom(false); },
							}, r.label)),
							element("span", {
								role: "tab", "aria-selected": range.id === "custom",
								className: "ust-tab" + (range.id === "custom" ? " active" : ""),
								onClick: () => setShowCustom((v) => !v),
							}, "自定义"),
						),
						showCustom ? element("div", { className: "ust-custom" },
							element("div", { className: "ust-custom-row" },
								element("input", { className: "ust-date", type: "date", value: from, max: to || undefined, "aria-label": "开始日期", onChange: (e) => setFrom(e.target.value) }),
								element("span", { className: "ust-custom-sep" }, "至"),
								element("input", { className: "ust-date", type: "date", value: to, min: from || undefined, "aria-label": "结束日期", onChange: (e) => setTo(e.target.value) }),
							),
							invalid ? element("div", { className: "ust-warn" }, "结束日期不能早于开始日期") : null,
							element("div", { className: "ust-custom-actions" },
								element("button", { className: "ust-btn ust-btn--ghost", onClick: () => { setShowCustom(false); setFrom(""); setTo(""); } }, "取消"),
								element("button", {
									className: "ust-btn ust-btn--primary",
									disabled: !(from && to) || invalid,
									onClick: () => { setRange({ id: "custom", from, to }); setShowCustom(false); },
								}, "应用"),
							),
						) : null,
					),
				),
				element("div", { className: "ust-metrics" },
					element(Metric, { icon: element(IconToken), label: "窗口 Token", value: fmtLarge(stats.total), sub: fmtFull(stats.total) }),
					element(Metric, { icon: element(IconCalendar), label: "活跃天数", value: String(stats.activeDays) + " 天", sub: "有用量的天" }),
					element(Metric, { icon: element(IconTrend), label: "日均", value: fmtLarge(avgPerActive), sub: "按活跃天平均" }),
					element(Metric, { icon: element(IconChat), label: "会话累计", value: fmtFull((data && data.sessionCount) || 0), sub: "全部历史" }),
					element(Metric, { icon: element(IconMail), label: "消息累计", value: fmtFull((data && data.messageCount) || 0), sub: "全部历史" }),
					element(Metric, { icon: element(IconBolt), label: "最常用模型", value: topName, sub: topSub, text: true }),
				),
				wnd.dateKeys.length === 0 ? element("div", { className: "ust-warn" }, "当前时间范围没有数据") : null,
				data.warnings && data.warnings.length > 0 ? element("div", { className: "ust-warn" }, data.warnings.join("；")) : null,
				hasData ? element(Heatmap, { days, window: wnd }) : null,
				hasData && wnd.dateKeys.length > 0 ? element(Trend, { days, window: wnd }) : null,
				hasData && wnd.dateKeys.length > 0 ? element(Donut, { days, window: wnd }) : null,
				element("div", { className: "ust-footer" },
					element("div", { className: "ust-meta" },
						loading ? "正在重新扫描全部会话…" : (data.generatedAt ? "数据更新于 " + fmtClock(data.generatedAt) : ""),
					),
					element("button", {
						className: "ust-btn", disabled: loading, onClick: () => load(true),
						title: "重新扫描本机全部会话记录",
					},
						element("span", { className: "ust-btn-ico" + (loading ? " is-spin" : "") }, element(IconRefresh)),
						loading ? "刷新中" : "刷新",
					),
				),
			);
		}

		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-usage-stats";
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => { style.remove(); };
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "usage-stats",
				order: 80,
				label: () => "使用统计",
				inject: () => ({}),
			}, UsageStatsView));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
