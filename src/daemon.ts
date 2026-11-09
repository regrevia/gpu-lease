// 常驻值班：每一轮看一遍状态，只在"变坏"或"从坏恢复"时说话，然后把话推到人手机上。
// 单实例靠 daemon.lock；心跳写在 daemon.json，doctor / ls 能看出值班员还活着。
// 这里不杀进程、不抢卡——先只做"看见并说出来"，调度在 0.3 的下一层。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALERT_TITLE, formatAlert, planAlerts } from "./alerts";
import { postWebhook } from "./notify";
import { stateDir } from "./paths";
import { VERSION } from "./doctor";
import { buildState } from "./state";
import {
  insertEvent,
  markEventDelivery,
  openStore,
  readVerdicts,
  writeVerdicts,
} from "./store";

export type DaemonStatus = {
  pid: number;
  at: number;
  version: string;
  tasks: number;
  webhook: boolean;
  last_error: string | null;
};

const lockPath = () => join(stateDir(), "daemon.lock");
const beatPath = () => join(stateDir(), "daemon.json");

export function readDaemonStatus(): DaemonStatus | null {
  try {
    return JSON.parse(readFileSync(beatPath(), "utf8")) as DaemonStatus;
  } catch {
    return null;
  }
}

/** 心跳 15 秒内算活着；进程不在了也算不在。 */
export function daemonAlive(now = Date.now()): boolean {
  const beat = readDaemonStatus();
  if (!beat) return false;
  if (now - beat.at > 15_000) return false;
  try {
    process.kill(beat.pid, 0);
    return true;
  } catch {
    return false;
  }
}

type TickResult = { alerts: number; tasks: number; errors: string[] };

/** 单独一轮：测试与 --once 都走它。 */
export async function tick(opts: { webhook?: string | null; quiet?: boolean } = {}): Promise<TickResult> {
  const db = openStore();
  const state = await buildState({ includeEnded: false });
  const known = readVerdicts(db) as Map<string, string>;
  const alerts = planAlerts(known as never, state.tasks);
  const errors: string[] = [];

  for (const alert of alerts) {
    const id = insertEvent(db, {
      at: alert.at,
      run_id: alert.run_id,
      name: alert.name,
      kind: alert.kind,
      message: alert.message,
    });
    const line = formatAlert(alert);
    if (!opts.quiet) console.log(`${stamp(alert.at)} ${line}`);
    if (opts.webhook) {
      const sent = await postWebhook(opts.webhook, ALERT_TITLE[alert.kind], alert.message);
      markEventDelivery(db, id, sent.ok, sent.detail);
      if (!sent.ok) {
        errors.push(`推送失败：${sent.detail}`);
        if (!opts.quiet) console.log(`${stamp(alert.at)} 推送失败（${sent.detail}），事件已留在本地`);
      }
    }
  }

  writeVerdicts(
    db,
    state.tasks.map((t) => ({ run_id: t.run.id, verdict: t.verdict })),
  );
  writeBeat(state.tasks.length, Boolean(opts.webhook), errors[0] ?? null);
  return { alerts: alerts.length, tasks: state.tasks.length, errors };
}

function writeBeat(tasks: number, webhook: boolean, lastError: string | null): void {
  mkdirSync(stateDir(), { recursive: true });
  const status: DaemonStatus = {
    pid: process.pid,
    at: Date.now(),
    version: VERSION,
    tasks,
    webhook,
    last_error: lastError,
  };
  writeFileSync(beatPath(), JSON.stringify(status), "utf8");
}

function stamp(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

export type DaemonOptions = {
  intervalMs?: number;
  webhook?: string | null;
  once?: boolean;
  quiet?: boolean;
};

export async function runDaemon(opts: DaemonOptions = {}): Promise<number> {
  const interval = Math.max(1000, opts.intervalMs ?? 5000);
  mkdirSync(stateDir(), { recursive: true });

  const existing = readDaemonStatus();
  if (existing && daemonAlive()) {
    console.error(`已经有一个值班进程在跑（pid ${existing.pid}，${stamp(existing.at)} 还在跳）`);
    return 1;
  }
  writeFileSync(lockPath(), String(process.pid), "utf8");

  const stop = () => {
    cleanup();
    process.exit(0);
  };
  if (!opts.once) {
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }

  try {
    if (!opts.quiet) {
      console.log(`值班开始：每 ${Math.round(interval / 1000)} 秒看一次${opts.webhook ? "，异常推送到 webhook" : ""}`);
    }
    for (;;) {
      await tick({ webhook: opts.webhook, quiet: opts.quiet });
      if (opts.once) return 0;
      await Bun.sleep(interval);
    }
  } finally {
    if (!opts.once) cleanup();
  }
}

function cleanup(): void {
  rmSync(lockPath(), { force: true });
  rmSync(beatPath(), { force: true });
}
