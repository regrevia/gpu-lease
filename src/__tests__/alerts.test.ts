import { describe, expect, test } from "bun:test";
import { formatAlert, planAlerts } from "../alerts";
import type { TaskView } from "../state";
import type { Verdict } from "../types";

function task(id: string, verdict: Verdict, name = "训练 SDXL LoRA"): TaskView {
  return {
    run: {
      id,
      name,
      command: "python train.py",
      cwd: "C:\\work",
      root_pid: 1,
      started_at: 0,
      ended_at: null,
      exit_code: null,
      pids: [1],
      gpu_hint: null,
      log_path: null,
      last_output_at: 0,
    },
    verdict,
    sentence: `「${name}」在跑，${verdict}`,
    alive: true,
    since: 0,
    gpus: [],
    progress: null,
  };
}

describe("什么时候该吵醒人", () => {
  test("第一次见就正常：不吵", () => {
    expect(planAlerts(new Map(), [task("a", "ok")])).toHaveLength(0);
  });

  test("正常变卡住：吵一次，只一次", () => {
    const known = new Map<string, Verdict>([["a", "ok"]]);
    const one = planAlerts(known, [task("a", "stalled")]);
    expect(one).toHaveLength(1);
    expect(one[0].kind).toBe("stalled");
    expect(planAlerts(known, [task("a", "stalled")])).toHaveLength(1);
    expect(planAlerts(new Map([["a", "stalled"]]), [task("a", "stalled")])).toHaveLength(0);
  });

  test("偏慢不算事件", () => {
    expect(planAlerts(new Map([["a", "ok"]]), [task("a", "slow")])).toHaveLength(0);
  });

  test("从坏恢复到正常：说一声恢复了", () => {
    const alerts = planAlerts(new Map([["a", "stalled"]]), [task("a", "ok")]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("recovered");
    expect(alerts[0].message).toContain("恢复正常");
  });

  test("第一次见就已经失败：算新闻", () => {
    const alerts = planAlerts(new Map(), [task("a", "failed")]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("failed");
  });

  test("下标断联优先报断联", () => {
    expect(planAlerts(new Map([["a", "ok"]]), [task("a", "lost")])[0].kind).toBe("lost");
  });

  test("推出去的句子带标题，且是判定原话", () => {
    const [alert] = planAlerts(new Map([["a", "ok"]]), [task("a", "stalled")]);
    const line = formatAlert(alert);
    expect(line).toContain("【任务卡住】");
    expect(line).toContain("「训练 SDXL LoRA」");
  });
});
