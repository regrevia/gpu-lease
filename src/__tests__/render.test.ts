import { describe, expect, test } from "bun:test";
import { progressText, renderList } from "../render";
import type { PanelState, TaskView } from "../state";

function task(progress: TaskView["progress"]): TaskView {
  return {
    run: {
      id: "r1",
      name: "训练 SDXL LoRA",
      command: "python train.py",
      cwd: "C:\\work",
      root_pid: 4242,
      started_at: Date.now() - 60_000,
      ended_at: null,
      exit_code: null,
      pids: [4242],
      gpu_hint: 0,
  session: null,
      log_path: null,
      last_output_at: Date.now(),
    },
    verdict: "ok",
    sentence: "「训练 SDXL LoRA」在跑，正常",
    alive: true,
    since: Date.now(),
    gpus: [0],
    progress,
  };
}

const state = (t: TaskView): PanelState => ({
  at: Date.now(),
  gpus: [],
  procs: [],
  tasks: [t],
  degraded: [],
  external: 0,
  nvidia: "absent",
});

describe("进度上屏", () => {
  test("有百分比、计数、剩余时间就全报出来", () => {
    const text = progressText(task({ percent: 42, label: "420/1000", eta_sec: 47 }));
    expect(text).toBe(" · 42% · 420/1000 · 还剩 47 秒");
  });

  test("只有计数时不给假百分比", () => {
    expect(progressText(task({ percent: null, label: "1.2/3.4 GIB", eta_sec: null }))).toBe(
      " · 1.2/3.4 GIB",
    );
  });

  test("读不到进度就一个字都不加", () => {
    expect(progressText(task(null))).toBe("");
  });

  test("ls 那一行也带进度", () => {
    const lines = renderList(state(task({ percent: 42, label: "420/1000", eta_sec: 47 })), {
      color: false,
    });
    expect(lines.join("\n")).toContain("42%");
    expect(lines.join("\n")).toContain("还剩 47 秒");
  });
});
