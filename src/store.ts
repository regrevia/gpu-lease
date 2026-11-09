// 本地状态：一张 runs 表就够 v0.1 用。
// 不存每 2 秒的采样——那是把面板变成时序数据库的开端，也正是我们不想当的东西。

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Run } from "./types";
import { stateDir } from "./paths";

export type RunRow = Run;

export function openStore(path = `${stateDir()}/gpulease.db`): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 3000");
  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      root_pid INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER,
      pids TEXT NOT NULL DEFAULT '[]',
      gpu_hint INTEGER,
      log_path TEXT,
      last_output_at INTEGER
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC)");
  // 状态变化事件：只记"变坏"和"从坏恢复"，不记每次采样。没有这张表，重启就不知道上次到哪了。
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      detail TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS events_at ON events(at DESC)");
  // 每个任务最后一次判定，给 daemon 做前后对比用；过期的会被清掉，不无限长。
  db.run(`
    CREATE TABLE IF NOT EXISTS verdicts (
      run_id TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      at INTEGER NOT NULL
    )
  `);
  // 队列：submit 入队，daemon 看哪张卡空着就起。状态只有五个，够用。
  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      need_mb INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'queued',
      run_id TEXT,
      gpu INTEGER,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      reason TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, priority DESC, created_at ASC)");
  // 占用率历史：每张卡 15 秒一行、只留 24 小时。不是时序数据库——就三个数（util / 已用 / 总显存），
  // 任务归属仍然从 runs 现算。没有这张表，"刚才是不是被打满了"只能靠记忆。
  db.run(`
    CREATE TABLE IF NOT EXISTS samples (
      at INTEGER NOT NULL,
      gpu INTEGER NOT NULL,
      util INTEGER,
      used_mb INTEGER,
      total_mb INTEGER,
      PRIMARY KEY (at, gpu)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS samples_at ON samples(at DESC)");
  return db;
}

type Row = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  root_pid: number | null;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  pids: string;
  gpu_hint: number | null;
  log_path: string | null;
  last_output_at: number | null;
};

function toRun(row: Row): Run {
  let pids: number[] = [];
  try {
    pids = JSON.parse(row.pids);
  } catch {
    pids = [];
  }
  return { ...row, pids };
}

export function insertRun(db: Database, run: Run): void {
  db.run(
    `INSERT INTO runs (id,name,command,cwd,root_pid,started_at,ended_at,exit_code,pids,gpu_hint,log_path,last_output_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      run.id,
      run.name,
      run.command,
      run.cwd,
      run.root_pid,
      run.started_at,
      run.ended_at,
      run.exit_code,
      JSON.stringify(run.pids),
      run.gpu_hint,
      run.log_path,
      run.last_output_at,
    ],
  );
}

export function updateRun(
  db: Database,
  id: string,
  patch: Partial<Pick<Run, "ended_at" | "exit_code" | "pids" | "last_output_at" | "root_pid">>,
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = ?`);
    values.push(key === "pids" ? JSON.stringify(value) : (value as string | number | null));
  }
  if (!sets.length) return;
  values.push(id);
  db.run(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`, values);
}

export function listRuns(db: Database, limit = 50): Run[] {
  const rows = db
    .query(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
    .all(limit) as Row[];
  return rows.map(toRun);
}

export function getRun(db: Database, id: string): Run | null {
  const row = db.query(`SELECT * FROM runs WHERE id = ?`).get(id) as Row | null;
  return row ? toRun(row) : null;
}

/** 只看还在跑的：我们记录的 pid 里还有活着的。 */
export function activeRuns(db: Database): Run[] {
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  const rows = db
    .query(`SELECT * FROM runs WHERE ended_at IS NULL AND started_at > ? ORDER BY started_at DESC`)
    .all(cutoff) as Row[];
  return rows.map(toRun);
}

export type AlertEvent = {
  id: number;
  at: number;
  run_id: string;
  name: string;
  kind: string;
  message: string;
  delivered: number;
  detail: string | null;
};

export function insertEvent(
  db: Database,
  event: Omit<AlertEvent, "id" | "delivered" | "detail"> & { delivered?: number; detail?: string | null },
): number {
  const row = db
    .query(
      `INSERT INTO events (at,run_id,name,kind,message,delivered,detail) VALUES (?,?,?,?,?,?,?) RETURNING id`,
    )
    .get(
      event.at,
      event.run_id,
      event.name,
      event.kind,
      event.message,
      event.delivered ?? 0,
      event.detail ?? null,
    ) as { id: number };
  return row.id;
}

export function markEventDelivery(db: Database, id: number, ok: boolean, detail: string): void {
  db.run(`UPDATE events SET delivered = ?, detail = ? WHERE id = ?`, [ok ? 1 : 0, detail, id]);
}

export function listEvents(db: Database, limit = 50): AlertEvent[] {
  return db.query(`SELECT * FROM events ORDER BY at DESC LIMIT ?`).all(limit) as AlertEvent[];
}

export function readVerdicts(db: Database): Map<string, string> {
  const rows = db.query(`SELECT run_id, verdict FROM verdicts`).all() as {
    run_id: string;
    verdict: string;
  }[];
  return new Map(rows.map((r) => [r.run_id, r.verdict]));
}

/** 记住这一轮看到的判定；顺手清掉一周没出现过的，免得表一直长。 */
export function writeVerdicts(db: Database, tasks: { run_id: string; verdict: string }[], at = Date.now()): void {
  const stmt = db.query(
    `INSERT INTO verdicts (run_id,verdict,at) VALUES (?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET verdict = excluded.verdict, at = excluded.at`,
  );
  for (const task of tasks) stmt.run(task.run_id, task.verdict, at);
  db.run(`DELETE FROM verdicts WHERE at < ?`, [at - 7 * 24 * 3600_000]);
}

export type JobState = "queued" | "starting" | "running" | "done" | "failed" | "cancelled";

export type Job = {
  id: string;
  name: string;
  /** JSON 数组：argv。存字符串会丢引号，Windows 路径里有空格就完了。 */
  command: string;
  cwd: string;
  need_mb: number;
  priority: number;
  state: JobState;
  run_id: string | null;
  gpu: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  reason: string | null;
};

export function insertJob(
  db: Database,
  job: Pick<Job, "id" | "name" | "command" | "cwd" | "need_mb" | "priority"> & { created_at?: number },
): void {
  db.run(
    `INSERT INTO jobs (id,name,command,cwd,need_mb,priority,created_at) VALUES (?,?,?,?,?,?,?)`,
    [job.id, job.name, job.command, job.cwd, job.need_mb, job.priority, job.created_at ?? Date.now()],
  );
}

export function listJobs(db: Database, limit = 30): Job[] {
  return db.query(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as Job[];
}

export function queuedJobs(db: Database): Job[] {
  return db
    .query(`SELECT * FROM jobs WHERE state = 'queued' ORDER BY priority DESC, created_at ASC`)
    .all() as Job[];
}

export function getJob(db: Database, id: string): Job | null {
  return db.query(`SELECT * FROM jobs WHERE id = ?`).get(id) as Job | null;
}

export function updateJob(db: Database, id: string, patch: Partial<Job>): void {
  const allowed: (keyof Job)[] = [
    "state",
    "run_id",
    "gpu",
    "started_at",
    "ended_at",
    "reason",
  ];
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    sets.push(`${key} = ?`);
    values.push(patch[key] as string | number | null);
  }
  if (!sets.length) return;
  values.push(id);
  db.run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, values);
}

export type Sample = {
  at: number;
  gpu: number;
  util: number | null;
  used_mb: number | null;
  total_mb: number | null;
};

export function insertSamples(db: Database, samples: Sample[]): void {
  if (!samples.length) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO samples (at,gpu,util,used_mb,total_mb) VALUES (?,?,?,?,?)`,
  );
  db.transaction((rows: Sample[]) => {
    for (const row of rows) stmt.run(row.at, row.gpu, row.util, row.used_mb, row.total_mb);
  })(samples);
}

/** 从 since 开始（含）的采样，按时间升序。gpu 为 null 时给所有卡。 */
export function listSamples(db: Database, since: number, gpu?: number | null): Sample[] {
  if (gpu === null || gpu === undefined) {
    return db
      .query(`SELECT * FROM samples WHERE at >= ? ORDER BY at ASC`)
      .all(since) as Sample[];
  }
  return db
    .query(`SELECT * FROM samples WHERE at >= ? AND gpu = ? ORDER BY at ASC`)
    .all(since, gpu) as Sample[];
}

export function pruneSamples(db: Database, before: number): number {
  return db.run(`DELETE FROM samples WHERE at < ?`, [before]).changes;
}
