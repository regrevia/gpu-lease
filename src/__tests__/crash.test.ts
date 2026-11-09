import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCrashLog } from "../daemon";
import { crashLogs } from "../doctor";

const home = () => mkdtempSync(join(tmpdir(), "gpulease-crash-"));
const saved = process.env.GPULEASE_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.GPULEASE_HOME;
  else process.env.GPULEASE_HOME = saved;
});

describe("值班崩溃现场", () => {
  test("把时间、位置、堆栈写进 logs/daemon-crash-*.log", () => {
    const dir = home();
    try {
      process.env.GPULEASE_HOME = dir;
      const err = new Error("采集炸了");
      const path = writeCrashLog(err, "tick 第 1 次失败", 1_700_000_000_000);
      expect(path).not.toBeNull();
      const text = readFileSync(path as string, "utf8");
      expect(text).toContain("位置：tick 第 1 次失败");
      expect(text).toContain("采集炸了");
      expect(crashLogs()).toHaveLength(1);
      expect(crashLogs()[0]).toBe(path as string);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("目录不可写时返回 null，不把崩溃变成第二个崩溃", () => {
    process.env.GPULEASE_HOME = "/dev/null/nope";
    expect(writeCrashLog(new Error("x"), "测试")).toBeNull();
  });
});
