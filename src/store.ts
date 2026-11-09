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
