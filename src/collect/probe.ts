// probe：只回答一个问题——"在这台机器的这个账号下，子进程到底能不能起来、多久回"。
// 采集层失败时最缺的就是这个数据：超时可能是命令慢、可能是 spawn 没起来、可能是管道卡住。

import { exec, type ExecResult } from "./exec";

export type ProbeRow = {
  label: string;
  cmd: string;
  code: number;
  timedOut: boolean;
  ms: number;
  out_bytes: number;
  err_head: string;
};

const SYS_ROOT = process.env.SystemRoot || process.env.windir || "C:\\Windows";

const CASES: { label: string; cmd: string[] }[] = [
  { label: "cmd 内建", cmd: ["cmd", "/c", "echo probe"] },
  { label: "tasklist（PATH）", cmd: ["tasklist", "/FO", "CSV", "/NH"] },
  { label: "tasklist（绝对）", cmd: [`${SYS_ROOT}\\System32\\tasklist.exe`, "/FO", "CSV", "/NH"] },
  { label: "powershell（绝对）", cmd: [`${SYS_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, "-NoProfile", "-NonInteractive", "-Command", "Write-Output probe"] },
  { label: "wmic", cmd: ["wmic", "process", "get", "ProcessId,ParentProcessId", "/format:csv"] },
];

function row(label: string, cmd: string[], r: ExecResult): ProbeRow {
  return {
    label,
    cmd: cmd.join(" "),
    code: r.code,
    timedOut: r.timedOut,
    ms: r.ms,
    out_bytes: r.stdout.length,
    err_head: (r.stderr || r.stdout).trim().split(/\r?\n/)[0]?.slice(0, 160) ?? "",
  };
}

export async function probe(timeoutMs = 4000): Promise<ProbeRow[]> {
  const out: ProbeRow[] = [];
  for (const c of CASES) {
    out.push(row(c.label, c.cmd, await exec(c.cmd, { timeoutMs })));
  }
  return out;
}

export function renderProbe(rows: ProbeRow[]): string {
  return rows
    .map((r) => `${r.label}: ${r.timedOut ? `超时 ${r.ms}ms` : `code ${r.code} · ${r.ms}ms · ${r.out_bytes} 字节`}${r.err_head ? ` · ${r.err_head}` : ""}`)
    .join("\n");
}
