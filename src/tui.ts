// 终端面板：2 秒刷一次，一屏看完。不做历史曲线——曲线是仪表盘的事，这里只回答"现在怎么样"。

import { buildState } from "./state";
import { renderPanel, VERDICT_LABEL } from "./render";
import { worst } from "./rules";

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
      const worstVerdict = running.length ? worst(running.map((t) => t.verdict)) : null;
      const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      const sessions = new Set(running.map((t) => t.run.session ?? ""));
      const sessionBit = sessions.size >= 2 ? ` · ${sessions.size} 个会话` : "";
      const summary = running.length
        ? ` ${running.length} 个任务在跑 · 最差 ${VERDICT_LABEL[worstVerdict ?? "ok"]}${sessionBit}`
        : "";
      const footer = `${stamp} 刷新 · q 退出${summary}`;
      body.push(color ? `\x1b[2m${footer}\x1b[0m` : footer);
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
