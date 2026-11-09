import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sparkline } from "../render";
import { buildHistory, renderHistory, summarize } from "../history";
import {
  insertSamples,
  listSamples,
  openStore,
  pruneSamples,
  type Sample,
} from "../store";
import { SAMPLE_INTERVAL_MS, SAMPLE_RETENTION_MS, recordSamples } from "../daemon";

const tmp = () => mkdtempSync(join(tmpdir(), "gpulease-history-"));

function sample(at: number, gpu: number, util: number | null, used: number | null, total = 24564): Sample {
  return { at, gpu, util, used_mb: used, total_mb: total };
}

describe("sparkline", () => {
  test("把 0–100 压成固定宽度的方块，缺数据留空格", () => {
    expect(sparkline([], 4)).toBe("    ");
    expect(sparkline([100, 100, 100, 100], 4)).toBe("████");
    expect(sparkline([0, 0, 0, 0], 4)).toBe("▁▁▁▁");
    const mixed = sparkline([0, 50, null, 100], 4);
    expect(mixed).toHaveLength(4);
    expect(mixed[0]).toBe("▁");
    expect(mixed[2]).toBe(" ");
    expect(mixed[3]).toBe("█");
  });

  test("点少于格子时靠右画，左边留白而不是假装一直这么高", () => {
    const s = summarize([100], 8);
    expect(s.spark).toHaveLength(8);
    expect(s.spark.trimStart()).toBe("█");
    expect(s.spark.startsWith("     ")).toBe(true);
  });

  test("稀疏数据会被平均到每个格子里", () => {
    const many = Array.from({ length: 48 }, (_, i) => (i < 24 ? 0 : 100));
    const line = sparkline(many, 2);
    expect(line).toBe("▁█");
  });
});

describe("summarize", () => {
  test("空数据不给平均值，也不给 0 冒充", () => {
    const s = summarize([null, null]);
    expect(s.points).toBe(0);
    expect(s.avg).toBeNull();
    expect(s.peak).toBeNull();
    expect(s.last).toBeNull();
  });

  test("平均值 / 峰值 / 最后一点分别算", () => {
    const s = summarize([20, 80, 40]);
    expect(s.avg).toBe(46.7);
    expect(s.peak).toBe(80);
    expect(s.last).toBe(40);
    expect(s.points).toBe(3);
  });
});

describe("buildHistory", () => {
  const now = 1_700_000_000_000;
  const minute = 60_000;

  test("按卡分开、按窗口裁掉旧数据", () => {
    const samples: Sample[] = [
      sample(now - 40 * minute, 0, 99, 20000), // 窗口外
      sample(now - 10 * minute, 0, 30, 12000),
      sample(now - 5 * minute, 0, 60, 15000),
      sample(now - 10 * minute, 1, 5, 2000),
    ];
    const history = buildHistory(
      [
        { index: 0, label: "RTX 4090" },
        { index: 1, label: "RTX 4060" },
      ],
      samples,
      now,
      30,
    );
    expect(history.samples).toBe(4);
    expect(history.ticks).toBe(3);
    expect(history.gpus[0].util.points).toBe(2);
    expect(history.gpus[0].util.peak).toBe(60);
    expect(history.gpus[0].vram_used_gb).toBe(14.6);
    expect(history.gpus[1].util.points).toBe(1);
  });

  test("显存占比按 已用/总量 算，不拿 util 冒充", () => {
    const history = buildHistory(
      [{ index: 0, label: "卡" }],
      [sample(now - minute, 0, 10, 12282, 24564)],
      now,
      30,
    );
    expect(history.gpus[0].vram_pct.last).toBe(50);
  });

  test("没有采样时每张卡都如实空着", () => {
    const history = buildHistory([{ index: 0, label: "卡" }], [], now, 30);
    expect(history.samples).toBe(0);
    expect(history.gpus[0].util.points).toBe(0);
  });
});

describe("renderHistory", () => {
  test("先说要人做的事，再给趋势", () => {
    const empty = renderHistory(buildHistory([{ index: 0, label: "卡" }], [], Date.now(), 30));
    expect(empty.join("\n")).toContain("还没有采样");
  });

  test("有数据时给出平均/峰值/现在", () => {
    const now = Date.now();
    const lines = renderHistory(
      buildHistory(
        [{ index: 0, label: "RTX 4090" }],
        [sample(now - 60_000, 0, 40, 12282), sample(now, 0, 90, 20000)],
        now,
        30,
      ),
    );
    const text = lines.join("\n");
    expect(text).toContain("GPU 0 RTX 4090");
    expect(text).toContain("峰值 90%");
    expect(text).toContain("19.5 / 24.0 GB");
  });
});

describe("samples 表", () => {
  test("写入、按卡读、按时间裁掉", () => {
    const dir = tmp();
    try {
      const db = openStore(join(dir, "gpulease.db"));
      const now = Date.now();
      insertSamples(db, [sample(now - 1000, 0, 10, 100), sample(now - 900, 1, 20, 200)]);
      expect(listSamples(db, now - 5000)).toHaveLength(2);
      expect(listSamples(db, now - 5000, 1)).toHaveLength(1);
      insertSamples(db, [sample(now, 0, 30, 300)]);
      expect(listSamples(db, now - 5000, 0).map((s) => s.util)).toEqual([10, 30]);
      expect(pruneSamples(db, now - 950)).toBe(1);
      expect(listSamples(db, 0)).toHaveLength(2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recordSamples 按 15 秒节流，force 时照写", () => {
    const dir = tmp();
    try {
      const db = openStore(join(dir, "gpulease.db"));
      const gpus = [{ index: 0, util: 50, vram_used_mb: 1000, vram_total_mb: 2000 }];
      const t0 = 1_700_000_000_000;
      expect(recordSamples(db, gpus, t0, false)).toBe(true);
      expect(recordSamples(db, gpus, t0 + 1000, false)).toBe(false);
      expect(recordSamples(db, gpus, t0 + SAMPLE_INTERVAL_MS, false)).toBe(true);
      expect(listSamples(db, 0)).toHaveLength(2);
      // 超过保留期的那一轮会顺手清旧行
      expect(recordSamples(db, gpus, t0 + SAMPLE_RETENTION_MS + 3_600_000, true)).toBe(true);
      expect(listSamples(db, 0)).toHaveLength(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
