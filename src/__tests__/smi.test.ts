// 用假 nvidia-smi 覆盖真机才有的路径：多卡异型号、单卡、无卡、驱动报错、按进程表读不到。
// 这些用例在无卡的 Windows 节点上同样能跑——门禁因此能验到"有卡时的逻辑"。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { snapshot } from "../collect/nvidia";
import { smiCommand, smiLabel } from "../collect/smi";

const FIXTURE = join(import.meta.dir, "..", "..", "test", "fixture", "smi.ts");
const saved = { ...process.env };

beforeAll(() => {
  process.env.GPULEASE_SMI = `${process.execPath} ${FIXTURE}`;
});

afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

function scenario(name: string): void {
  process.env.GPULEASE_SMI_SCENARIO = name;
}

describe("假 nvidia-smi 注入", () => {
  test("GPULEASE_SMI 生效时认得出来是替身", () => {
    expect(smiCommand().fake).toBe(true);
    expect(smiLabel()).toContain("替身");
  });

  test("双卡异型号：两张卡的显存/利用率分别是自己的，不串味", async () => {
    scenario("two-gpu");
    const nv = await snapshot(4000);
    expect(nv.status).toBe("present");
    expect(nv.gpus.length).toBe(2);
    expect(nv.gpus[0]!.name).toContain("4090");
    expect(nv.gpus[0]!.vram_total_mb).toBe(24564);
    expect(nv.gpus[0]!.util).toBe(97);
    expect(nv.gpus[1]!.name).toContain("4060");
    expect(nv.gpus[1]!.vram_total_mb).toBe(8188);
    expect(nv.gpus[1]!.util).toBe(12);
    expect(nv.gpus[0]!.uuid).not.toBe(nv.gpus[1]!.uuid);
  });

  test("单卡机器不会凭空多出第二张卡", async () => {
    scenario("single");
    const nv = await snapshot(4000);
    expect(nv.gpus.length).toBe(1);
    expect(nv.gpus[0]!.name).toContain("4090");
  });

  test("按进程显存永远是 null（WDDM 不给），不编数字", async () => {
    scenario("two-gpu");
    const nv = await snapshot(4000);
    expect(nv.procs.length).toBe(2);
    for (const p of nv.procs) expect(p.vram_mb).toBeNull();
  });

  test("没有 nvidia-smi：状态是 absent，不是 error", async () => {
    scenario("absent");
    const nv = await snapshot(4000);
    expect(nv.status).toBe("absent");
    expect(nv.detail).toContain("未找到");
  });

  test("驱动连不上：状态是 error，并把驱动原话带出来", async () => {
    scenario("error");
    const nv = await snapshot(4000);
    expect(nv.status).toBe("error");
    expect(nv.detail).toContain("couldn't communicate");
  });

  test("卡在但进程表读不到（断联后常见）：卡数据保留、进程表为空", async () => {
    scenario("lost");
    const nv = await snapshot(4000);
    expect(nv.status).toBe("present");
    expect(nv.gpus.length).toBe(2);
    expect(nv.procs).toEqual([]);
  });

  test("无权限读进程表：不影响整卡读数", async () => {
    scenario("permission");
    const nv = await snapshot(4000);
    expect(nv.status).toBe("present");
    expect(nv.procs).toEqual([]);
  });

  test("nvidia-smi 挂住：超时后给出断联提示，不是静默空值", async () => {
    scenario("timeout");
    const started = Date.now();
    const nv = await snapshot(800);
    expect(nv.status).toBe("error");
    expect(nv.detail).toContain("超时");
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);
});
