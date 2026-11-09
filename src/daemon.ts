// 常驻值班：每一轮看一遍状态，只在"变坏"或"从坏恢复"时说话，然后把话推到人手机上。
// 单实例靠 daemon.lock；心跳写在 daemon.json，doctor / ls 能看出值班员还活着。
// 这里不杀进程、不抢卡——先只做"看见并说出来"，调度在 0.3 的下一层。

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALERT_TITLE, dueAlerts, formatAlert, planAlerts, type CooldownState } from "./alerts";
import { postWebhook } from "./notify";
import { stateDir } from "./paths";
import { VERSION } from "./doctor";
import { buildState } from "./state";
import { occupiesSlot, place, stuckJobs, type Card } from "./queue";
import { selfCommand } from "./self";
import {
  insertEvent,
  insertSamples,
  listJobs,
  markEventDelivery,
  openStore,
  pruneSamples,
  queuedJobs,
  readVerdicts,
  updateJob,
  writeVerdicts,
} from "./store";
import type { PanelState } from "./state";

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

/**
 * 把排队里的活分到卡上并真的起。只在卡可用时动；分不进去就把"为什么在等"写回队列，
 * 让人在 `gpulease queue` 里看到的是原因，不是干等。
 */
export function wrapperLogPath(name: string, id: string): string {
  const safe = name.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 40) || "job";
  const dir = join(stateDir(), "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, `wrapper-${safe}-${id}.log`);
}

function cooldownPath(): string {
  return join(stateDir(), "alert-cooldown.json");
}

function readCooldown(): CooldownState {
  try {
    const raw = readFileSync(cooldownPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as CooldownState) : {};
  } catch {
    // 没有或坏了都当作"从没吵过"，宁可多提醒一次也不静默。
    return {};
  }
}

function writeCooldown(next: CooldownState): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(cooldownPath(), JSON.stringify(next));
  } catch {
    /* 记不住就算了，不影响值班 */
  }
}

export async function dispatchQueued(
  state: PanelState,
  opts: { dryRun?: boolean } = {},
): Promise<string[]> {
  const db = openStore();
  const jobs = queuedJobs(db);
  if (!jobs.length) {
    db.close();
    return [];
  }

  const cards: Card[] = state.gpus.map((gpu) => ({
    index: gpu.index,
    label: `GPU ${gpu.index}`,
    usable: true,
    total_mb: gpu.vram_total_mb,
    used_mb: gpu.vram_used_mb,
    util: gpu.util,
  }));

  const inUse = new Map<number, number>();
  for (const task of state.tasks) {
    if (task.run.gpu_hint === null) continue;
    // 挂掉/断联的任务不再占坑，否则那张卡永远轮不到下一件活。
    if (!occupiesSlot(task.verdict)) continue;
    inUse.set(task.run.gpu_hint, (inUse.get(task.run.gpu_hint) ?? 0) + 1);
  }

  const assignments = place(
    jobs.map((job) => ({ id: job.id, name: job.name, need_mb: job.need_mb, created_at: job.created_at })),
    cards,
    inUse,
  );

  const started: string[] = [];
  for (const assignment of assignments) {
    const job = jobs.find((item) => item.id === assignment.id);
    if (!job) continue;
    if (assignment.gpu === null) {
      // 理由会变（比如从"还没看到卡"变成"余量不够"），变了才写，省得每轮都动库。
      if (job.reason !== assignment.reason) updateJob(db, job.id, { reason: assignment.reason });
      continue;
    }

    updateJob(db, job.id, { state: "starting", gpu: assignment.gpu, reason: assignment.reason });
    const line = `开始「${job.name}」→ ${assignment.reason}`;
    started.push(line);
    if (opts.dryRun) continue;

    try {
      const argv = JSON.parse(job.command) as string[];
      // 起不来的原因必须留得下：stdio 全 ignore 的话，Windows 上 run 半路死掉就只剩一个 starting。
      const wrapperLog = wrapperLogPath(job.name, job.id);
      const fd = openSync(wrapperLog, "a");
      const child = Bun.spawn(
        selfCommand(["run", "--name", job.name, "--gpu", String(assignment.gpu), "--job", job.id, "--", ...argv]),
        {
          cwd: job.cwd,
          env: { ...(process.env as Record<string, string>), GPULEASE_HOME: stateDir() },
          stdio: ["ignore", fd, fd],
        },
      );
      closeSync(fd);
      try {
        child.unref();
      } catch {
        /* 老版本 Bun 没有 unref，进程退出时会自己断 */
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      updateJob(db, job.id, { state: "queued", reason: `起不来：${reason.slice(0, 100)}` });
      started.push(`「${job.name}」起不来：${reason.slice(0, 100)}`);
    }
  }
  return started;
}

type TickResult = { alerts: number; tasks: number; errors: string[] };

/** 单独一轮：测试与 --once 都走它。 */
export async function tick(
  opts: { webhook?: string | null; quiet?: boolean; noDispatch?: boolean } = {},
): Promise<TickResult> {
  const db = openStore();
  const state = await buildState({ includeEnded: false });
  recordSamples(db, state.gpus, Date.now());
  const known = readVerdicts(db) as Map<string, string>;
  const planned = planAlerts(known as never, state.tasks);
  // 判定反复横跳时同一条毛病 10 分钟内只吵一次；冷却记在磁盘上，重启不重播。
  const cooled = dueAlerts(planned, readCooldown());
  const alerts = cooled.due;
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

  writeCooldown(cooled.next);
  writeVerdicts(
    db,
    state.tasks.map((t) => ({ run_id: t.run.id, verdict: t.verdict })),
  );
  // 停在 starting 的活说明 run 没起来：标成 failed 让人看得见，别让队列无声地卡住在"以为在跑"。
  const now = Date.now();
  for (const stuck of stuckJobs(listJobs(db, 50), now)) {
    updateJob(db, stuck.id, {
      state: "failed",
      ended_at: now,
      reason: "起了但没跑起来（看 logs/wrapper-*.log）",
    });
    if (!opts.quiet) console.log(`${stamp(now)} 「${stuck.name}」起了但没跑起来，已标成失败`);
  }

  if (!opts.noDispatch) {
    for (const line of await dispatchQueued(state)) {
      if (!opts.quiet) console.log(`${stamp(Date.now())} ${line}`);
    }
  }

  writeBeat(state.tasks.length, Boolean(opts.webhook), errors[0] ?? null);
  // Windows 上文件被谁捏着就删不掉：每轮用完就关，别让 long-running 值班把 db 攥一辈子。
  db.close();
  return { alerts: alerts.length, tasks: state.tasks.length, errors };
}

/** 采样下限：15 秒一行/卡，24 小时约 5760 行，够看趋势又不把磁盘当草稿纸。 */
export const SAMPLE_INTERVAL_MS = 15_000;
export const SAMPLE_RETENTION_MS = 24 * 60 * 60_000;

let lastSampleAt = 0;
let lastPruneAt = 0;

export function recordSamples(
  db: ReturnType<typeof openStore>,
  gpus: { index: number; util: number | null; vram_used_mb: number | null; vram_total_mb: number | null }[],
  now: number,
  force = false,
): boolean {
  if (!force && now - lastSampleAt < SAMPLE_INTERVAL_MS) return false;
  lastSampleAt = now;
  insertSamples(
    db,
    gpus.map((g) => ({
      at: now,
      gpu: g.index,
      util: g.util,
      used_mb: g.vram_used_mb,
      total_mb: g.vram_total_mb,
    })),
  );
  if (now - lastPruneAt >= 60 * 60_000) {
    lastPruneAt = now;
    pruneSamples(db, now - SAMPLE_RETENTION_MS);
  }
  return true;
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

/**
 * 值班进程自己出事时留下的证据：写进 logs/daemon-crash-*.log，doctor --bundle 会一起带走。
 * 不写就没有现场，用户只能说"它退出了"，我们只能说"不知道"。
 */
export function writeCrashLog(err: unknown, where: string, now = Date.now()): string | null {
  try {
    const dir = join(stateDir(), "logs");
    mkdirSync(dir, { recursive: true });
    const stampText = new Date(now).toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `daemon-crash-${stampText}.log`);
    const body = [
      `时间：${new Date(now).toISOString()}`,
      `位置：${where}`,
      `版本：${VERSION}`,
      "",
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    ].join("\n");
    writeFileSync(path, body, "utf8");
    return path;
  } catch {
    return null;
  }
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
    process.on("uncaughtException", (err) => {
      writeCrashLog(err, "uncaughtException");
      process.exit(1);
    });
    process.on("unhandledRejection", (err) => {
      writeCrashLog(err, "unhandledRejection");
      process.exit(1);
    });
  }

  try {
    if (!opts.quiet) {
      console.log(`值班开始：每 ${Math.round(interval / 1000)} 秒看一次${opts.webhook ? "，异常推送到 webhook" : ""}`);
    }
    let badRounds = 0;
    for (;;) {
      try {
        await tick({ webhook: opts.webhook, quiet: opts.quiet });
        badRounds = 0;
      } catch (err) {
        // 一轮采集炸了不该让值班停摆：记下来，下一轮接着看。连续 5 轮都炸说明环境坏了，退出留现场。
        badRounds++;
        const path = writeCrashLog(err, `tick 第 ${badRounds} 次失败`);
        if (!opts.quiet) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`这一轮出错了（连续 ${badRounds} 次）：${detail}${path ? ` 记录：${path}` : ""}`);
        }
        if (badRounds >= 5) return 1;
      }
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
