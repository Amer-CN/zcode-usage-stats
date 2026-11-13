// 扫描 worker：把「读文件 + 多帧 zstd 解压 + 解析」搬到线程池里跑。
// 宿主事件循环因此不再被冷扫描阻塞，多核也能真正并行（原先只有一个线程解压）。
// 解析实现与宿主侧共用 scan-core.mjs，保证两条路径口径完全一致。
import { parentPort } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { newSessionState, parseSessionBuffer, parseSessionText } from "./scan-core.mjs";

function parseFileContent(buf, file, state, ctx) {
  if (file.endsWith(".zstd")) parseSessionBuffer(buf, ctx, state);
  else parseSessionText(buf.toString("utf8"), ctx, state);
  if (!ctx.header) throw new Error("缺少会话头");
  return state;
}

parentPort.on("message", async (message) => {
  if (!message || message.type !== "file") return;
  const { id, file } = message;
  try {
    const state = parseFileContent(await readFile(file), file, newSessionState(), {
      header: null,
      currentModel: "other",
      lastTurn: null,
      badLines: 0,
    });
    parentPort.postMessage({ id, ok: true, state });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error && error.message ? error.message : error) });
  }
});