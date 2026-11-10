// 会话汇总：把「这个会话下面有几个任务、最差什么样、整体到哪了」算成一行。
// 只汇总读得到的东西：没有一条任务报百分比，就明说看不到进度，不拿任务数编一个百分比。

import type { Verdict } from "./types";
import { rank, worst } from "./rules";
import { shortSession } from "./session";

export type SessionTask = {
  session: string | null;
  verdict: Verdict;
  /** 日志里读到的百分比；读不到是 null */
  percent: number | null;
};

export type SessionJob = {
  session: string | null;
  state: string;
};

export type SessionSummary = {
  /** 原始会话号；没有就是 null（归到「未标会话」这一行） */
  session: string | null;
  /** 上屏用的短名 */
  label: string;
  running: number;
  queued: number;
  worst: Verdict;
  /** 报百分比的那些任务的平均值；一条都没报就是 null */
  progress: number | null;
  /** 报了几条百分比，用来说明整体进度覆盖了几个任务 */
  with_progress: number;
};

const QUEUED_STATES = new Set(["queued", "starting"]);

export function summarizeSessions(tasks: SessionTask[], jobs: SessionJob[] = []): SessionSummary[] {
  const map = new Map<string, SessionSummary>();
  const percents = new Map<string, number[]>();
  const keyOf = (session: string | null) => session ?? "";

  const ensure = (session: string | null): SessionSummary => {
    const key = keyOf(session);
    let row = map.get(key);
    if (!row) {
      row = {
        session,
        label: session ? shortSession(session) : "未标会话",
        running: 0,
        queued: 0,
        worst: "ok",
        progress: null,
        with_progress: 0,
      };
      map.set(key, row);
    }
    return row;
  };

  for (const task of tasks) {
    const row = ensure(task.session);
    row.running += 1;
    row.worst = worst([row.worst, task.verdict]);
    if (task.percent !== null && Number.isFinite(task.percent)) {
      const key = keyOf(task.session);
      const list = percents.get(key) ?? [];
      list.push(task.percent);
      percents.set(key, list);
    }
  }

  for (const job of jobs) {
    if (!QUEUED_STATES.has(job.state)) continue;
    ensure(job.session).queued += 1;
  }

  for (const [key, list] of percents) {
    const row = map.get(key);
    if (!row || !list.length) continue;
    row.progress = Math.round(list.reduce((sum, value) => sum + value, 0) / list.length);
    row.with_progress = list.length;
  }

  return [...map.values()].sort((a, b) => {
    if (a.running !== b.running) return b.running - a.running;
    if (a.queued !== b.queued) return b.queued - a.queued;
    const byVerdict = rank(a.worst) - rank(b.worst);
    if (byVerdict !== 0) return byVerdict;
    return a.label.localeCompare(b.label, "zh-CN");
  });
}
