// 会话归属：这条任务是谁的。想到的顺序是显式 flag、GPULEASE_SESSION、DSH_SESSION_ID。
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { resolveSession, shortSession } from "../session";
import { getRun, insertJob, insertRun, listJobs, openStore } from "../store";
import type { Run } from "../types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1",
    name: "训练",
    command: "python train.py",
    cwd: "/tmp",
    root_pid: 123,
    started_at: 1_700_000_000_000,
    ended_at: null,
    exit_code: null,
    pids: [123],
    gpu_hint: 0,
    log_path: null,
    last_output_at: 1_700_000_000_000,
    session: null,
    ...over,
  };
}

test("会话归属：--session 优先，其次 GPULEASE_SESSION，最后 DSH_SESSION_ID", () => {
  const env = { GPULEASE_SESSION: "sess-env", DSH_SESSION_ID: "session-dsh" };
  expect(resolveSession("sess-flag", env)).toBe("sess-flag");
  expect(resolveSession(null, env)).toBe("sess-env");
  expect(resolveSession(null, { DSH_SESSION_ID: "session-dsh" })).toBe("session-dsh");
  expect(resolveSession(null, {})).toBeNull();
  expect(resolveSession(undefined, { GPULEASE_SESSION: "  " })).toBeNull();
});

test("会话归属：去掉两头空白，超长截断到 80", () => {
  expect(resolveSession("  sess-a  ", {})).toBe("sess-a");
  expect(resolveSession("x".repeat(120), {})?.length).toBe(80);
});

test("上屏短名：去掉 session- 前缀，只留前 8 位", () => {
  expect(shortSession("session-7acba1c0-4898-41a1-9f36-27c6f780a59f")).toBe("7acba1c0");
  expect(shortSession("sess-abc")).toBe("sess-abc");
  expect(shortSession(null)).toBe("");
});

test("run 落库带会话，读回来还在", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpulease-session-"));
  dirs.push(dir);
  const db = openStore(join(dir, "g.db"));
  insertRun(db, run({ session: "session-abcdef12-1111" }));
  expect(getRun(db, "r1")?.session).toBe("session-abcdef12-1111");
  db.close();
});

test("job 落库带会话，队列里看得到", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpulease-session-"));
  dirs.push(dir);
  const db = openStore(join(dir, "g.db"));
  insertJob(db, {
    id: "q1",
    name: "排队",
    command: JSON.stringify(["python", "x.py"]),
    cwd: "/tmp",
    need_mb: 0,
    priority: 0,
    session: "session-deadbeef",
  });
  expect(listJobs(db)[0]?.session).toBe("session-deadbeef");
  db.close();
});

test("老库没有 session 列：打开时补上，旧记录还在", () => {
  const dir = mkdtempSync(join(tmpdir(), "gpulease-session-"));
  dirs.push(dir);
  const path = join(dir, "old.db");
  const old = new Database(path, { create: true });
  old.run(`CREATE TABLE runs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL,
    root_pid INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER,
    pids TEXT NOT NULL DEFAULT '[]', gpu_hint INTEGER, log_path TEXT, last_output_at INTEGER
  )`);
  old.run(
    `INSERT INTO runs (id,name,command,cwd,started_at,pids) VALUES ('r-old','旧任务','python old.py','C:\\',1,'[]')`,
  );
  old.run(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL,
    need_mb INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'queued', run_id TEXT, gpu INTEGER,
    created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, reason TEXT
  )`);
  old.close();

  const db = openStore(path);
  const cols = (db.query(`PRAGMA table_info(runs)`).all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("session");
  expect(getRun(db, "r-old")?.session).toBeNull();
  insertRun(db, run({ id: "r-new", session: "session-new" }));
  expect(getRun(db, "r-new")?.session).toBe("session-new");
  db.close();
});
