// 状态与日志的落点。Windows 上放 %LOCALAPPDATA%，别写进程序目录（通常是 Program Files，无写权限）。

import { homedir } from "node:os";
import { join } from "node:path";
import { IS_WIN } from "./collect/exec";

export function stateDir(env: Record<string, string | undefined> = process.env): string {
  if (IS_WIN) {
    const base = env.LOCALAPPDATA || env.APPDATA || join(homedir(), "AppData", "Local");
    return join(base, "gpulease");
  }
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "gpulease");
}

export function logDir(): string {
  return join(stateDir(), "logs");
}
