// 面板文字的唯一样板：ls 和 watch 用同一套行，避免两个入口说两种话。
// 每行只回答三件事：哪张卡、在跑什么、正常吗。

import type { PanelState, TaskView } from "./state";
import { humanDuration } from "./rules";
import { humanEta } from "./progress";
import type { Gpu } from "./types";
import { shortSession } from "./session";
import { summarizeSessions, type SessionSummary } from "./sessions";

export const VERDICT_LABEL: Record<string, string> = {
  ok: "正常",
  slow: "偏慢",
  suspect: "可疑",
  stalled: "卡住",
  failed: "失败",
  lost: "丢失",
  unknown: "未知",
};

export type RenderOptions = {
  color: boolean;
  width?: number;
};

const C = {
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
};

function paint(text: string, code: string, on: boolean): string {
  return on ? `${code}${text}${C.reset}` : text;
}

export function verdictColor(verdict: string): string {
  switch (verdict) {
    case "failed":
    case "lost":
      return C.red;
    case "stalled":
    case "suspect":
      return C.yellow;
    case "slow":
      return C.yellow;
    case "ok":
      return C.green;
    default:
      return C.dim;
  }
}

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * 把一串 0–100 的数压成一行方块，给人看趋势。
 * 缺数据的段留空格——宁可断一截，也不拿相邻的值去填。
 */
export function sparkline(values: (number | null)[], cells = 24): string {
  if (!values.length) return " ".repeat(cells);
  const per = values.length / cells;
  let out = "";
  for (let i = 0; i < cells; i++) {
    const start = Math.floor(i * per);
    const end = Math.max(start + 1, Math.floor((i + 1) * per));
    const slice = values.slice(start, end).filter((v): v is number => v !== null && Number.isFinite(v));
    if (!slice.length) {
      out += " ";
      continue;
    }
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    const idx = Math.max(0, Math.min(SPARK.length - 1, Math.round((avg / 100) * (SPARK.length - 1))));
    out += SPARK[idx];
  }
  return out;
}

export function bar(used: number | null, total: number | null, cells = 10): string {
  if (!total || used === null) return "░".repeat(cells);
  const ratio = Math.max(0, Math.min(1, used / total));
  const filled = Math.round(ratio * cells);
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

function gb(mb: number | null): string {
  return mb === null ? "?" : (mb / 1024).toFixed(1);
}

function gpuLine(gpu: Gpu, color: boolean): string {
  const mem = `${gb(gpu.vram_used_mb)}/${gb(gpu.vram_total_mb)} GB`;
  const util = gpu.util === null ? "?" : `${Math.round(gpu.util)}%`;
  const temp = gpu.temp_c === null ? "" : ` · ${Math.round(gpu.temp_c)}°C`;
  const power = gpu.power_w === null ? "" : ` · ${Math.round(gpu.power_w)}W`;
  return [
    paint(`#${gpu.index}`, C.bold, color),
    gpu.name,
    paint(bar(gpu.vram_used_mb, gpu.vram_total_mb), gpu.vram_used_mb && gpu.vram_total_mb && gpu.vram_used_mb / gpu.vram_total_mb > 0.9 ? C.red : C.cyan, color),
    mem,
    `GPU ${util}${temp}${power}`,
  ].join("  ");
}

export function taskLine(task: TaskView, color: boolean): string {
  const label = VERDICT_LABEL[task.verdict] ?? task.verdict;
  const quiet = (Date.now() - task.since) / 1000;
  const since = task.verdict === "ok" ? "" : ` · ${humanDuration(quiet)}前`;
  const pid = task.run.root_pid ? ` pid ${task.run.root_pid}` : "";
  const who = task.run.session ? `  ${paint(`会话 ${shortSession(task.run.session)}`, C.dim, color)}` : "";
  const progress = progressText(task);
  return `${paint(label, verdictColor(task.verdict), color)}  ${task.sentence}${since}${progress}${paint(pid, C.dim, color)}${who}`;
}

/** 进度只报日志里真读到的东西：百分比 + 原始计数 + 剩余时间（有才显示）。 */
export function progressText(task: TaskView): string {
  const p = task.progress;
  if (!p) return "";
  const parts: string[] = [];
  if (p.percent !== null) parts.push(`${p.percent}%`);
  parts.push(p.label);
  if (p.eta_sec !== null) parts.push(`还剩 ${humanEta(p.eta_sec)}`);
  return ` · ${parts.join(" · ")}`;
}

export function renderPanel(state: PanelState, opts: RenderOptions): string[] {
  const lines: string[] = [];
  const color = opts.color;

  if (state.nvidia === "present") {
    for (const gpu of state.gpus) lines.push(gpuLine(gpu, color));
  } else {
    lines.push(paint(state.degraded[0] ?? "显卡不可用", C.dim, color));
    for (const note of state.degraded.slice(1)) lines.push(paint(`· ${note}`, C.dim, color));
  }

  if (state.gpus.length && state.degraded.length) {
    lines.push(paint(`· ${state.degraded[state.degraded.length - 1]}`, C.dim, color));
  }

  lines.push("");

  const running = state.tasks.filter((t) => t.run.ended_at === null);
  if (!running.length) {
    lines.push(paint("没有我们托管的任务在跑", C.dim, color));
  } else {
    for (const task of running) lines.push(taskLine(task, color));
  }

  const ended = state.tasks.filter((t) => t.run.ended_at !== null);
  if (ended.length) {
    lines.push("");
    for (const task of ended.slice(0, 3)) lines.push(paint(taskLine(task, color), C.dim, color));
  }

  if (state.external > 0) {
    lines.push("");
    lines.push(
      paint(`另有 ${state.external} 个进程占了显卡但不是我们起的（看 #进程）`, C.dim, color),
    );
  }

  lines.push(...renderSessionFooter(state, opts));
  return lines;
}

/** 一行式摘要，给 ls 用：先卡，后任务。 */
export function renderList(state: PanelState, opts: RenderOptions): string[] {
  const lines: string[] = [];
  const color = opts.color;
  // ls 也要看一眼卡：多卡机器上"哪张空着"比"哪个任务"更常被问。
  if (state.nvidia === "present" && state.gpus.length) {
    for (const gpu of state.gpus) lines.push(gpuLine(gpu, color));
    lines.push("");
  } else if (state.nvidia !== "present") {
    lines.push(paint(state.degraded[0] ?? "显卡不可用", C.dim, color));
  }
  for (const task of state.tasks) {
    const when = new Date(task.run.started_at).toLocaleString("zh-CN", { hour12: false });
    const label = paint(VERDICT_LABEL[task.verdict] ?? task.verdict, verdictColor(task.verdict), color);
    const who = task.run.session ? `  · 会话 ${shortSession(task.run.session)}` : "";
    lines.push(`${label}  ${when}  ${task.sentence}${who}${progressText(task)}`);
  }
  if (!lines.length) lines.push(paint("还没有记录：用 gpulease run --name 训练 -- python train.py 起一个", C.dim, color));
  if (state.degraded.length) lines.push(paint(`· ${state.degraded[0]}`, C.dim, color));
  lines.push(...renderSessionFooter(state, opts));
  return lines;
}

/** 每个会话一行：在跑几个、排队几个、最差什么样、整体到哪。 */
export function sessionLine(s: SessionSummary, color: boolean): string {
  const bits: string[] = [];
  if (s.running) bits.push(`${s.running} 个在跑`);
  if (s.queued) bits.push(`${s.queued} 个排队`);
  // 还没上卡的会话没有"最差判定"可言，别拿一个空的"正常"充数。
  if (!s.running) {
    return `${paint(s.label, C.bold, color)}  ${bits.join(" · ")}  ${paint("还没上卡", C.dim, color)}`;
  }
  bits.push(`最差 ${VERDICT_LABEL[s.worst] ?? s.worst}`);
  const progress =
    s.progress === null
      ? "进度看不到"
      : `整体 ${s.progress}%（${s.with_progress}/${s.running} 个报进度）`;
  return `${paint(s.label, C.bold, color)}  ${bits.join(" · ")}  ${paint(progress, C.dim, color)}`;
}

/** `sessions` 命令的正文。 */
export function renderSessions(sessions: SessionSummary[], opts: RenderOptions): string[] {
  if (!sessions.length) {
    return [paint("还没有带会话的任务：run --session 名字 或 submit --session 名字 起一个", C.dim, opts.color)];
  }
  return sessions.map((s) => sessionLine(s, opts.color));
}

/** watch / serve / ls 共用的按会话小结：只有一个会话就不占行。 */
export function renderSessionFooter(state: PanelState, opts: RenderOptions): string[] {
  const running = state.tasks.filter((t) => t.run.ended_at === null);
  const sessions = summarizeSessions(
    running.map((t) => ({ session: t.run.session, verdict: t.verdict, percent: t.progress?.percent ?? null })),
  );
  if (sessions.length < 2) return [];
  return ["", paint(`按会话（${sessions.length} 个）`, C.dim, opts.color), ...sessions.map((s) => sessionLine(s, opts.color))];
}
