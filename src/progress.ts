// 进度：只从任务自己写下的日志尾巴里读，不猜、不编。
// 训练脚本千奇百怪，能可靠读到的只有三样：tqdm 的百分号、进度里的 x/y、下载的 MB/MB。
// 读不到就返回 null，界面显示"进行中"，绝不填一个假百分比。

import { closeSync, openSync, readSync, statSync } from "node:fs";

export type Progress = {
  /** 0–100；拿不到就是 null */
  percent: number | null;
  /** 人话描述，例如 "420/1000 步"、"1.2/3.4 GB" */
  label: string;
  /** 预计剩余秒数；拿不到就是 null */
  eta_sec: number | null;
};

const TAIL_BYTES = 8192;

/** 读文件最后 N 字节。任务跑到一半时日志可能几十 MB，不许整个读进来。 */
export function readTail(path: string, bytes = TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size <= 0) return "";
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size - start));
    fd = openSync(path, "r");
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 关不掉就算了 */
      }
    }
  }
}

const UNIT_MB: Record<string, number> = {
  KB: 1 / 1024,
  KiB: 1 / 1024,
  MB: 1,
  MiB: 1,
  GB: 1024,
  GiB: 1024,
};

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** tqdm 的剩余时间 `00:47` / `01:02:03` */
function parseEta(line: string): number | null {
  const m = line.match(/<\s*(?:(\d+):)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * 从日志尾巴里找最后一条进度。
 * 从后往前扫：任务刚打印的那一行才是当前进度。
 */
export function parseProgress(text: string): Progress | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.startsWith("#")) continue;

    // 1) tqdm / ComfyUI 的进度条： 42%|████▏     | 420/1000 [00:31<00:47,  9.83it/s]
    const bar = line.match(/(\d{1,3})%\|[^|]*\|\s*(\d+)\s*\/\s*(\d+)/);
    if (bar) {
      // 0/0 是 tqdm 还没拿到总数时的样子，这时候没有进度可言。
      if (Number(bar[3]) === 0) continue;
      return {
        percent: clamp(Number(bar[1])),
        label: `${bar[2]}/${bar[3]}`,
        eta_sec: parseEta(line),
      };
    }

    // 2) 下载： 1.2 GiB / 3.4 GiB  、 512MB/2GB
    const dl = line.match(
      /(\d+(?:\.\d+)?)\s*(KiB|KB|MiB|MB|GiB|GB)\s*\/\s*(\d+(?:\.\d+)?)\s*(KiB|KB|MiB|MB|GiB|GB)/i,
    );
    if (dl) {
      const done = Number(dl[1]) * (UNIT_MB[dl[2].toUpperCase()] ?? 1);
      const total = Number(dl[3]) * (UNIT_MB[dl[4].toUpperCase()] ?? 1);
      return {
        percent: total > 0 ? clamp((done / total) * 100) : null,
        label: `${dl[1]}/${dl[3]} ${dl[4].toUpperCase()}`,
        eta_sec: null,
      };
    }

    // 3) epoch： Epoch 3/10
    const epoch = line.match(/\bepoch\s*(\d+)\s*\/\s*(\d+)/i);
    if (epoch) {
      const a = Number(epoch[1]);
      const b = Number(epoch[2]);
      if (b > 0) return { percent: clamp((a / b) * 100), label: `第 ${a}/${b} 轮`, eta_sec: null };
    }

    // 4) 步数： step 420/1000 、 iter 12/34
    const step = line.match(/\b(?:step|iter(?:ation)?)\s*[:=]?\s*(\d+)\s*\/\s*(\d+)/i);
    if (step) {
      const a = Number(step[1]);
      const b = Number(step[2]);
      if (b > 0) return { percent: clamp((a / b) * 100), label: `${a}/${b} 步`, eta_sec: null };
    }
  }
  return null;
}

/** 剩余时间说人话。 */
export function humanEta(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}
