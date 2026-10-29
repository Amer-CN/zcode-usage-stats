/* 宿主侧扫描回归：流式读取 + 按文件增量 + 聚合口径
 * 用真实 zstd 会话文件跑一遍 apply()/HTTP handler，不依赖 DSH 运行时。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "usage-stats-scan-"));
const HOME = path.join(TMP, "home");
const SESSIONS = path.join(HOME, "sessions");
const PROFILE = path.join(TMP, "profile");
const CACHE = path.join(TMP, "cache");
process.env.DSH_HOME = HOME;
process.env.USAGE_STATS_CACHE_DIR = CACHE;
process.env.USAGE_STATS_SCAN_TIMEOUT_MS = "30000";

const S1 = path.join(SESSIONS, "proj-a", "session-aaa");
const S2 = path.join(SESSIONS, "proj-b", "session-bbb");
fs.mkdirSync(S1, { recursive: true });
fs.mkdirSync(S2, { recursive: true });

const t0 = new Date(2026, 9, 28, 10, 0, 0).getTime(); // 2026-10-28 10:00 本地

function usageEvent(seq, minute, model, i, o, cr, cw) {
  return {
    type: "assistant/message",
    seq,
    time: t0 + minute * 60_000,
    data: {
      turn: 1,
      step: seq,
      message: { role: "assistant", source: { provider: "p", model } },
      usage: { inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw },
    },
  };
}

function sessionLines(header, events) {
  return [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n";
}

const s1Header = { type: "session", version: 4, id: "session-aaa", createdAt: t0, cwd: "x" };
const s1Events = [
  { type: "request/context", seq: 0, time: t0, data: { model: "model-a" } },
  { type: "step/end", seq: 1, time: t0 + 60_000, data: { turn: 1 } },
  usageEvent(2, 2, "model-a", 10, 5, 2, 1),
];
const s2Header = { type: "session", version: 3, id: "session-bbb", createdAt: t0 + 120_000, cwd: "y" };
const s2Events = [
  { type: "request/context", seq: 0, time: t0 + 120_000, data: { model: "model-b" } },
  { type: "step/end", seq: 1, time: t0 + 180_000, data: { turn: 1 } },
  usageEvent(2, 3, "model-b", 20, 10, 4, 2),
];

function writeZstd(file, text) {
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, "utf8")));
}

function zstdFrame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, "utf8"));
}

function appendZstd(file, text) {
  fs.appendFileSync(file, zstdFrame(text));
}

const linesOf = (events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const f1 = path.join(S1, "session.v4.jsonl.zstd");
const f2 = path.join(S2, "session.v3.jsonl.zstd");
// 多帧拼接（模拟 DSH 每次追加一帧；Electron 自带 zstd 只解第一帧，必须逐帧解）
writeZstd(f1, JSON.stringify(s1Header) + "\n");
appendZstd(f1, linesOf(s1Events));
writeZstd(f2, sessionLines(s2Header, s2Events));
// 迁移残留：同目录的 v3 旧档必须让位给 v4，不能重复计数
writeZstd(path.join(S1, "session.v3.jsonl.zstd"), sessionLines({ ...s1Header, version: 3 }, s1Events));
// .bak 文件必须被忽略
writeZstd(path.join(S1, "session.v4.jsonl.zstd.bak-20260101"), sessionLines(s1Header, s1Events));

let route = null;
const ctx = {
  webServer: { register(r) { route = r; } },
  connection: { requestRejection() { return undefined; } },
  get(name) { return name === "profileContext" ? { name: "test", dir: PROFILE } : null; },
};

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: "",
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(chunk) { this.body = chunk || ""; },
  };
}

async function query(search = "") {
  const res = makeRes();
  await route.handler({ url: "/api/usage-stats" + search, headers: {} }, res);
  assert.equal(res.statusCode, 200, "HTTP 200");
  return JSON.parse(res.body);
}

function totalsOf(data) {
  return Object.fromEntries((data.totals || []).map((m) => [m.model, m.total]));
}

(async () => {
  const { pathToFileURL } = require("node:url");
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "index.mjs")).href);
  mod.apply(ctx);
  assert.ok(route, "注册了 /api/usage-stats 路由");
  assert.equal(route.kind, "exact");
  assert.equal(route.path, "/api/usage-stats");

  // 首次：全量扫描
  const first = await query("?refresh=1");
  assert.equal(first.ok, true);
  assert.equal(first.sessionCount, 2, "两个会话（.bak 不计）");
  assert.equal(first.messageCount, 2);
  assert.equal(first.days.length, 1);
  assert.equal(first.days[0].turns, 2);
  assert.deepEqual(totalsOf(first), { "model-a": 18, "model-b": 36 });
  assert.equal(first.grandTotal, 54);
  assert.equal(first.partial, false);
  assert.ok(first.scan.read === 2, "首次读取 2 个会话");

  // 第二次：未变化 → 全部复用
  const second = await query("?refresh=1");
  assert.deepEqual(totalsOf(second), totalsOf(first));
  assert.equal(second.scan.read, 0, "增量扫描不重读");
  assert.equal(second.scan.reused, 2);

  // 给 s1 追加一个 turn（新 zstd 帧）：只重读 s1，总数增加 7
  const appended = [
    { type: "step/end", seq: 3, time: t0 + 300_000, data: { turn: 2 } },
    usageEvent(4, 5, "model-a", 4, 2, 1, 0),
  ];
  appendZstd(f1, linesOf(appended));

  const third = await query("?refresh=1");
  assert.deepEqual(totalsOf(third), { "model-a": 25, "model-b": 36 });
  assert.equal(third.grandTotal, 61);
  assert.equal(third.messageCount, 3);
  assert.equal(third.scan.read, 1, "只重读追加过的会话");
  assert.equal(third.scan.reused, 1);

  // 删除 s2：统计随之下降，状态清理
  fs.rmSync(f2);
  const fourth = await query("?refresh=1");
  assert.deepEqual(totalsOf(fourth), { "model-a": 25 });
  assert.equal(fourth.sessionCount, 1);
  assert.equal(fourth.grandTotal, 25);

  // 末尾半帧（正在追加）必须被忽略，不能丢掉已完整的帧
  fs.appendFileSync(f1, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00]));
  const tail = await query("?refresh=1");
  assert.equal(tail.grandTotal, 25, "半帧不丢已完成数据");
  assert.equal(tail.scan.failed, 0);

  // 超时：仍复用已持久化的状态，标记 partial 并给出续扫提示
  process.env.USAGE_STATS_SCAN_TIMEOUT_MS = "0";
  const partial = await query("?refresh=1");
  assert.equal(partial.partial, true);
  assert.ok((partial.warnings || []).some((w) => w.includes("扫描超时")), "超时警告");
  assert.equal(partial.grandTotal, 25, "超时也返回已缓存状态");
  process.env.USAGE_STATS_SCAN_TIMEOUT_MS = "30000";
  const recovered = await query("?refresh=1");
  assert.equal(recovered.partial, false);
  assert.equal(recovered.grandTotal, 25);

  const state = JSON.parse(fs.readFileSync(path.join(CACHE, "usage-stats-state.json"), "utf8"));
  assert.equal(state.schema, 3);
  assert.equal(Object.keys(state.files).length, 1);
  assert.ok(!JSON.stringify(state.files).includes("session-bbb"), "已删除会话不留状态");

  const cache = JSON.parse(fs.readFileSync(path.join(CACHE, "usage-stats-cache.json"), "utf8"));
  assert.equal(cache.schemaVersion, 3);
  assert.equal(cache.grandTotal, 25);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("host-scan: PASS");
})().catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.error(e);
  process.exit(1);
});
