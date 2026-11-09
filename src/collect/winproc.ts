// Windows 进程层：pid → 命令行 / 父子关系 / 是否活着。
// 只用于两件事：判断我们起的任务还在不在，以及把 GPU 上的 pid 归到某个任务。
// 拿不到就说拿不到（跨用户进程的 CommandLine 是 NULL），不猜。

import { exec, IS_WIN, type ExecResult } from "./exec";

export type ProcessInfo = {
  pid: number;
  ppid: number;
  name: string;
  command: string | null;
};

// 服务账号（NetworkService）跑起来时 PATH 未必和交互式登录一样，
// 所以系统工具一律用绝对路径找，不赌 PATH。
const SYS_ROOT = process.env.SystemRoot || process.env.windir || "C:\\Windows";
const POWERSHELL = `${SYS_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const TASKLIST = `${SYS_ROOT}\\System32\\tasklist.exe`;

let cache: { at: number; procs: ProcessInfo[]; degraded: string | null } | null = null;
const CACHE_MS = 4000;

export function parseCimJson(raw: string): ProcessInfo[] {
  const text = raw.trim();
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : [data];
  const out: ProcessInfo[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const pid = Number(row.ProcessId);
    if (!Number.isFinite(pid)) continue;
    out.push({
      pid,
      ppid: Number(row.ParentProcessId) || 0,
      name: String(row.Name ?? ""),
      command: row.CommandLine ? String(row.CommandLine) : null,
    });
  }
  return out;
}

export function parseGetProcessJson(raw: string): ProcessInfo[] {
  const text = raw.trim();
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : [data];
  const out: ProcessInfo[] = [];
  for (const row of rows) {
    const o = row as Record<string, unknown>;
    const pid = Number(o.Id);
    const name = typeof o.ProcessName === "string" ? o.ProcessName : "";
    if (!Number.isFinite(pid) || pid <= 0) continue;
    out.push({ pid, ppid: 0, name, command: null });
  }
  return out;
}

export function parseTasklist(raw: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const f = line.split('","').map((s) => s.replace(/^"|"$/g, ""));
    if (f.length < 2) continue;
    const pid = Number(f[1]);
    if (!Number.isFinite(pid)) continue;
    out.push({ pid, ppid: 0, name: f[0], command: null });
  }
  return out;
}

/** CIM 一次枚举全部进程（约 0.3–2s），失败回退 tasklist（无命令行）。 */
export async function listProcesses(opts: { refresh?: boolean; timeoutMs?: number } = {}): Promise<{
  procs: ProcessInfo[];
  degraded: string | null;
}> {
  if (!IS_WIN) return { procs: [], degraded: "非 Windows 平台，进程层不可用" };
  if (!opts.refresh && cache && Date.now() - cache.at < CACHE_MS) {
    return { procs: cache.procs, degraded: cache.degraded };
  }

  // 三级降级：CIM（有命令行和父进程）→ Get-Process（只有名字）→ tasklist（只有名字）。
  // 实测某台 Win11 25H2 上 tasklist 会一直不回（4.5s 被杀、0 字节），CIM 也超时，
  // 但 Get-Process 是 .NET 自己的进程枚举，不碰 WMI，能在服务账号下正常返回。
  const timeoutMs = opts.timeoutMs ?? 8000;
  let procs: ProcessInfo[] = [];
  let degraded: string | null = null;

  const cim = await exec(
    [
      POWERSHELL,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ],
    { timeoutMs: Math.min(timeoutMs, 6000) },
  );
  if (cim.code === 0 && cim.stdout.trim()) procs = parseCimJson(cim.stdout);
  if (procs.length > 0) {
    cache = { at: Date.now(), procs, degraded: null };
    return { procs, degraded: null };
  }
  const cimReason = why(cim, Math.min(timeoutMs, 6000));

  const gp = await exec(
    [
      POWERSHELL,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Process | Select-Object Id,ProcessName | ConvertTo-Json -Compress",
    ],
    { timeoutMs: Math.min(timeoutMs, 6000) },
  );
  if (gp.code === 0 && gp.stdout.trim()) procs = parseGetProcessJson(gp.stdout);
  if (procs.length > 0) {
    degraded = `只有进程名，命令行为空（CIM ${cimReason}）`;
    cache = { at: Date.now(), procs, degraded };
    return { procs, degraded };
  }
  const gpReason = why(gp, Math.min(timeoutMs, 6000));

  const tl = await exec([TASKLIST, "/FO", "CSV", "/NH"], { timeoutMs: 5000 });
  if (tl.code === 0) procs = parseTasklist(tl.stdout);
  degraded = procs.length
    ? `只有进程名，命令行为空（CIM ${cimReason}；Get-Process ${gpReason}）`
    : `进程层不可用（CIM ${cimReason}；Get-Process ${gpReason}；tasklist ${why(tl, 5000)}）`;

  cache = { at: Date.now(), procs, degraded };
  return { procs, degraded };
}

/** 说清一次采集为什么没成：超时 / 退出码 / spawn 都没起来。 */
function why(r: ExecResult, timeoutMs: number): string {
  if (r.timedOut) return `超时 ${Math.round(timeoutMs / 1000)}s`;
  if (r.code === -1) {
    const e = (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? "";
    return `起不来${e ? `：${e.slice(0, 120)}` : ""}`;
  }
  const e = (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? "";
  return `退出码 ${r.code}${e ? `：${e.slice(0, 120)}` : ""}（${r.ms}ms）`;
}

export function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** root 自己 + 它的所有子孙（BFS）。用来把 GPU 上的 pid 认回任务。 */
export function descendants(rootPid: number, procs: ProcessInfo[]): number[] {
  const childrenOf = new Map<number, number[]>();
  for (const p of procs) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid)!.push(p.pid);
  }
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
}
