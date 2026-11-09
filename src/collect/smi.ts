// nvidia-smi 这条外部命令的唯一入口。
//
// 为什么要单独一层：这台机器上的 Windows 节点没有 NVIDIA 显卡，门禁永远读不到真卡。
// 把命令解析抽出来，就可以用 GPULEASE_SMI 指到一份"假 nvidia-smi"，
// 从而在真 Windows 上验完整的解析、归属、判定、面板路径——除了驱动本身。

import { exec, type ExecResult } from "./exec";

const SMI_FALLBACK = `${process.env.ProgramFiles ?? "C:\\Program Files"}\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe`;

/** GPULEASE_SMI 存在时用它（可带空格分隔的参数），否则走 nvidia-smi。 */
export function smiCommand(): { cmd: string[]; fake: boolean } {
  const raw = (process.env.GPULEASE_SMI ?? "").trim();
  if (raw) {
    const parts = raw.split(/\s+/).filter(Boolean);
    return { cmd: parts, fake: true };
  }
  return { cmd: ["nvidia-smi"], fake: false };
}

/** 跑一次 nvidia-smi。PATH 找不到时再试驱动默认安装位置。 */
export async function runSmi(args: string[], timeoutMs: number): Promise<ExecResult> {
  const { cmd, fake } = smiCommand();
  const first = await exec([...cmd, ...args], { timeoutMs });
  if (first.code !== -1 || fake) return first;
  return exec([SMI_FALLBACK, ...args], { timeoutMs });
}

/** 给 doctor / 日志用：现在读的是真驱动还是替身。 */
export function smiLabel(): string {
  const { cmd, fake } = smiCommand();
  return fake ? `替身（GPULEASE_SMI=${cmd.join(" ")}）` : cmd[0];
}
