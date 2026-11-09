import { describe, expect, test } from "bun:test";
import { renderSoak, soak } from "../doctor";

describe("soak", () => {
  test("跑够轮次，给出每轮真实耗时而不是把睡眠算进去", async () => {
    const report = await soak({ seconds: 1, intervalMs: 200 });
    expect(report.ticks).toBeGreaterThanOrEqual(2);
    expect(report.seconds).toBeGreaterThan(0);
    expect(report.avg_tick_ms).toBeLessThan(1000);
    expect(report.max_tick_ms).toBeGreaterThanOrEqual(report.avg_tick_ms);
    expect(report.cpu_pct).toBeGreaterThanOrEqual(0);
    expect(report.rss_mb).toBeGreaterThan(1);
    const text = renderSoak(report);
    expect(text).toContain("每轮耗时");
    expect(text).toContain("RSS");
  }, 30000);
});
