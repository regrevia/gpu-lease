// doctor --acceptance：把「v1.0 验收矩阵」里能机器判的条目当场判掉，判不了的
// 明确写成待真机 + 怎么验。纯函数只吃采样结果，所以能在无卡节点上有测试。
// 设计约束：不把「没卡」说成通过，也不把「查询成功」说成「真负载下正确」。

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type AcceptanceStatus = "proven" | "pending" | "failed";

export type AcceptanceItem = {
  id: string;
  claim: string;
  status: AcceptanceStatus;
  evidence: string;
  /** pending 时写清在真机上怎么把它变成 proven */
  how?: string;
};

export type AcceptanceReport = {
  version: string;
  at: string;
  platform: string;
  machine: {
    nvidia_smi: string;
    gpus: number;
    process_layer: string;
    used_memory: "numbers" | "na" | "unknown";
    tdr_4101: number | null;
    nvlddmkm: number | null;
    history_samples: number;
    tty: boolean;
    single_file_exe: boolean;
  };
  items: AcceptanceItem[];
  counts: { proven: number; pending: number; failed: number };
};

export type AcceptanceInput = {
  version: string;
  platform: string;
  now?: number;
  nvidia_smi: string;
  gpus: { index: number; name: string; memory_total_mb: number; utilization: number | null; temperature: number | null }[];
  process_layer: string;
  /** 按进程显存能不能读出来：numbers=读到数字，na=回 [N/A]，unknown=没查/没卡 */
  used_memory: "numbers" | "na" | "unknown";
  tdr_4101: number | null;
  nvlddmkm: number | null;
  history_samples: number;
  has_tty: boolean;
  single_file_exe: boolean;
};

function pct(used: number, total: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return "—";
  return `${Math.round((used / total) * 100)}%`;
}

export function buildAcceptance(input: AcceptanceInput): AcceptanceReport {
  const now = input.now ?? Date.now();
  const items: AcceptanceItem[] = [];
  const add = (item: AcceptanceItem): void => {
    items.push(item);
  };

  // 脚本模式在非 Windows 上不算"不过"：那是开发机，不是验收对象。
  const exeStatus: AcceptanceStatus = input.single_file_exe ? "proven" : input.platform === "win32" ? "failed" : "pending";
  add({
    id: "1.1",
    claim: "单个 exe，不依赖本机 Node",
    status: exeStatus,
    evidence: input.single_file_exe
      ? `当前进程就是 ${input.platform} 可执行文件`
      : input.platform === "win32"
        ? "在 Windows 上却是脚本模式：这份产物不是验收用的 exe"
        : "开发机脚本模式，不算验收对象",
    how: exeStatus === "proven" ? undefined : "用 release 里的 gpulease.exe 跑这条命令",
  });

  add({
    id: "2.3",
    claim: "没卡的机器诚实降级",
    status: input.nvidia_smi === "absent" ? "proven" : "pending",
    evidence: input.nvidia_smi === "absent" ? "nvidia-smi 不存在，doctor 报 absent 而不是异常栈" : `nvidia-smi: ${input.nvidia_smi}`,
    how: input.nvidia_smi === "absent" ? undefined : "在没装 NVIDIA 驱动的机器上跑一次",
  });

  const first = input.gpus[0];
  const cardsReadable = input.gpus.length > 0 && first !== undefined && first.name !== "" && Number.isFinite(first.memory_total_mb);
  add({
    id: "2.2",
    claim: "真卡上的型号与显存读得回",
    status: cardsReadable ? "proven" : "pending",
    evidence: cardsReadable
      ? `${input.gpus.length} 张卡，0 号 ${first.name} ${Math.round(first.memory_total_mb / 1024)} GB，占用 ${first.utilization ?? "—"}%`
      : "这台机器没有可读的 NVIDIA 卡",
    how: cardsReadable ? undefined : "在有 NVIDIA 卡的机器上跑一次，对照 nvidia-smi",
  });

  add({
    id: "2.5",
    claim: "WDDM 下按进程显存读不到时不猜数字",
    status: input.used_memory === "unknown" ? "pending" : "proven",
    evidence:
      input.used_memory === "numbers"
        ? "按进程显存读到数字"
        : input.used_memory === "na"
          ? "按进程显存恒为 [N/A]：面板显示 —，并说明是驱动限制"
          : "这次没拿到按进程显存的结果",
    how: input.used_memory === "unknown" ? "在有卡机器上跑一次 doctor --acceptance" : undefined,
  });

  add({
    id: "3.6",
    claim: "TDR / nvlddmkm 事件查得到",
    status: input.tdr_4101 === null ? "pending" : "proven",
    evidence:
      input.tdr_4101 === null
        ? "事件日志查询没返回数字（非 Windows 或权限不足）"
        : `最近 24 小时：TDR 4101 ${input.tdr_4101} 次，nvlddmkm ${input.nvlddmkm ?? "?"} 次`,
    how: input.tdr_4101 === null ? "在管理员终端的 Windows 上有卡机器跑一次" : undefined,
  });

  add({
    id: "3.4",
    claim: "真负载下判定不误报",
    status: "pending",
    evidence: "需要真训练一边跑一边看判定；无卡机器无法替它作证",
    how: "跑 gpulease run --name 真实训练 -- python train.py，再开一个窗口看 gpulease ls 的判定是否与日志一致",
  });

  add({
    id: "3.5",
    claim: "eGPU 热拔识别为 lost",
    status: "pending",
    evidence: "需要真的拔线；没有卡的机器验不了",
    how: "eGPU 机器上在任务运行时拔线，看 gpulease ls 是否出现 lost，并看 doctor --bundle 是否带上",
  });

  add({
    id: "4.4",
    claim: "真训练 / 真 ComfyUI 的进度准确",
    status: "pending",
    evidence: "适配器只按日志格式匹配；准确度要靠真实输出比",
    how: "跑一次真训练与一次 ComfyUI 出图，看 ls / watch 里的百分比与日志是否同步",
  });

  add({
    id: "5.5",
    claim: "真机多任务并发时各上一张卡",
    status: "pending",
    evidence: "调度逻辑有测试，真卡上的并发还要看一次",
    how: "同时 submit 两个任务，各要一张卡，看 nvidia-smi 与 gpulease queue 的归属",
  });

  add({
    id: "7.5",
    claim: "交互式 watch 面板（TTY、q 退出、--fast）",
    status: input.has_tty ? "pending" : "pending",
    evidence: input.has_tty ? "当前有 TTY，可以真看一眼" : "当前没有 TTY（服务账号 / 管道），raw mode 无从验",
    how: "在桌面终端里跑 gpulease watch，按 q 看是否干净退出；--fast 看是否约 1 秒刷新",
  });

  add({
    id: "8.5",
    claim: "占用率历史在值班重启后还能读",
    status: input.history_samples > 0 ? "proven" : "pending",
    evidence: input.history_samples > 0 ? `库里已有 ${input.history_samples} 个采样点` : "库里还没有采样点（值班没跑过）",
    how: input.history_samples > 0 ? undefined : "gpulease daemon --once 跑两轮（跨过 15 秒采样间隔）再看 history",
  });

  add({
    id: "8.6",
    claim: "进程归属层在这台机器上可用",
    status: input.process_layer === "ok" ? "proven" : "pending",
    evidence: input.process_layer === "ok" ? "进程枚举后端返回了进程" : `进程枚举：${input.process_layer}`,
    how: input.process_layer === "ok" ? undefined : "跑 gpulease doctor --probe 看 cmd / tasklist / PowerShell 哪条可用",
  });

  const counts = { proven: 0, pending: 0, failed: 0 };
  for (const item of items) counts[item.status] += 1;

  return {
    version: input.version,
    at: new Date(now).toISOString(),
    platform: input.platform,
    machine: {
      nvidia_smi: input.nvidia_smi,
      gpus: input.gpus.length,
      process_layer: input.process_layer,
      used_memory: input.used_memory,
      tdr_4101: input.tdr_4101,
      nvlddmkm: input.nvlddmkm,
      history_samples: input.history_samples,
      tty: input.has_tty,
      single_file_exe: input.single_file_exe,
    },
    items,
    counts,
  };
}

const MARK: Record<AcceptanceStatus, string> = { proven: "通过", pending: "待真机", failed: "不过" };

export function renderAcceptance(report: AcceptanceReport): string[] {
  const lines: string[] = [];
  const m = report.machine;
  lines.push(`验收自检 ${report.version}（${report.platform}）`);
  lines.push(
    `这台机器：显卡 ${m.gpus} 张 · nvidia-smi ${m.nvidia_smi} · 按进程显存 ${m.used_memory} · 进程层 ${m.process_layer}`,
  );
  if (m.tdr_4101 !== null) lines.push(`最近 24 小时：TDR 4101 ${m.tdr_4101} 次 · nvlddmkm ${m.nvlddmkm ?? "?"} 次`);
  lines.push("");
  for (const item of report.items) {
    lines.push(`${item.id}  ${MARK[item.status]}  ${item.claim}`);
    lines.push(`      ${item.evidence}`);
    if (item.status === "pending" && item.how) lines.push(`      怎么验：${item.how}`);
  }
  lines.push("");
  lines.push(`通过 ${report.counts.proven} · 待真机 ${report.counts.pending} · 不过 ${report.counts.failed}`);
  if (report.counts.pending > 0) {
    lines.push("只有标「待真机」的那几条还要在有卡的机器上过一遍；文档见 docs/09-acceptance.md。");
  }
  return lines;
}

/** 把报告落成 acceptance.json + acceptance.md，方便整包贴回来。 */
export function writeAcceptance(report: AcceptanceReport, outDir: string): { json: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, "acceptance.json");
  const md = join(outDir, "acceptance.md");
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(md, `${renderAcceptance(report).join("\n")}\n`, "utf8");
  return { json, md };
}
