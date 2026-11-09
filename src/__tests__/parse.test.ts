// 解析层测试：全部拿真样例跑，不 mock 到断言空气。
// nvidia-smi 的 N/A、带引号的卡名、空输出、Windows 的 used_memory 都是真实遇到过的形状。

import { describe, expect, test } from "bun:test";
import { parseCsvLine, parseGpus, parseProcs } from "../collect/nvidia";
import { parseCimJson, parseTasklist, descendants } from "../collect/winproc";
import { judge, worst, humanDuration } from "../rules";
import { attribute } from "../attribute";
import { parseRunArgs, newRunId } from "../run";
import type { Run } from "../types";

const run = (patch: Partial<Run> = {}): Run => ({
  id: "r1",
  name: "训练",
  command: "python train.py",
  cwd: "C:\\work",
  root_pid: 100,
  started_at: Date.now() - 600_000,
  ended_at: null,
  exit_code: null,
  pids: [100],
  gpu_hint: 0,
  log_path: null,
  last_output_at: Date.now() - 5_000,
  ...patch,
});

describe("nvidia-smi 解析", () => {
  test("正常两卡", () => {
    const gpus = parseGpus(
      [
        "0, GPU-aaaa, NVIDIA GeForce RTX 4090, 566.36, 24564, 8123, 61, 62, 145.5",
        "1, GPU-bbbb, NVIDIA GeForce RTX 3080, 566.36, 10240, 0, 0, 38, 22.1",
      ].join("\n"),
    );
    expect(gpus).toHaveLength(2);
    expect(gpus[0].name).toBe("NVIDIA GeForce RTX 4090");
    expect(gpus[0].vram_used_mb).toBe(8123);
    expect(gpus[1].util).toBe(0);
  });

  test("N/A 变 null，不变成 0", () => {
    const [gpu] = parseGpus("0, GPU-x, Tesla K80, 470.1, 11441, [N/A], [N/A], [N/A], [N/A]");
    expect(gpu.vram_used_mb).toBeNull();
    expect(gpu.util).toBeNull();
    expect(gpu.temp_c).toBeNull();
  });

  test("卡名带逗号用引号包住", () => {
    expect(parseCsvLine('0, GPU-x, "NVIDIA A100, 80GB", 1, 2')).toEqual(["0", "GPU-x", "NVIDIA A100, 80GB", "1", "2"]);
  });

  test("空输出 = 没有卡，不是解析失败", () => {
    expect(parseGpus("")).toEqual([]);
  });

  test("Windows 的 used_memory 是 N/A → vram_mb null", () => {
    const procs = parseProcs("1234, python.exe, N/A\n5678, comfyui.exe, [N/A]");
    expect(procs).toHaveLength(2);
    expect(procs[0].name).toBe("python");
    expect(procs[0].vram_mb).toBeNull();
  });
});

describe("进程层解析", () => {
  test("CIM JSON 单条对象与数组都能吃", () => {
    expect(parseCimJson('{"ProcessId":1,"ParentProcessId":0,"Name":"a.exe","CommandLine":null}')).toHaveLength(1);
    expect(
      parseCimJson('[{"ProcessId":1,"ParentProcessId":0,"Name":"a.exe"},{"ProcessId":2,"ParentProcessId":1,"Name":"b.exe"}]'),
    ).toHaveLength(2);
  });

  test("坏了就返回空，不抛", () => {
    expect(parseCimJson("not json")).toEqual([]);
    expect(parseCimJson("")).toEqual([]);
  });

  test("tasklist CSV 回退能拿到 pid", () => {
    const procs = parseTasklist('"python.exe","1234","Console","1","120,000 K"');
    expect(procs[0]).toMatchObject({ pid: 1234, name: "python.exe" });
  });

  test("子孙树包含 root 自己", () => {
    const procs = [
      { pid: 100, ppid: 1, name: "launcher", command: null },
      { pid: 101, ppid: 100, name: "python", command: null },
      { pid: 102, ppid: 101, name: "worker", command: null },
      { pid: 200, ppid: 1, name: "other", command: null },
    ];
    expect(descendants(100, procs).sort()).toEqual([100, 101, 102]);
  });
});

describe("归属", () => {
  test("认得出自己起的子孙，别人的标 external", () => {
    const procs = [
      { pid: 100, ppid: 1, name: "launcher", command: null },
      { pid: 101, ppid: 100, name: "python", command: null },
      { pid: 900, ppid: 1, name: "other", command: null },
    ];
    const result = attribute(
      [
        { pid: 101, name: "python", run_id: null, vram_mb: null },
        { pid: 900, name: "other", run_id: null, vram_mb: null },
      ],
      [run()],
      procs,
    );
    expect(result.matched).toBe(1);
    expect(result.external).toBe(1);
    expect(result.procs.find((p) => p.pid === 101)?.run_id).toBe("r1");
    expect(result.procs.find((p) => p.pid === 900)?.run_id).toBeNull();
  });

  test("已结束的任务不再认领 pid", () => {
    const result = attribute([{ pid: 101, name: "python", run_id: null, vram_mb: null }], [run({ ended_at: 1, exit_code: 0 })], []);
    expect(result.matched).toBe(0);
  });
});

describe("判定", () => {
  const now = Date.now();

  test("正常在跑", () => {
    const a = judge({ run: run({ started_at: now - 60_000, last_output_at: now - 2_000 }), now, alive: true, lastOutputAt: now - 2_000, gpuStatus: "present" });
    expect(a.verdict).toBe("ok");
    expect(a.sentence).toContain("训练");
  });

  test("退出码 0 = 完成，不是在跑", () => {
    const a = judge({ run: run({ ended_at: now - 1000, exit_code: 0 }), now, alive: false, lastOutputAt: now - 2000, gpuStatus: "present" });
    expect(a.verdict).toBe("ok");
    expect(a.sentence).toContain("已完成");
  });

  test("退出码非 0 = 失败", () => {
    const a = judge({ run: run({ ended_at: now - 1000, exit_code: 137 }), now, alive: false, lastOutputAt: now - 2000, gpuStatus: "present" });
    expect(a.verdict).toBe("failed");
    expect(a.sentence).toContain("137");
  });

  test("进程没了但没退出码 = 丢失（不说失败）", () => {
    const a = judge({ run: run({ started_at: now - 600_000 }), now, alive: false, lastOutputAt: now - 500_000, gpuStatus: "present" });
    expect(a.verdict).toBe("lost");
  });

  test("10 分钟没输出 = 卡住", () => {
    const a = judge({ run: run({ started_at: now - 3_600_000, last_output_at: now - 700_000 }), now, alive: true, lastOutputAt: now - 700_000, gpuStatus: "present" });
    expect(a.verdict).toBe("stalled");
  });

  test("3 分钟没输出 = 偏慢", () => {
    const a = judge({ run: run({ started_at: now - 3_600_000, last_output_at: now - 240_000 }), now, alive: true, lastOutputAt: now - 240_000, gpuStatus: "present" });
    expect(a.verdict).toBe("slow");
  });

  test("卡读不到但任务在跑 = 可疑", () => {
    const a = judge({ run: run({ started_at: now - 60_000 }), now, alive: true, lastOutputAt: now - 2_000, gpuStatus: "error" });
    expect(a.verdict).toBe("suspect");
    expect(a.sentence).toContain("显卡");
  });

  test("刚启动不报警", () => {
    const a = judge({ run: run({ started_at: now - 5_000, last_output_at: now - 5_000 }), now, alive: true, lastOutputAt: now - 5_000, gpuStatus: "present" });
    expect(a.verdict).toBe("ok");
  });

  test("最坏判定优先", () => {
    expect(worst(["ok", "stalled", "slow"])).toBe("stalled");
    expect(worst(["ok", "failed", "stalled"])).toBe("failed");
    expect(worst([])).toBe("ok");
  });
});

describe("run 参数", () => {
  test("-- 之后全是命令", () => {
    const parsed = parseRunArgs(["--name", "出图", "--gpu", "1", "--", "python", "main.py", "--port", "8188"]);
    expect(parsed).toMatchObject({ name: "出图", gpu: 1 });
    if (!("error" in parsed)) expect(parsed.command).toEqual(["python", "main.py", "--port", "8188"]);
  });

  test("缺 name / 缺命令都报人话", () => {
    expect(parseRunArgs(["--", "python"])).toMatchObject({ error: expect.stringContaining("--name") });
    expect(parseRunArgs(["--name", "x"])).toMatchObject({ error: expect.stringContaining("命令") });
  });

  test("run id 不重复", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRunId()));
    expect(ids.size).toBe(200);
  });
});

test("时长说人话", () => {
  expect(humanDuration(8)).toBe("8 秒");
  expect(humanDuration(125)).toBe("2 分钟");
  expect(humanDuration(7300)).toBe("2 小时 2 分钟");
});
