// 任务归属到"哪个会话"：DSH 会在会话里执行的命令上带 DSH_SESSION_ID，
// 我们照抄一份存进 runs/jobs，面板就能回答"这条 python 是谁的"。
// 优先级：显式 --session > GPULEASE_SESSION > DSH_SESSION_ID > null。不猜 pid，也不编会话。

/** 环境变量里可能带会话号的键，按优先级排。 */
export const SESSION_ENV_KEYS = ["GPULEASE_SESSION", "DSH_SESSION_ID"] as const;

export const SESSION_MAX = 80;

/**
 * 定这条任务的会话归属。flag 给了就用 flag，否则看环境变量；都没有就是 null（不属于任何会话）。
 * 超长截断到 SESSION_MAX，免得有人把整篇日志塞进来。
 */
export function resolveSession(
  flag: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const direct = (flag ?? "").trim();
  if (direct) return direct.slice(0, SESSION_MAX);
  for (const key of SESSION_ENV_KEYS) {
    const raw = (env[key] ?? "").trim();
    if (raw) return raw.slice(0, SESSION_MAX);
  }
  return null;
}

/** 上屏用的短名：`session-7acba1c0-...` → `7acba1c0`。存储仍然是完整的。 */
export function shortSession(session: string | null | undefined, keep = 8): string {
  if (!session) return "";
  const bare = session.startsWith("session-") ? session.slice("session-".length) : session;
  return bare.length > keep ? bare.slice(0, keep) : bare;
}
