import { describe, expect, test } from "bun:test";
import { humanEta, parseProgress, readTail } from "../progress";

describe("从日志尾巴里读进度", () => {
  test("tqdm 的进度条", () => {
    const p = parseProgress("epoch 1:  42%|████▏     | 420/1000 [00:31<00:47,  9.83it/s]");
    expect(p).not.toBeNull();
    expect(p!.percent).toBe(42);
    expect(p!.label).toBe("420/1000");
    expect(p!.eta_sec).toBe(47);
  });

  test("tqdm 带小时", () => {
    const p = parseProgress(" 3%|▎         | 300/10000 [01:02:03<04:05:06,  1.0it/s]");
    expect(p!.eta_sec).toBe(4 * 3600 + 5 * 60 + 6);
  });

  test("最后一行才算数：旧进度不覆盖新进度", () => {
    const text = ["10%|█         | 10/100", "50%|█████     | 50/100"].join("\n");
    expect(parseProgress(text)!.percent).toBe(50);
  });

  test("下载的大小进度", () => {
    const p = parseProgress("downloading model.safetensors: 1.2 GiB / 3.4 GiB");
    expect(p!.percent).toBe(35);
    expect(p!.label).toBe("1.2/3.4 GIB");
    expect(p!.eta_sec).toBeNull();
  });

  test("epoch 进度", () => {
    const p = parseProgress("Epoch 3/10 done, loss=0.1234");
    expect(p!.percent).toBe(30);
    expect(p!.label).toBe("第 3/10 轮");
  });

  test("step 进度", () => {
    const p = parseProgress("step 420/1000 loss=0.4");
    expect(p!.percent).toBe(42);
    expect(p!.label).toBe("420/1000 步");
  });

  test("普通日志不算进度，宁可不显示也不编", () => {
    expect(parseProgress("loading checkpoint shards: 100%")).toBeNull();
    expect(parseProgress("loss=0.423 lr=1e-4")).toBeNull();
    expect(parseProgress("")).toBeNull();
    expect(parseProgress("# gpulease run r1 · 假训练")).toBeNull();
  });

  test("超过 100% 或分母为 0 不炸", () => {
    expect(parseProgress("120%|███| 12/10")!.percent).toBe(100);
    expect(parseProgress("0%| | 0/0")).toBeNull();
  });

  test("剩余时间说人话", () => {
    expect(humanEta(47)).toBe("47 秒");
    expect(humanEta(600)).toBe("10 分钟");
    expect(humanEta(3900)).toBe("1 小时 5 分");
    expect(humanEta(7200)).toBe("2 小时");
  });

  test("日志不存在时返回空串，不抛", () => {
    expect(readTail("/definitely/not/here.log")).toBe("");
  });
});
