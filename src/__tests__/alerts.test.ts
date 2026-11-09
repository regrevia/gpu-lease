import { describe, expect, test } from "bun:test";
import { formatAlert, planAlerts, dueAlerts } from "../alerts";
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

test("同一条毛病 10 分钟内只吵一次，过了窗口再吵", () => {
  const alert = (at: number) =>
    ({ run_id: "r1", name: "训练", kind: "stalled" as const, message: "卡住了", at });
  const t0 = 1_700_000_000_000;

  const first = dueAlerts([alert(t0)], {}, t0);
  expect(first.due.length).toBe(1);

  // 3 分钟后同一件事又抖了一次：压掉
  const second = dueAlerts([alert(t0 + 3 * 60_000)], first.next, t0 + 3 * 60_000);
  expect(second.due.length).toBe(0);

  // 过了 10 分钟：该说
  const later = t0 + 11 * 60_000;
  const third = dueAlerts([alert(later)], second.next, later);
  expect(third.due.length).toBe(1);

  // 同一任务换一种毛病：不受另一种的冷却影响
  const other = dueAlerts(
    [{ run_id: "r1", name: "训练", kind: "failed", message: "挂了", at: t0 + 60_000 }],
    third.next,
    t0 + 60_000,
  );
  expect(other.due.length).toBe(1);

  // 恢复不压，哪怕同一判定刚吵过
  const rec = dueAlerts(
    [{ run_id: "r1", name: "训练", kind: "recovered", message: "好了", at: t0 + 120_000 }],
    other.next,
    t0 + 120_000,
  );
  expect(rec.due.length).toBe(1);
});
