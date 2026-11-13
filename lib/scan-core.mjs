// 会话日志解析核心（纯函数，不碰 fs）：宿主侧扫描与 worker 线程共用同一份实现。
//
// 冷扫描的主要开销是「解压 + 把每一行都 JSON.parse」。会话日志里大头是工具输出和
// 用户消息，而我们只要 4 类事件，所以在 JSON.parse 之前先按事件类型字面量做一次
// 子串过滤：命中才 parse。过滤依据是 JSON.stringify 输出的 `"type"` 值本身，
// 与冒号后的空格无关；误命中只会多 parse 一次，不会漏数据。
import { zstdDecompressSync } from "node:zlib";

// DSH 的会话 .zstd 是「每次追加一帧」的多帧拼接文件，Electron 自带的 zstd 解码
// 只解第一帧（Node 独立版能解多帧）。这里自己按帧头找边界，逐帧解压。
export const ZSTD_FRAME_MAGIC = 0xfd2fb528;
export const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
export const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

// 需要的事件类型（带引号的字面量，避免了 JSON 缩进/空格差异）
const WANTED_MARKERS = [
  '"assistant/message"',
  '"step/end"',
  '"request/context"',
  '"request/header"',
];

export function newSessionState() {
  return { m: 0, t: {}, u: {}, h: {}, last: 0, created: 0, ver: 0 };
}

// 把 UNIX 毫秒时间戳折叠成本地日期键 YYYY-MM-DD
export function dateKey(ms) {
  try {
    const d = new Date(ms);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  } catch {
    return null;
  }
}

// 本地小时 0-23
export function hourOf(ms) {
  try {
    return new Date(ms).getHours();
  } catch {
    return null;
  }
}

function ensureBucket(map, key) {
  let value = map[key];
  if (!value) value = map[key] = {};
  return value;
}

function bumpUsage(byModel, model, arr) {
  let metrics = byModel[model];
  if (!metrics) metrics = byModel[model] = [0, 0, 0, 0];
  metrics[0] += arr[0];
  metrics[1] += arr[1];
  metrics[2] += arr[2];
  metrics[3] += arr[3];
}

// 从 assistant/message 事件里识别模型：消息源优先（逐条准确），
// 其次事件自带 model，最后回退到最近一次 request/context 的模型。
function eventModel(ev, currentModel) {
  const source = ev.data?.message?.source;
  if (source && typeof source.model === "string" && source.model) return source.model;
  if (ev.data && typeof ev.data.model === "string" && ev.data.model) return ev.data.model;
  return currentModel || "other";
}

// 首行会话头：{"type":"session", version, id, createdAt, cwd...}
function parseHeaderLine(line, ctx, state) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    ctx.badLines += 1;
    return;
  }
  if (ev && typeof ev === "object" && ev.type === "session") {
    ctx.header = ev;
    state.created = typeof ev.createdAt === "number" ? ev.createdAt : 0;
    state.ver = Number.isFinite(ev.version) ? ev.version : 0;
  }
}

export function parseSessionLine(line, ctx, state) {
  if (!line) return;
  if (!ctx.header) {
    parseHeaderLine(line, ctx, state);
    return;
  }
  // 快速预过滤：绝大多数行（工具输出/用户消息/推理增量）在这里就被跳过
  let wanted = false;
  for (let i = 0; i < WANTED_MARKERS.length; i++) {
    if (line.includes(WANTED_MARKERS[i])) {
      wanted = true;
      break;
    }
  }
  if (!wanted) return;

  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    ctx.badLines += 1;
    return;
  }
  if (!ev || typeof ev !== "object") return;
  if (typeof ev.time === "number") state.last = ev.time;
  switch (ev.type) {
    case "request/context":
      if (typeof ev.data?.model === "string") ctx.currentModel = ev.data.model;
      break;
    case "request/header": {
      const model = ev.data?.header?.config?.model;
      if (typeof model === "string" && model) ctx.currentModel = model;
      break;
    }
    case "step/end": {
      // turns 官方口径:一个新 turn 记 1 次。以 step/end 为权威——每个 step 必然发出,
      // 覆盖 completed/failed/cancelled/max-tokens;而 assistant/message 会漏 cancelled。
      const turn = ev.data?.turn;
      if (typeof turn === "number" && turn !== ctx.lastTurn) {
        ctx.lastTurn = turn;
        const key = dateKey(ev.time);
        if (key) state.t[key] = (state.t[key] || 0) + 1;
      }
      break;
    }
    case "assistant/message": {
      state.m += 1;
      const usage = ev.data?.usage;
      if (!usage) break;
      const key = dateKey(ev.time);
      if (!key) break;
      const model = eventModel(ev, ctx.currentModel);
      ctx.currentModel = model;
      const hour = hourOf(ev.time);
      const arr = [
        Number(usage.inputTokens) || 0,
        Number(usage.outputTokens) || 0,
        Number(usage.cacheReadTokens) || 0,
        Number(usage.cacheWriteTokens) || 0,
      ];
      if (arr[0] + arr[1] + arr[2] + arr[3] === 0) break;
      bumpUsage(ensureBucket(state.u, key), model, arr);
      if (typeof hour === "number") {
        bumpUsage(ensureBucket(ensureBucket(state.h, key), hour), model, arr);
      }
      break;
    }
    default:
      break;
  }
}

// 按 zstd 帧头切出每帧的字节范围；末尾半帧（正在追加）与损坏尾部直接忽略。
export function zstdFrameRanges(buf) {
  const ranges = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const magic = buf.readUInt32LE(off);
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
      if (off + 8 > buf.length) break;
      const size = buf.readUInt32LE(off + 4);
      if (off + 8 + size > buf.length) break;
      off += 8 + size;
      continue;
    }
    if (magic !== ZSTD_FRAME_MAGIC) break;
    const start = off;
    let p = off + 4;
    try {
      if (p >= buf.length) break;
      const descriptor = buf[p++];
      const fcsFlag = descriptor >>> 6;
      const singleSegment = (descriptor >>> 5) & 1;
      const checksum = (descriptor >>> 2) & 1;
      const dictFlag = descriptor & 3;
      if (!singleSegment) p += 1; // 保留 window descriptor
      if (dictFlag === 1) p += 1;
      else if (dictFlag === 2) p += 2;
      else if (dictFlag === 3) p += 4;
      let fcsSize;
      if (fcsFlag === 0) fcsSize = singleSegment ? 1 : 0;
      else if (fcsFlag === 1) fcsSize = 2;
      else if (fcsFlag === 2) fcsSize = 4;
      else fcsSize = 8;
      p += fcsSize;
      while (true) {
        if (p + 3 > buf.length) throw new Error("zstd 块头截断");
        const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
        p += 3;
        const last = header & 1;
        const type = (header >>> 1) & 3;
        const size = header >>> 3;
        if (type === 0 || type === 2) p += size;
        else if (type === 1) p += 1;
        else throw new Error("zstd 保留块类型");
        if (last) break;
      }
      if (checksum) p += 4;
      if (p > buf.length) throw new Error("zstd 帧截断");
      ranges.push([start, p]);
      off = p;
    } catch {
      break; // 末尾半帧/损坏尾部：保留前面完整帧
    }
  }
  return ranges;
}

// 用最后一帧的文本补 session 结束时间：被过滤掉的行（工具结果等）不会更新
// state.last，这里对最后一帧的 "time": 做一次正则取最大值，成本可忽略。
function applyTailTime(text, state) {
  if (!text) return;
  const re = /"time":\s*(\d{10,})/g;
  let match;
  let max = 0;
  while ((match = re.exec(text)) !== null) {
    const value = Number(match[1]);
    if (value > max) max = value;
  }
  if (max > 0) state.last = max;
}

// 逐帧解压并把跨帧的行接起来，避免把整份解压结果 + 拼接副本同时留在内存
export function parseSessionBuffer(buf, ctx, state) {
  const ranges = zstdFrameRanges(buf);
  let carry = "";
  let lastText = "";
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    const text = zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    lastText = text;
    const lines = (carry + text).split("\n");
    carry = lines.pop() ?? "";
    for (let j = 0; j < lines.length; j++) parseSessionLine(lines[j], ctx, state);
  }
  if (carry) parseSessionLine(carry, ctx, state);
  applyTailTime(lastText, state);
}

// 明文会话日志（少量旧库或测试数据）
export function parseSessionText(text, ctx, state) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) parseSessionLine(lines[i], ctx, state);
  applyTailTime(text, state);
}