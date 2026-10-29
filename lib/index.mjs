// dsh-usage-stats —— 使用统计(宿主侧)
//
// 数据来源：直接读取 DSH 的会话日志（~/.dsh/sessions 下的
// session[.vN].jsonl[.zstd]），回放事件聚合 Token 用量：
//   - 按天聚合(趋势图 + 热力图素材)
//   - 按小时聚合到天(单日窗口"按小时"趋势图素材)
//   - 按模型聚合(仪表盘)
//   - 额外统计:会话数、消息数、活跃天数、当前连续天数、最常用模型
//
// 为什么不再走 sessionPersistence 全量 readFrom/open：
//   DSH 0.2.x 起会话日志默认 zstd 压缩，单库可达数百 MB；官方读取接口会逐事件
//   校验/快照，全量读取在 1400+ 会话时要数分钟，60s 超时只能拿到约 10% 的数据。
//   本条直接解析路径约 20s 完成一次全量冷扫描；之后按文件 size+mtime 做增量，
//   只重读追加过的会话，通常 <2s。
//
// 暴露 GET /api/usage-stats   (?refresh=1 强制重新扫描)
// 缓存：内存 + 磁盘（usage-stats-cache.json），扫描进度另存
//       usage-stats-state.json（按会话文件增量，重启后可续扫）。
import { readFile, writeFile, mkdir, rename, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { zstdDecompressSync } from "node:zlib";

// 注意：DSH 的会话 .zstd 是「每次追加一帧」的多帧拼接文件，而 Electron 44
// 自带的 zstd 解码只解第一帧（Node 独立版能解多帧）。这里自己按 zstd 帧头
// 找到每帧边界，逐帧解压，两种运行时都能拿到完整日志。
const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MASK = 0xfffffff0;
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

// connection:exact 路由优先于 /api prefix 的信任栅栏,必须自己过栅栏(见 handler)
export const inject = ["webServer", "connection"];

// 已知模型 → 固定颜色(与「使用统计子组件库」视觉一致);其余按名称散列取调色板
const MODEL_COLORS = {
  "GLM-5.2": "#3d91e7",
  "jiaorong-deepseek-v4-pro": "#41b87b",
  "glm-5.2": "#8c64ef",
  "deepseek-v4-flash": "#ff4d4f",
  "deepseek-v4-pro": "#faad14",
};
const FALLBACK_PALETTE = [
  "#4da6ff", "#50d682", "#a684ff", "#ff7a9e", "#f2b95b",
  "#5ad0ce", "#e07bd0", "#7ac04f", "#e28a5a", "#6d8ef2",
];

// 缓存/状态 schema：结构变化时递增，旧缓存自动失效并重建（避免读出旧口径数字）
const CACHE_SCHEMA = 3;
const STATE_SCHEMA = 3;
const CACHE_TTL = 60_000; // 60s 后触发后台刷新(SWR)
const READ_CONCURRENCY = 2; // 解压并发；整份解压后即释放，限制峰值内存
const SESSION_FILE_RE = /^session(?:\.[A-Za-z0-9_-]+)?\.jsonl(?:\.zstd)?$/;
const MAX_SESSION_DEPTH = 4;

function modelColor(model) {
  if (MODEL_COLORS[model]) return MODEL_COLORS[model];
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

// 把 UNIX 毫秒时间戳折叠成本地日期键 YYYY-MM-DD
function dateKey(ms) {
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
function hourOf(ms) {
  try {
    return new Date(ms).getHours();
  } catch {
    return null;
  }
}

// 连续活跃天数(活跃日 = 当天有 ≥1 条 usage 事件):当前连续 / 历史最长
function computeStreaks(activeKeys) {
  const sorted = [...activeKeys].sort();
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const key of sorted) {
    // 日期键 YYYY-MM-DD 按整日比较,相邻日恰好差 86400000ms
    const diff = prev === null ? -1 : Math.round((Date.parse(key) - Date.parse(prev)) / 86_400_000);
    run = diff === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = key;
  }
  let current = 0;
  if (sorted.length > 0 && activeKeys.has(dateKey(Date.now()))) {
    current = 1;
    const d = new Date();
    while (true) {
      d.setDate(d.getDate() - 1);
      if (activeKeys.has(dateKey(d.getTime()))) current += 1;
      else break;
    }
  }
  return { current, longest };
}

function emptyMetrics() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function metricsOf(arr) {
  const input = Number(arr?.[0]) || 0;
  const output = Number(arr?.[1]) || 0;
  const cacheRead = Number(arr?.[2]) || 0;
  const cacheWrite = Number(arr?.[3]) || 0;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function addMetrics(target, metrics) {
  target.input += metrics.input;
  target.output += metrics.output;
  target.cacheRead += metrics.cacheRead;
  target.cacheWrite += metrics.cacheWrite;
  target.total += metrics.total;
}

function addToMap(map, model, metrics) {
  let m = map.get(model);
  if (!m) {
    m = emptyMetrics();
    map.set(model, m);
  }
  addMetrics(m, metrics);
}

// DSH 数据根：显式 DSH_HOME > ~/.dsh（与 @deepseek-ai/dsh-home-paths 的默认一致）
function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim()) return env.trim();
  return join(homedir(), ".dsh");
}

// 测试/特殊部署可覆盖会话根；默认 <dshHome>/sessions
function sessionsRoot() {
  const env = process.env.USAGE_STATS_SESSIONS_ROOT;
  if (typeof env === "string" && env.trim()) return env.trim();
  return join(dshHome(), "sessions");
}

// 扫描超时：默认 120s；冷扫描实测 20s 左右，留足慢盘/大库余量
function scanTimeoutMs() {
  const n = Number(process.env.USAGE_STATS_SCAN_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
}

// 会话文件发现：sessions/<project>/<session-dir>/session[.vN].jsonl[.zstd]
async function listSessionFiles(root) {
  const files = [];
  const stack = [[root, 0]];
  while (stack.length > 0) {
    const [dir, depth] = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SESSION_DEPTH) stack.push([p, depth + 1]);
      } else if (entry.isFile() && SESSION_FILE_RE.test(entry.name)) {
        files.push(p);
      }
    }
  }
  return files;
}

function sessionFileVersion(file) {
  const m = /\.v(\d+)\.jsonl/.exec(basename(file));
  return m ? Number(m[1]) : 0;
}

// 同一会话目录可能同时留着迁移前的 v3 和迁移后的 v4（内容重叠）。
// 每个目录只保留版本最高的一份；同版本取更大的文件，避免重复计数。
async function dedupeSessionFiles(files) {
  const byDir = new Map();
  for (const file of files) {
    const dir = dirname(file);
    const version = sessionFileVersion(file);
    const prev = byDir.get(dir);
    if (!prev) {
      byDir.set(dir, { file, version });
      continue;
    }
    if (version > prev.version) {
      byDir.set(dir, { file, version });
      continue;
    }
    if (version < prev.version) continue;
    try {
      const [current, kept] = await Promise.all([stat(file), stat(prev.file)]);
      if (current.size > kept.size) byDir.set(dir, { file, version });
    } catch { /* 取不到大小就保留先遇到的一份 */ }
  }
  return [...byDir.values()].map((entry) => entry.file);
}

// 读取整份会话文本并逐帧解压（zstd 压缩或明文）
// 返回已完整解析的帧；末尾半帧（正在追加）直接忽略，下一次扫描会补上。
function zstdFrameRanges(buf) {
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
      if (!singleSegment) p += 1; // Window_Descriptor
      p += [0, 1, 2, 4, 8][dictFlag]; // Dictionary_ID
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

// 逐帧解压并把跨帧的行接起来，避免把整份 90MB 解压结果 + 拼接副本同时留在内存
function parseSessionBuffer(buf, ctx, state) {
  const ranges = zstdFrameRanges(buf);
  let carry = "";
  for (const [start, end] of ranges) {
    const text = zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    const lines = (carry + text).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) parseSessionLine(line, ctx, state);
  }
  if (carry) parseSessionLine(carry, ctx, state);
}

function newSessionState() {
  return { m: 0, t: {}, u: {}, h: {}, last: 0, created: 0, ver: 0 };
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

function parseSessionLine(line, ctx, state) {
  if (!line) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    ctx.badLines += 1;
    return;
  }
  if (!ev || typeof ev !== "object") return;
  if (!ctx.header) {
    // 首行：{"type":"session", version, id, createdAt, cwd...}
    if (ev.type === "session") {
      ctx.header = ev;
      state.created = typeof ev.createdAt === "number" ? ev.createdAt : 0;
      state.ver = Number.isFinite(ev.version) ? ev.version : 0;
    }
    return;
  }
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

// 读一个会话文件 → 可跨进程复用的聚合状态
async function readSessionState(file) {
  const state = newSessionState();
  const ctx = { header: null, currentModel: "other", lastTurn: null, badLines: 0 };
  const buf = await readFile(file);
  if (file.endsWith(".zstd")) {
    parseSessionBuffer(buf, ctx, state);
  } else {
    for (const line of buf.toString("utf8").split("\n")) parseSessionLine(line, ctx, state);
  }
  if (!ctx.header) throw new Error("缺少会话头");
  return state;
}

function fileRevision(info) {
  // size + mtime 足够判断“文件是否被追加/重写”；比哈希整份文件便宜得多
  return `${info.size}:${Math.floor(info.mtimeMs)}`;
}

function emptyScanState() {
  return { schema: STATE_SCHEMA, files: {} };
}

function isScanState(value) {
  return Boolean(value)
    && typeof value === "object"
    && value.schema === STATE_SCHEMA
    && value.files
    && typeof value.files === "object";
}

// 并发池
async function runPool(items, limit, worker) {
  let index = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }));
}

// 一次扫描：复用未变化会话，只重读新增/变化文件
async function scanSessions(state, warnings, hooks) {
  const startedAt = Date.now();
  const deadline = startedAt + scanTimeoutMs();
  const root = sessionsRoot();
  let files = [];
  try {
    files = await dedupeSessionFiles(await listSessionFiles(root));
  } catch (e) {
    warnings.push(`无法读取会话目录 ${root}：${e && e.message ? e.message : e}`);
    return { sessionCount: 0, timedOut: false, reused: 0, read: 0, failed: 0, elapsedMs: Date.now() - startedAt };
  }
  if (files.length === 0) {
    warnings.push(`会话目录为空：${root}`);
  }

  const fileSet = new Set(files);
  const failedExamples = [];
  let reused = 0;
  let read = 0;
  let failed = 0;
  let timedOut = false;
  let done = 0;
  const total = files.length;

  await runPool(files, READ_CONCURRENCY, async (file) => {
    if (Date.now() >= deadline) {
      timedOut = true;
      return;
    }
    let info;
    try {
      info = await stat(file);
    } catch {
      return; // 扫描期间被删除：稍后由清理逻辑移除
    }
    const rev = fileRevision(info);
    const prev = state.files[file];
    if (prev && prev.rev === rev) {
      reused += 1;
      done += 1;
      hooks.progress(done, total);
      return;
    }
    try {
      const parsed = await readSessionState(file);
      state.files[file] = { rev, ...parsed };
      read += 1;
    } catch {
      failed += 1;
      if (failedExamples.length < 5) failedExamples.push(basename(dirname(file)));
      // 读失败时保留旧贡献，避免统计突然掉数据；下次再试
      if (!prev) delete state.files[file];
    }
    done += 1;
    hooks.progress(done, total);
  });

  // 清理已不存在的会话文件（只删“确实不在本次文件清单”的条目）
  for (const key of Object.keys(state.files)) {
    if (!fileSet.has(key)) delete state.files[key];
  }

  if (timedOut) {
    warnings.push(`扫描超时：已处理 ${done}/${total} 个会话，下次刷新会继续补齐`);
  }
  if (failed > 0) {
    warnings.push(`${failed} 个会话读取失败${failedExamples.length ? `（${failedExamples.join("、")} 等）` : ""}，已跳过`);
  }
  return {
    sessionCount: total,
    timedOut,
    reused,
    read,
    failed,
    elapsedMs: Date.now() - startedAt,
  };
}

// 把增量状态聚合成前端响应结构
function aggregateStates(state, sessionCount, warnings) {
  const days = new Map();   // dateKey -> { total, turns, byModel: Map(model->metrics) }
  const hourly = new Map(); // dateKey -> Map<hour, { total, byModel: Map(model->metrics) }>
  const modelTotals = new Map(); // model -> metrics
  const usageDays = new Set();
  let messageCount = 0;
  let longestSessionMs = 0;

  const ensureDay = (key) => {
    let d = days.get(key);
    if (!d) {
      d = { total: 0, turns: 0, byModel: new Map() };
      days.set(key, d);
    }
    return d;
  };

  for (const entry of Object.values(state.files)) {
    if (!entry || typeof entry !== "object") continue;
    messageCount += Number(entry.m) || 0;
    const created = Number(entry.created) || 0;
    const last = Number(entry.last) || 0;
    if (created > 0 && last > created && last - created > longestSessionMs) {
      longestSessionMs = last - created;
    }
    for (const [date, models] of Object.entries(entry.u || {})) {
      usageDays.add(date);
      const day = ensureDay(date);
      for (const [model, arr] of Object.entries(models || {})) {
        const metrics = metricsOf(arr);
        addToMap(day.byModel, model, metrics);
        addToMap(modelTotals, model, metrics);
        day.total += metrics.total;
      }
    }
    for (const [date, turns] of Object.entries(entry.t || {})) {
      const n = Number(turns) || 0;
      if (n > 0) ensureDay(date).turns += n;
    }
    for (const [date, hours] of Object.entries(entry.h || {})) {
      let byHour = hourly.get(date);
      if (!byHour) {
        byHour = new Map();
        hourly.set(date, byHour);
      }
      for (const [hourKey, models] of Object.entries(hours || {})) {
        const hour = Number(hourKey);
        if (!Number.isFinite(hour)) continue;
        let bucket = byHour.get(hour);
        if (!bucket) {
          bucket = { total: 0, byModel: new Map() };
          byHour.set(hour, bucket);
        }
        for (const [model, arr] of Object.entries(models || {})) {
          const metrics = metricsOf(arr);
          addToMap(bucket.byModel, model, metrics);
          bucket.total += metrics.total;
        }
      }
    }
  }

  // 当前连续活跃天数（沿用旧口径：按有 turns 的 day 判断）
  let currentStreak = 0;
  const sortedDates = [...days.keys()].sort();
  if (sortedDates.length > 0 && sortedDates[sortedDates.length - 1] === dateKey(Date.now())) {
    currentStreak = 1;
    const d = new Date();
    while (true) {
      d.setDate(d.getDate() - 1);
      if (days.has(dateKey(d.getTime()))) currentStreak += 1;
      else break;
    }
  }

  return {
    days,
    hourly,
    modelTotals,
    sessionCount,
    messageCount,
    currentStreak,
    streaks: computeStreaks(usageDays),
    longestSessionMs,
    warnings,
  };
}

// 把聚合结果转成可序列化、可直接返回给前端的响应结构
function buildCache(s, meta) {
  const dayList = [...s.days.entries()]
    .map(([date, d]) => {
      const hours = [...(s.hourly.get(date) || new Map()).entries()]
        .map(([hour, o]) => ({
          hour,
          total: o.total,
          byModel: [...o.byModel.entries()].map(([model, m]) => ({ model, color: modelColor(model), ...m })),
        }))
        .sort((a, b) => a.hour - b.hour);
      return {
        date,
        total: d.total,
        turns: d.turns,
        byModel: [...d.byModel.entries()].map(([model, m]) => ({ model, color: modelColor(model), ...m })),
        hours: hours.length > 0 ? hours : undefined,
      };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const totals = [...s.modelTotals.entries()]
    .map(([model, m]) => ({ model, color: modelColor(model), ...m }))
    .sort((a, b) => b.total - a.total);
  const grandTotal = totals.reduce((sum, m) => sum + m.total, 0);
  const top = totals[0];
  const topModel = top
    ? { name: top.model, color: top.color, tokens: top.total, percent: grandTotal > 0 ? Math.round((top.total / grandTotal) * 100) : 0 }
    : null;
  // 顶部指标卡(基于全历史,不受时间范围选择影响)
  const peakDayTokens = dayList.reduce((mx, d) => Math.max(mx, d.total), 0);
  const summary = {
    totalTokens: grandTotal, // 累计 Token 数
    peakDayTokens, // 峰值 Token 数(历史单日最大)
    longestSessionMs: s.longestSessionMs || 0, // 最长聊天时长
    currentStreak: s.streaks ? s.streaks.current : 0, // 当前连续天数
    longestStreak: s.streaks ? s.streaks.longest : 0, // 最长连续天数
  };
  return {
    ok: true,
    schemaVersion: CACHE_SCHEMA,
    generatedAt: Date.now(),
    sessionCount: s.sessionCount,
    messageCount: s.messageCount,
    dayCount: dayList.length,
    currentStreak: s.currentStreak,
    summary,
    grandTotal,
    topModel,
    totals,
    days: dayList,
    warnings: s.warnings, // 失败/降级提示
    partial: Boolean(meta && meta.partial),
    scan: meta && meta.scan ? meta.scan : undefined,
  };
}

// ---------- 缓存 ----------
// 内存 + 磁盘双层缓存;SWR:过期后先返回旧数据、后台异步刷新,首屏不因全量扫描阻塞。
let cache = null;
let cacheAt = 0;
let inflight = null; // 并发重扫互斥:并发期间共享同一份扫描结果
let cacheDir = null; // apply 中按当前 profile 解析；解析不到则回退旧路径

function legacyCacheFilePath() {
  // 显式指定缓存目录时不做旧路径迁移（测试/隔离部署不应读到宿主真实缓存）
  if (process.env.USAGE_STATS_CACHE_DIR) return null;
  return join(homedir(), ".dsh", "profiles", "web", "usage-stats-cache.json");
}

function cacheFilePath() {
  return join(cacheDir || join(homedir(), ".dsh", "profiles", "web"), "usage-stats-cache.json");
}

function stateFilePath() {
  return join(cacheDir || join(homedir(), ".dsh", "profiles", "web"), "usage-stats-state.json");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function loadDiskCache() {
  // 新路径优先；没有则读旧路径做一次性迁移（冷启动不丢数）
  for (const p of [cacheFilePath(), legacyCacheFilePath()]) {
    if (!p) continue;
    const j = await readJson(p);
    if (j && typeof j === "object" && (j.ok || j.error)) {
      // 旧口径缓存不再使用：字段语义已变（模型归因/统计范围），避免显示错数
      if (j.ok && j.schemaVersion !== CACHE_SCHEMA) continue;
      return j;
    }
  }
  return null;
}

async function loadScanState() {
  const j = await readJson(stateFilePath());
  return isScanState(j) ? j : emptyScanState();
}

async function atomicWrite(path, text) {
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, text, "utf8");
  try {
    await rename(tmp, path);
  } catch {
    // Windows 上目标被占用时 rename 可能失败，退化为直接覆盖
    await writeFile(path, text, "utf8");
  }
}

async function persistDiskCache(data) {
  try {
    await atomicWrite(cacheFilePath(), JSON.stringify(data));
  } catch {
    // 写盘失败不影响主流程(下次启动退化回全量扫描)
  }
}

export function apply(ctx) {
  const { webServer, connection } = ctx;
  if (!webServer) return;

  // 缓存跟随当前 profile（此前硬编码 profiles/web 是历史遗留）。
  // 解析不到时回退旧路径，保证不断；读缓存时新旧路径都试（一次性迁移）。
  try {
    const profile = typeof ctx.get === "function" ? ctx.get("profileContext") : null;
    if (profile && typeof profile.dir === "string" && profile.dir) cacheDir = profile.dir;
  } catch { /* 保持旧路径 */ }
  const envCacheDir = process.env.USAGE_STATS_CACHE_DIR;
  if (typeof envCacheDir === "string" && envCacheDir.trim()) cacheDir = envCacheDir.trim();

  let state = emptyScanState();
  let stateDirty = false;
  let stateWrite = Promise.resolve();

  const persistScanState = () => {
    if (!stateDirty) return stateWrite;
    stateDirty = false;
    const snapshot = JSON.stringify(state);
    stateWrite = stateWrite
      .then(() => atomicWrite(stateFilePath(), snapshot))
      .catch(() => { /* 写盘失败不影响主流程，下次重扫 */ });
    return stateWrite;
  };

  const stateReady = loadScanState().then((loaded) => {
    state = loaded;
    return loaded;
  });

  // 启动时异步加载磁盘缓存,回填内存(不阻塞 apply)
  loadDiskCache().then((c) => {
    if (c && c.ok && !cache) {
      cache = c;
      cacheAt = c.generatedAt || 0;
    }
  });

  let lastCheckpoint = Date.now();
  const hooks = {
    progress(done, total) {
      stateDirty = true;
      if (done === total || Date.now() - lastCheckpoint > 5000) {
        lastCheckpoint = Date.now();
        void persistScanState();
      }
    },
  };

  const ensureScan = () => {
    if (!inflight) {
      inflight = (async () => {
        await stateReady;
        const warnings = [];
        const scan = await scanSessions(state, warnings, hooks);
        const aggregated = aggregateStates(state, scan.sessionCount, warnings);
        const built = buildCache(aggregated, {
          partial: scan.timedOut || scan.failed > 0,
          scan: {
            sessions: scan.sessionCount,
            read: scan.read,
            reused: scan.reused,
            failed: scan.failed,
            elapsedMs: scan.elapsedMs,
            timedOut: scan.timedOut,
          },
        });
        cache = built;
        cacheAt = built.generatedAt;
        stateDirty = true;
        await persistScanState();
        await persistDiskCache(built);
      })().catch((e) => {
        const message = String(e && e.message ? e.message : e);
        if (cache && cache.ok) {
          cache.warnings = [...(cache.warnings || []), `刷新失败：${message}`];
        } else {
          cache = { ok: false, schemaVersion: CACHE_SCHEMA, error: message, generatedAt: Date.now() };
          cacheAt = Date.now();
        }
      }).finally(() => { inflight = null; });
    }
    return inflight;
  };

  webServer.register({
    kind: "exact",
    path: "/api/usage-stats",
    handler: async (req, res) => {
      // 本路由是 /api 下的 exact 路由,优先级高于 dsh-client-connection 挂在 /api prefix 上的
      // 信任栅栏(Host/Origin + 浏览器认证 cookie),必须自己过栅栏(官方 dsh-host-open-in-app 同一做法)。
      const rejection = connection && typeof connection.requestRejection === "function"
        ? connection.requestRejection(req)
        : 503; // 拿不到栅栏服务时拒绝服务,而不是放行
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end(rejection === 401 ? "unauthorized" : rejection === 403 ? "forbidden" : "service unavailable");
        return;
      }
      const url = new URL(req.url, "http://x");
      const refresh = url.searchParams.get("refresh") === "1";
      if (!cache || refresh) {
        // 无缓存:必须同步扫描首屏等待;或强制刷新:等待新结果
        await ensureScan();
      } else {
        // 有缓存:立即返回;若过期则后台异步刷新,不阻塞本次响应(SWR)
        const stale = Date.now() - (cache.generatedAt || 0) > CACHE_TTL;
        if (stale) ensureScan();
      }
      res.writeHead(cache && cache.ok ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cache));
    },
  });
}
