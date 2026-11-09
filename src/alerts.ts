// 决定「什么时候该吵醒人」。纯函数：进去这个 tick 的已知状态与任务，出来要发的告警。
// 原则：只在状态**变坏**或**从坏恢复**时说话；任务刚出现就已经是坏的，也算新闻。

import type { TaskView } from "./state";
import type { Verdict } from "./types";

export type AlertKind = "failed" | "lost" | "stalled" | "suspect" | "recovered";

export type Alert = {
  run_id: string;
  name: string;
  kind: AlertKind;
  /** 直接给用户看的一句话，取自判定结果，不重新造词 */
  message: string;
  at: number;
};

/** 值得打扰人的状态。偏慢（slow）不算：那是趋势，不是事件。 */
const LOUD: Verdict[] = ["failed", "lost", "stalled", "suspect"];

const KIND_OF: Partial<Record<Verdict, AlertKind>> = {
  failed: "failed",
  lost: "lost",
  stalled: "stalled",
  suspect: "suspect",
};

export const ALERT_TITLE: Record<AlertKind, string> = {
  failed: "任务失败",
  lost: "卡断了",
  stalled: "任务卡住",
  suspect: "状态可疑",
  recovered: "恢复",
};

const NOUN: Record<AlertKind, string> = {
  failed: "失败了",
  lost: "的卡断了",
  stalled: "卡住了",
  suspect: "状态可疑",
  recovered: "恢复正常了",
};

/**
 * @param known 上一次 tick 记下的每任务判定
 * @param tasks 这一 tick 还在跑的任务
 */
export function planAlerts(
  known: Map<string, Verdict>,
  tasks: TaskView[],
  at = Date.now(),
): Alert[] {
  const out: Alert[] = [];
  for (const task of tasks) {
    const prev = known.get(task.run.id);
    const now = task.verdict;
    if (prev === now) continue;

    if (prev === undefined) {
      // 第一次见：只有本身就不对劲才说话，免得重启后把一堆"正常"重播一遍。
      const kind = KIND_OF[now];
      if (kind) out.push(mk(task, kind, at));
      continue;
    }

    const kind = KIND_OF[now];
    if (kind) {
      out.push(mk(task, kind, at));
    } else if (now === "ok" && LOUD.includes(prev)) {
      const was = ALERT_TITLE[KIND_OF[prev] ?? "stalled"];
      out.push({
        run_id: task.run.id,
        name: task.run.name,
        kind: "recovered",
        message: `「${task.run.name}」${NOUN.recovered}（此前是「${was}」）`,
        at,
      });
    }
  }
  return out;
}

function mk(task: TaskView, kind: AlertKind, at: number): Alert {
  return { run_id: task.run.id, name: task.run.name, kind, message: task.sentence, at };
}

/** 告警文本：标题 + 一句人话，推给手机或气泡时够用。 */
export function formatAlert(alert: Alert): string {
  return `【${ALERT_TITLE[alert.kind]}】${alert.message}`;
}

/** 同一条任务同一种毛病，10 分钟内只吵一次；判断在反复横跳时别刷屏。 */
export const ALERT_COOLDOWN_MS = 10 * 60_000;

export type CooldownState = Record<string, number>;

/**
 * 冷却：key 是「任务 + 判定」，冷却期内同样的告警不再发出。
 * 恢复不压（恢复正是人想看到的那条），但记时间，避免它自己也反复播。
 */
export function dueAlerts(
  alerts: Alert[],
  last: CooldownState,
  at = Date.now(),
  cooldownMs = ALERT_COOLDOWN_MS,
): { due: Alert[]; next: CooldownState } {
  const next: CooldownState = { ...last };
  const due: Alert[] = [];
  for (const alert of alerts) {
    const key = `${alert.run_id}:${alert.kind}`;
    const sentAt = next[key];
    if (sentAt !== undefined && at - sentAt < cooldownMs && alert.kind !== "recovered") continue;
    next[key] = at;
    due.push(alert);
  }
  // 只留还在冷却窗口附近的条目，别让状态文件无限长。
  const pruned: CooldownState = {};
  for (const [key, sentAt] of Object.entries(next)) {
    if (at - sentAt < cooldownMs * 6) pruned[key] = sentAt;
  }
  return { due, next: pruned };
}
