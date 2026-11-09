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
    rmSync(home, { recursive: true, force: true });
  }
});
