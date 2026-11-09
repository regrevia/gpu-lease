// 占用率的历史：只回答"刚才这张卡是不是被打满了、现在松下来没有"。
// 数据来自值班进程每 15 秒记的采样；没有采样就说没有，不画一条平的空线。

import { sparkline } from "./render";
import type { Sample } from "./store";

export type Series = {
  spark: string;
  avg: number | null;
  peak: number | null;
  last: number | null;
  points: number;
};

export type GpuHistory = {
  index: number;
  label: string;
  util: Series;
  /** 显存占比（0–100），给人看趋势用 */
  vram_pct: Series;
  vram_used_gb: number | null;
  vram_total_gb: number | null;
};

export type History = {
  minutes: number;
  from: number;
  to: number;
  samples: number;
  /** 真正记了几轮（一轮覆盖所有卡），"采样 N 次"用它，别把每卡一行算成一次 */
  ticks: number;
  gpus: GpuHistory[];
};

export function summarize(values: (number | null)[], cells = 24): Series {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!known.length) {
    return { spark: " ".repeat(cells), avg: null, peak: null, last: null, points: 0 };
  }
  const avg = known.reduce((a, b) => a + b, 0) / known.length;
  const last = values.length ? values[values.length - 1] : null;
  // 数据点比格子少时靠右画：右边是现在，左边空白表示"那会儿还没开始记"，
  // 不是"那会儿一直是这个值"。
  const span = Math.min(cells, values.length);
  const drawn = sparkline(span > 0 ? values.slice(values.length - span) : values, span || 1);
  return {
    spark: " ".repeat(cells - span) + drawn,
    avg: round1(avg),
    peak: round1(Math.max(...known)),
    last: last === null ? null : round1(last),
    points: known.length,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildHistory(
  gpus: { index: number; label: string }[],
  samples: Sample[],
  now: number,
  minutes: number,
): History {
  const from = now - minutes * 60_000;
  const perGpu: GpuHistory[] = gpus.map((gpu) => {
    const rows = samples.filter((s) => s.gpu === gpu.index && s.at >= from);
    const util = rows.map((r) => (r.util === null ? null : clamp(r.util, 0, 100)));
    const vramPct = rows.map((r) =>
      r.used_mb === null || !r.total_mb ? null : clamp((r.used_mb / r.total_mb) * 100, 0, 100),
    );
    const lastRow = rows.length ? rows[rows.length - 1] : null;
    return {
      index: gpu.index,
      label: gpu.label,
      util: summarize(util),
      vram_pct: summarize(vramPct),
      vram_used_gb: lastRow?.used_mb === null || lastRow?.used_mb === undefined ? null : round1(lastRow.used_mb / 1024),
      vram_total_gb: lastRow?.total_mb === null || lastRow?.total_mb === undefined ? null : round1(lastRow.total_mb / 1024),
    };
  });
  const ticks = new Set(samples.map((s) => s.at)).size;
  return { minutes, from, to: now, samples: samples.length, ticks, gpus: perGpu };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function pct(n: number | null): string {
  return n === null ? "—" : `${Math.round(n)}%`;
}

export function renderHistory(history: History): string[] {
  const lines: string[] = [];
  const windowText = `最近 ${history.minutes} 分钟`;
  lines.push(`${windowText}（采样 ${history.ticks} 次）`);
  if (!history.samples) {
    lines.push("还没有采样：值班进程（gpulease daemon）每 15 秒记一次，先让它跑一会儿。");
    return lines;
  }
  for (const gpu of history.gpus) {
    lines.push("");
    lines.push(`GPU ${gpu.index} ${gpu.label}`.trim());
    if (!gpu.util.points) {
      lines.push("  这段时间这张卡没有采样");
      continue;
    }
    lines.push(
      `  占用  ${gpu.util.spark}  平均 ${pct(gpu.util.avg)} · 峰值 ${pct(gpu.util.peak)} · 现在 ${pct(gpu.util.last)}`,
    );
    const total = gpu.vram_total_gb;
    const now = gpu.vram_used_gb;
    const nowText = total !== null && now !== null ? `${now.toFixed(1)} / ${total.toFixed(1)} GB` : "—";
    lines.push(`  显存  ${gpu.vram_pct.spark}  平均 ${pct(gpu.vram_pct.avg)} · 现在 ${nowText}`);
  }
  return lines;
}
