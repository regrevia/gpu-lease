// 终端面板：2 秒刷一次，一屏看完。不做历史曲线——曲线是仪表盘的事，这里只回答"现在怎么样"。

import { buildState } from "./state";
import { renderPanel, VERDICT_LABEL, verdictColor } from "./render";

const CLEAR = "\x1b[2J\x1b[H";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

export async function commandWatch(argv: string[]): Promise<number> {
  const intervalMs = argv.includes("--fast") ? 1000 : 2000;
  const color = process.stdout.isTTY === true && !argv.includes("--no-color");

  let stopped = false;
  const stop = () => {
    stopped = true;
    process.stdout.write(SHOW);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => {
      const key = chunk.toString();
      if (key === "q" || key === "\u0003") stop();
    });
  }

  process.stdout.write(HIDE);
  let lastError: string | null = null;

  while (!stopped) {
    const started = Date.now();
    let body: string[];
    try {
      const state = await buildState();
      body = renderPanel(state, { color });
      lastError = null;
      const running = state.tasks.filter((t) => t.run.ended_at === null);
      const worstVerdict = running
        .map((t) => t.verdict)
        .sort((a, b) => (a === "failed" || a === "lost" ? -1 : 1))[0];
      const summary = running.length
        ? ` ${running.length} 个任务在跑 · 最差 ${worstVerdict ?? VERDICT_LABEL.ok}`
        : "";
      body.push("");
      body[body.length - 1] = color
        ? `\x1b[2m${new Date().toLocaleTimeString("zh-CN", { hour12: false })} 刷新 · q 退出${summary}\x1b[0m`
        : `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} 刷新 · q 退出${summary}`;
      if (summary) {
        body[body.length - 1] += "";
      }
    } catch (err) {
      lastError = String(err);
      body = [`读取失败：${lastError}`, "", "按 q 退出，或跑 gpulease doctor --bundle 生成诊断包"];
    }

    process.stdout.write(CLEAR + body.join("\n") + "\n");
    const elapsed = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(200, intervalMs - elapsed)));
  }

  process.stdout.write(SHOW + "\n");
  return 0;
}
