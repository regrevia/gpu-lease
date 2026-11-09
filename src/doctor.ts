// doctor：先证明这台机器"能看见什么"，再谈监控。
// 输出必须能直接贴给我看，所以 --json 是主接口，人读版本只是它的排版。

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { exec, IS_WIN } from "./collect/exec";
import { snapshot } from "./collect/nvidia";
import { smiCommand } from "./collect/smi";
import { listProcesses } from "./collect/winproc";
import { stateDir } from "./paths";
import { buildState } from "./state";
import type { DoctorReport, SoakReport } from "./types";
import { probe } from "./collect/probe";

export const VERSION = "0.4.0";

async function eventLogCounts(): Promise<{ tdr_4101: number | null; nvlddmkm: number | null } | null> {
  if (!IS_WIN) return null;
  const q = (filter: string) =>
    `(Get-WinEvent -FilterHashtable @{LogName='System';${filter};StartTime=(Get-Date).AddHours(-24)} -ErrorAction SilentlyContinue | Measure-Object).Count`;
  const cmd = [
    `$a = ${q(" Id=4101")}`,
    `$b = ${q(" ProviderName='nvlddmkm'")}`,
    `"$a,$b"`,
  ].join("; ");
  const res = await exec(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], {
    timeoutMs: 20000,
  });
  if (res.code !== 0) return { tdr_4101: null, nvlddmkm: null };
  const [a, b] = res.stdout.trim().split(",");
  const n = (v: string | undefined) => (v && /^\d+$/.test(v.trim()) ? Number(v) : null);
  return { tdr_4101: n(a), nvlddmkm: n(b) };
}

export async function buildDoctor(opts: { probe?: boolean } = {}): Promise<DoctorReport> {
  const nv = await snapshot(4000);
  const procLayer = await listProcesses({ refresh: true, timeoutMs: 10000 });
  const event = await eventLogCounts();

  const notes: string[] = [];
  if (smiCommand().fake) notes.push("显卡数据来自替身命令（GPULEASE_SMI），不是真驱动");
  if (nv.status === "absent") notes.push("没有 nvidia-smi：这台机器没有 NVIDIA 显卡，或驱动未装");
  if (nv.status === "error") notes.push(`nvidia-smi 报错：${nv.detail ?? ""}`);
  if (nv.gpus.length > 0) {
    notes.push("Windows(WDDM) 不提供按进程显存，只报整卡占用；这是驱动限制，不是采集缺陷");
  }
  if (procLayer.degraded) notes.push(procLayer.degraded);
  const crashes = crashLogs();
  if (crashes.length) {
    notes.push(`值班进程出事 ${crashes.length} 次：${crashes[0].split(/[\\/]/).pop()}（doctor --bundle 会带上全文）`);
  }
  if (event && event.tdr_4101 && event.tdr_4101 > 0) {
    notes.push(`最近 24 小时有 ${event.tdr_4101} 次驱动超时恢复（TDR 4101）`);
  }

  const report: DoctorReport = {
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    nvidia_smi: nv.status,
    nvidia_smi_detail: nv.detail,
    gpus: nv.gpus,
    wmi: procLayer.procs.length === 0 ? "unavailable" : procLayer.degraded ? "partial" : "ok",
    wmi_detail: procLayer.degraded,
    event_log: event,
    store_path: join(stateDir(), "gpulease.db"),
    notes,
  };
  if (opts.probe) report.probe = await probe();
  return report;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * --soak：连续跑若干轮"采集 + 拼状态"，量出值班进程的真实开销。
 * 不算假预算：把自己每 2 秒一轮的 CPU 占和 RSS 打出来，数字难看就是难看。
 */
export async function soak(opts: { seconds?: number; intervalMs?: number } = {}): Promise<SoakReport> {
  const seconds = Math.min(120, Math.max(2, opts.seconds ?? 30));
  const intervalMs = Math.max(200, opts.intervalMs ?? 2000);
  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  let ticks = 0;
  let maxTick = 0;
  let workMs = 0;
  let peakRss = process.memoryUsage().rss;
  let startRss: number | null = null;
  // 至少跑两轮：慢机器上一轮采集可能就吃掉整个窗口，只跑一轮的数字什么都说明不了。
  while (Date.now() - t0 < seconds * 1000 || ticks < 2) {
    const tickStart = Date.now();
    await buildState({ includeEnded: false });
    const dt = Date.now() - tickStart;
    maxTick = Math.max(maxTick, dt);
    workMs += dt;
    ticks++;
    const rssNow = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, rssNow);
    if (startRss === null) startRss = rssNow;
    const rest = intervalMs - (Date.now() - tickStart);
    if (rest > 0) await Bun.sleep(rest);
  }
  const wall = Date.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  const mem = process.memoryUsage();
  return {
    seconds: round1(wall / 1000),
    interval_ms: intervalMs,
    ticks,
    avg_tick_ms: round1(workMs / Math.max(1, ticks)),
    max_tick_ms: maxTick,
    cpu_pct: round1((cpuMs / Math.max(1, wall)) * 100),
    rss_mb: round1(mem.rss / 1048576),
    rss_start_mb: round1((startRss ?? mem.rss) / 1048576),
    rss_growth_mb: round1(((startRss === null ? mem.rss : mem.rss - startRss) / 1048576)),
    peak_rss_mb: round1(peakRss / 1048576),
    heap_mb: round1(mem.heapUsed / 1048576),
  };
}

export function renderSoak(report: SoakReport): string {
  return [
    `浸泡 ${report.seconds} 秒 · ${report.ticks} 轮 · 每 ${Math.round(report.interval_ms / 1000)} 秒一轮（默认值班是 5 秒）`,
    `  每轮耗时：平均 ${report.avg_tick_ms} ms · 最慢 ${report.max_tick_ms} ms`,
    `  CPU：${report.cpu_pct}%（这个间隔下的占比，默认 5 秒一轮会更低）`,
    `  内存：RSS ${report.rss_mb} MB · 峰值 ${report.peak_rss_mb} MB · 首轮 ${report.rss_start_mb} MB · 增长 ${report.rss_growth_mb} MB · 堆 ${report.heap_mb} MB`,
  ].join("\n");
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`gpulease ${report.version} · ${report.platform}/${report.arch}`);
  lines.push("");
  lines.push(`显卡：${report.nvidia_smi === "present" ? `${report.gpus.length} 张` : report.nvidia_smi === "absent" ? "没有 NVIDIA 显卡或驱动" : "读取失败"}`);
  for (const gpu of report.gpus) {
    const mem = gpu.vram_total_mb ? `${gb(gpu.vram_used_mb)}/${gb(gpu.vram_total_mb)} GB` : "显存未知";
    lines.push(`  #${gpu.index} ${gpu.name} · ${mem} · 利用率 ${gpu.util ?? "?"}% · 驱动 ${gpu.driver ?? "?"}`);
  }
  lines.push("");
  const layer = report.wmi === "ok" ? "可读（含命令行）" : report.wmi === "partial" ? "只读到进程名" : "不可读";
  lines.push(`进程层：${layer}${report.wmi_detail ? `（${report.wmi_detail}）` : ""}`);
  if (report.event_log) {
    lines.push(`驱动事件（24 小时）：超时恢复 ${report.event_log.tdr_4101 ?? "?"} 次 · nvlddmkm ${report.event_log.nvlddmkm ?? "?"} 条`);
  }
  if (report.probe?.length) {
    lines.push("");
    lines.push("子进程探针：");
    for (const r of report.probe) {
      const how = r.timedOut ? `超时 ${r.ms}ms` : `code ${r.code} · ${r.ms}ms · ${r.out_bytes} 字节`;
      lines.push(`  ${r.label}：${how}${r.err_head ? ` · ${r.err_head}` : ""}`);
    }
  }
  lines.push(`状态库：${report.store_path}`);
  if (report.notes.length) {
    lines.push("");
    for (const note of report.notes) lines.push(`· ${note}`);
  }
  return lines.join("\n");
}

function gb(mb: number | null): string {
  return mb === null ? "?" : (mb / 1024).toFixed(1);
}

/** --bundle：把诊断信息和最近的日志打包成一个文件，用户直接发给别人。 */
export async function writeBundle(): Promise<string> {
  const report = await buildDoctor();
  const dir = join(stateDir(), "diagnostics");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `gpulease-${stamp}.json`);

  const logs = [
    ...recentCrashTails(3),
    ...recentLogTails(3, 100),
  ];
  writeFileSync(path, JSON.stringify({ report, logs }, null, 2), "utf8");
  return path;
}

function recentLogTails(count: number, lines: number): { name: string; tail: string }[] {
  const dir = join(stateDir(), "logs");
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".log"))
      .sort((a, b) => mtime(join(dir, b)) - mtime(join(dir, a)))
      .slice(0, count);
  } catch {
    return [];
  }
  return names.map((name) => {
    const text = readFileSync(join(dir, name), "utf8").split(/\r?\n/);
    return { name, tail: text.slice(-lines).join("\n") };
  });
}

export function crashLogs(): string[] {
  const dir = join(stateDir(), "logs");
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith("daemon-crash-") && n.endsWith(".log"))
      .map((n) => join(dir, n))
      .sort((a, b) => mtime(b) - mtime(a));
  } catch {
    return [];
  }
}

function recentCrashTails(count: number): { name: string; tail: string }[] {
  return crashLogs().slice(0, count).map((path) => {
    let tail = "";
    try {
      tail = readFileSync(path, "utf8").split(/\r?\n/).slice(-200).join("\n");
    } catch {
      tail = "（读不出来）";
    }
    return { name: path.split(/[\\/]/).pop() ?? "daemon-crash.log", tail };
  });
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
