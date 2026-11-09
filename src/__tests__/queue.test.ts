import { describe, expect, test } from "bun:test";
import { freeMb, occupiesSlot, place, stuckJobs, type Card } from "../queue";

const card = (index: number, total: number | null, used: number | null, util = 5): Card => ({
  index,
  label: `GPU ${index}`,
  usable: true,
  total_mb: total,
  used_mb: used,
  util,
});

const job = (id: string, need_mb = 0, created_at = 0) => ({ id, name: id, need_mb, created_at });

describe("选卡", () => {
  test("一张空卡：第一个活上卡", () => {
    const [a] = place([job("a", 12_000)], [card(0, 24_000, 0)]);
    expect(a.gpu).toBe(0);
    expect(a.reason).toContain("空闲");
  });

  test("余量不够就等，理由说明差多少", () => {
    const [a] = place([job("a", 12_000)], [card(0, 24_000, 20_000)]);
    expect(a.gpu).toBeNull();
    expect(a.reason).toContain("余量");
  });

  test("默认一张卡只放一个，第二个去另一张空的", () => {
    const out = place([job("a"), job("b")], [card(0, 24_000, 0), card(1, 8_000, 0)]);
    expect(out.map((x) => x.gpu)).toEqual([0, 1]);
  });

  test("两卡都占着：等，不说能上", () => {
    const out = place([job("a")], [card(0, 24_000, 100), card(1, 24_000, 100)], new Map([[0, 1], [1, 1]]));
    expect(out[0].gpu).toBeNull();
    expect(out[0].reason).toContain("已有任务");
  });

  test("余量看不到（WDDM）：只有没任务的卡才敢放，并说清楚", () => {
    const out = place([job("a", 8_000)], [card(0, 24_000, null)], new Map());
    expect(out[0].gpu).toBe(0);
    expect(out[0].reason).toContain("余量看不到");

    const busy = place([job("a", 8_000)], [card(0, 24_000, null)], new Map([[0, 1]]));
    expect(busy[0].gpu).toBeNull();
  });

  test("没有可用的卡：等，不硬塞", () => {
    const out = place([job("a")], []);
    expect(out[0].gpu).toBeNull();
    expect(out[0].reason).toContain("还没看到可用的卡");
  });

  test("两张都放得下：选余量大的，并保留未占用的那张给后面的活", () => {
    const out = place([job("a", 8_000), job("b", 8_000)], [card(0, 24_000, 0), card(1, 16_000, 0)]);
    expect(out.map((x) => x.gpu)).toEqual([0, 1]);
  });

  test("安全余量算进去：24G 卡剩 11G 放 12G 的活不算放得下", () => {
    const [a] = place([job("a", 12_000)], [card(0, 24_000, 13_000)], new Map(), { headroom_mb: 1024 });
    expect(a.gpu).toBeNull();
    expect(freeMb(card(0, 24_000, 13_000))).toBe(11_000);
  });

  test("顺序按传进来的队列走：先到先上", () => {
    const out = place([job("first"), job("second")], [card(0, 24_000, 0), card(1, 24_000, 0)]);
    expect(out[0].id).toBe("first");
    expect(out[1].id).toBe("second");
  });
});

test("挂掉和断联的任务不再占坑，卡着的照占", () => {
  // 包装进程没了：那张卡可以马上接下一件活，不该为它白等一个轮次。
  expect(occupiesSlot("failed")).toBe(false);
  expect(occupiesSlot("lost")).toBe(false);
  // 还在跑，哪怕慢、哪怕可疑，都占着。
  for (const verdict of ["ok", "slow", "suspect", "stalled", "unknown"]) {
    expect(occupiesSlot(verdict)).toBe(true);
  }
});

test("停在 starting 太久的活要被认出来，刚开始的不算", () => {
  const at = 1_000_000;
  const jobs = [
    { id: "old", name: "卡死", state: "starting", started_at: at - 200_000 },
    { id: "new", name: "刚点着", state: "starting", started_at: at - 5_000 },
    { id: "q", name: "排队中", state: "queued", started_at: null },
    { id: "run", name: "在跑", state: "running", started_at: at - 200_000 },
  ];
  expect(stuckJobs(jobs, at)).toEqual([{ id: "old", name: "卡死" }]);
});
