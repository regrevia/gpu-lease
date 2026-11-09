// nvidia-smi 采集：只走命令行，不用 NVML。
// 原因写在 docs/03-architecture.md：单文件 exe 不能带原生 addon，
// 而 nvidia-smi 是驱动自带的、永远和驱动同版本。

import type { Gpu, GpuProc } from "../types";
import { exec, type ExecResult } from "./exec";

const GPU_FIELDS =
  "index,uuid,name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw";

export type NvidiaSnapshot = {
  status: "present" | "absent" | "error";
  detail: string | null;
  gpus: Gpu[];
  procs: GpuProc[];
};

/** 极简 CSV 解析：nvidia-smi 用引号包住带逗号的卡名。 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function num(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || /^\[?N\/A\]?$/i.test(v) || /not supported/i.test(v)) return null;
  const n = Number(v.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseGpus(stdout: string): Gpu[] {
  const gpus: Gpu[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 4) continue;
    gpus.push({
      index: num(f[0]) ?? gpus.length,
      uuid: f[1] ?? `GPU-${gpus.length}`,
      name: f[2] ?? "unknown",
      driver: f[3] && f[3] !== "N/A" ? f[3] : null,
      vram_total_mb: num(f[4]),
      vram_used_mb: num(f[5]),
      util: num(f[6]),
      temp_c: num(f[7]),
      power_w: num(f[8]),
      // WDDM 驱动不给按进程显存；这个标志让上层知道"别编数字"。
      per_process_vram_available: false,
    });
  }
  return gpus;
}

export function parseProcs(stdout: string): GpuProc[] {
  const procs: GpuProc[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const pid = num(f[0]);
    if (pid === null) continue;
    procs.push({
      pid,
      name: (f[1] ?? "unknown").replace(/\.exe$/i, ""),
      run_id: null,
      vram_mb: num(f[2]),
    });
  }
  return procs;
}

// 服务账号的 PATH 可能没有 NVIDIA 目录，所以 PATH 找不到时再试驱动装的默认位置。
const SMI_FALLBACK = `${process.env.ProgramFiles ?? "C:\\Program Files"}\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe`;

async function runSmi(args: string[], timeoutMs: number): Promise<ExecResult> {
  const first = await exec(["nvidia-smi", ...args], { timeoutMs });
  if (first.code !== -1) return first;
  return exec([SMI_FALLBACK, ...args], { timeoutMs });
}

export async function snapshot(timeoutMs = 3000): Promise<NvidiaSnapshot> {
  const gpuRes = await runSmi([`--query-gpu=${GPU_FIELDS}`, "--format=csv,noheader,nounits"], timeoutMs);

  if (gpuRes.timedOut) {
    return { status: "error", detail: "nvidia-smi 超时（可能是外接卡断联）", gpus: [], procs: [] };
  }
  if (gpuRes.code !== 0) {
    const noisy = `${gpuRes.stderr}${gpuRes.stdout}`.trim();
    const absent = /not recognized|not found|无法将|不能被识别|no such file/i.test(noisy) || gpuRes.code === -1;
    return {
      status: absent ? "absent" : "error",
      detail: absent ? "未找到 nvidia-smi" : noisy.split(/\r?\n/)[0]?.slice(0, 200) ?? "未知错误",
      gpus: [],
      procs: [],
    };
  }

  const gpus = parseGpus(gpuRes.stdout);
  const procRes = await runSmi(
    ["--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader,nounits"],
    timeoutMs,
  );
  const procs = procRes.code === 0 ? parseProcs(procRes.stdout) : [];
  return { status: "present", detail: null, gpus, procs };
}
