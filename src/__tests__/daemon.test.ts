import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("一轮值班：没有任务时安静，但留下心跳", async () => {
  const home = mkdtempSync(join(tmpdir(), "gpulease-home-"));
  const before = process.env.GPULEASE_HOME;
  process.env.GPULEASE_HOME = home;
  try {
    const { tick, readDaemonStatus } = await import("../daemon");
    const result = await tick({ quiet: true });
    expect(result.alerts).toBe(0);
    expect(result.tasks).toBe(0);
    expect(readDaemonStatus()?.pid).toBe(process.pid);
  } finally {
    if (before === undefined) delete process.env.GPULEASE_HOME;
    else process.env.GPULEASE_HOME = before;
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);

test("没有可用的卡时，排队的活留在队列里并写明在等什么", async () => {
  const home = mkdtempSync(join(tmpdir(), "gpulease-home-"));
  const before = process.env.GPULEASE_HOME;
  process.env.GPULEASE_HOME = home;
  try {
    const store = await import("../store");
    const { tick } = await import("../daemon");
    const db = store.openStore();
    store.insertJob(db, {
      id: "q1",
      name: "训练",
      command: JSON.stringify(["python", "train.py"]),
      cwd: home,
      need_mb: 0,
      priority: 0,
    });
    await tick({ quiet: true });
    const job = store.getJob(db, "q1");
    expect(job?.state).toBe("queued");
    expect(job?.reason).toContain("还没看到可用的卡");
  } finally {
    if (before === undefined) delete process.env.GPULEASE_HOME;
    else process.env.GPULEASE_HOME = before;
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
