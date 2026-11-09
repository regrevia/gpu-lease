// 判定层：把"进程还活着吗、还在输出吗、卡还在吗"翻译成一句话。
// 这是这个产品唯一真正值钱的地方——数字谁都会采，判断没人做。

import type { Assessment, Run, Verdict } from "./types";

export const THRESHOLDS = {
  /** 多久没输出算"慢"（秒） */
  slowSec: 180,
  /** 多久没输出算"卡住"（秒） */
  stalledSec: 600,
  /** 刚启动的宽限期，别一上来就报警（秒） */
  graceSec: 30,
};

export type JudgeInput = {
  run: Run;
  now: number;
  alive: boolean;
  lastOutputAt: number | null;
  /** 显卡层状态：present / absent / error（断联） */
  gpuStatus: "present" | "absent" | "error";
};

const PRIORITY: Verdict[] = ["lost", "failed", "stalled", "suspect", "slow", "ok", "unknown"];

export function rank(v: Verdict): number {
  const i = PRIORITY.indexOf(v);
  return i === -1 ? PRIORITY.length : i;
}

/** 取最坏的那个判定：一张卡上只要有一个任务出事，卡就是那个状态。 */
export function worst(verdicts: Verdict[]): Verdict {
  if (!verdicts.length) return "ok";
  return verdicts.reduce((acc, v) => (rank(v) < rank(acc) ? v : acc), "ok" as Verdict);
}

export function judge(input: JudgeInput): Assessment {
  const { run, now, alive, lastOutputAt, gpuStatus } = input;
  const since = lastOutputAt ?? run.started_at;
  const quietSec = (now - since) / 1000;
  const ageSec = (now - run.started_at) / 1000;

  // 1. 进程还在，但卡没了 —— 最严重，先报。
  if (run.ended_at === null && gpuStatus === "error") {
    return {
      run_id: run.id,
      verdict: "suspect",
      sentence: `「${run.name}」还在跑，但显卡这一刻读不到（可能是外接卡断联）`,
      since,
    };
  }

  // 2. 有退出码：这才是真的结束了，不该冒充"跑着"。
  if (run.exit_code !== null) {
    if (run.exit_code === 0) {
      return { run_id: run.id, verdict: "ok", sentence: `「${run.name}」已完成`, since: run.ended_at ?? now };
    }
    return {
      run_id: run.id,
      verdict: "failed",
      sentence: `「${run.name}」退出码 ${run.exit_code}，失败了`,
      since: run.ended_at ?? now,
    };
  }

  // 3. 我们在跑，但进程不在了（被关、被系统杀、机器重启）——说"消失"，不说"失败"。
  if (run.ended_at === null && !alive && ageSec > THRESHOLDS.graceSec) {
    return {
      run_id: run.id,
      verdict: "lost",
      sentence: `「${run.name}」的进程已经不在了（不是正常退出）`,
      since,
    };
  }

  // 4. 活着但长时间没输出。
  if (ageSec > THRESHOLDS.graceSec && quietSec > THRESHOLDS.stalledSec) {
    return {
      run_id: run.id,
      verdict: "stalled",
      sentence: `「${run.name}」已经 ${humanDuration(quietSec)} 没有输出了，可能卡住`,
      since,
    };
  }
  if (ageSec > THRESHOLDS.graceSec && quietSec > THRESHOLDS.slowSec) {
    return {
      run_id: run.id,
      verdict: "slow",
      sentence: `「${run.name}」${humanDuration(quietSec)} 没有新输出，比平时慢`,
      since,
    };
  }

  // 5. 活着、有输出。
  const tail = quietSec < 15 ? "正常" : `已有 ${humanDuration(quietSec)} 没新输出，仍在跑`;
  return { run_id: run.id, verdict: "ok", sentence: `「${run.name}」在跑，${tail}`, since };
}

export function humanDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
}
