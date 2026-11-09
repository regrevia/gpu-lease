// doctor：先证明这台机器"能看见什么"，再谈监控。
// 输出必须能直接贴给我看，所以 --json 是主接口，人读版本只是它的排版。

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { exec, IS_WIN } from "./collect/exec";
import { snapshot } from "./collect/nvidia";
import { listProcesses } from "./collect/winproc";
import { stateDir } from "./paths";
import type { DoctorReport } from "./types";
import { probe } from "./collect/probe";

export const VERSION = "0.1.0";

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
  if (nv.status === "absent") notes.push("没有 nvidia-smi：这台机器没有 NVIDIA 显卡，或驱动未装");
  if (nv.status === "error") notes.push(`nvidia-smi 报错：${nv.detail ?? ""}`);
  if (nv.gpus.length > 0) {
    notes.push("Windows(WDDM) 不提供按进程显存，只报整卡占用；这是驱动限制，不是采集缺陷");
  }
  if (procLayer.degraded) notes.push(procLayer.degraded);
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
    wmi: procLayer.procs.length > 0 ? "ok" : procLayer.degraded ? "unavailable" : "ok",
    wmi_detail: procLayer.degraded,
    event_log: event,
    store_path: join(stateDir(), "gpulease.db"),
    notes,
  };
  if (opts.probe) report.probe = await probe();
  return report;
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
  lines.push(`进程层：${report.wmi === "ok" ? "可读" : "不可读"}${report.wmi_detail ? `（${report.wmi_detail}）` : ""}`);
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

  const logs = recentLogTails(3, 100);
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

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
