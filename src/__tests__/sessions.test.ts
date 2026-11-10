import { describe, expect, test } from "bun:test";
import { summarizeSessions } from "../sessions";

describe("会话汇总", () => {
  test("按会话分堆：在跑几个、排队几个、最差判定", () => {
    const rows = summarizeSessions(
      [
        { session: "session-aaaaaaaaaaaa", verdict: "ok", percent: null },
        { session: "session-aaaaaaaaaaaa", verdict: "slow", percent: null },
        { session: "session-bbbbbbbbbbbb", verdict: "stalled", percent: null },
      ],
      [
        { session: "session-bbbbbbbbbbbb", state: "queued" },
        { session: "session-bbbbbbbbbbbb", state: "running" },
        { session: "session-cccccccccccc", state: "done" },
      ],
    );
    const a = rows.find((r) => r.session === "session-aaaaaaaaaaaa")!;
    expect(a.running).toBe(2);
    expect(a.queued).toBe(0);
    expect(a.worst).toBe("slow");
    expect(a.label).toBe("aaaaaaaa");

    const b = rows.find((r) => r.session === "session-bbbbbbbbbbbb")!;
    expect(b.running).toBe(1);
    expect(b.queued).toBe(1); // 只有 queued / starting 算排队，running 不是
    expect(b.worst).toBe("stalled");

    // done 的活不进汇总：会话 c 不会凭空多一行
    expect(rows.find((r) => r.session === "session-cccccccccccc")).toBeUndefined();
  });

  test("整体进度只平均报上来百分比的那些任务", () => {
    const rows = summarizeSessions([
      { session: "s1", verdict: "ok", percent: 20 },
      { session: "s1", verdict: "ok", percent: 60 },
      { session: "s1", verdict: "ok", percent: null },
    ]);
    expect(rows[0].progress).toBe(40);
    expect(rows[0].with_progress).toBe(2);
    expect(rows[0].running).toBe(3);
  });

  test("一条百分比都没报时进度是 null，不拿任务数编数字", () => {
    const rows = summarizeSessions([{ session: "s1", verdict: "ok", percent: null }]);
    expect(rows[0].progress).toBeNull();
    expect(rows[0].with_progress).toBe(0);
  });

  test("没有会话号的任务归到「未标会话」一行", () => {
    const rows = summarizeSessions([{ session: null, verdict: "ok", percent: null }]);
    expect(rows[0].session).toBeNull();
    expect(rows[0].label).toBe("未标会话");
  });

  test("排序：在跑多的在前，其次排队多的，再按最差判定", () => {
    const rows = summarizeSessions(
      [
        { session: "few", verdict: "ok", percent: null },
        { session: "many", verdict: "ok", percent: null },
        { session: "many", verdict: "ok", percent: null },
        { session: "bad", verdict: "lost", percent: null },
      ],
      [{ session: "queued", state: "queued" }],
    );
    expect(rows.map((r) => r.session)).toEqual(["many", "bad", "few", "queued"]);
  });
});
