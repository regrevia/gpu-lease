import { expect, test } from "bun:test";

import { FAIL_BACKOFF_MS, resetProbeBackoff, shouldSkipProbe } from "../collect/winproc";

test("三层探针全失败后退避：60 秒内不再重试，到点就恢复", () => {
  resetProbeBackoff();
  const t0 = 1_000_000;
  expect(shouldSkipProbe(t0, t0 + FAIL_BACKOFF_MS)).toBe(true);
  expect(shouldSkipProbe(t0 + FAIL_BACKOFF_MS - 1, t0 + FAIL_BACKOFF_MS)).toBe(true);
  expect(shouldSkipProbe(t0 + FAIL_BACKOFF_MS, t0 + FAIL_BACKOFF_MS)).toBe(false);
  expect(shouldSkipProbe(t0 + FAIL_BACKOFF_MS + 1, t0 + FAIL_BACKOFF_MS)).toBe(false);
});

test("退避窗口默认是 60 秒，不是几分钟，也不会是 0", () => {
  expect(FAIL_BACKOFF_MS).toBe(60_000);
  resetProbeBackoff();
  expect(shouldSkipProbe(Date.now())).toBe(false);
});
