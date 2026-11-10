// run 包装器：任务的归属从这一行命令开始，而不是从猜 pid 开始。
// 用法：gpulease run --name "训练" -- python train.py

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { logDir } from "./paths";
import { insertRun, getJob, openStore, updateJob, updateRun } from "./store";
import { resolveSession } from "./session";

export type RunOptions = {
  name: string;
  gpu: number | null;
  /** 由 daemon 从队列里起的时候带着；手动 run 是 null */
  jobId: string | null;
  /** 显式指定的会话号；null 表示按 GPULEASE_SESSION / DSH_SESSION_ID 走 */
  session: string | null;
  logPath: string | null;
  cwd: string;
  command: string[];
};

export function parseRunArgs(argv: string[]): RunOptions | { error: string } {
  let name: string | null = null;
  let gpu: number | null = null;
  let logPath: string | null = null;
  let jobId: string | null = null;
  let session: string | null = null;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--name" || arg === "-n") {
      name = argv[++i] ?? null;
    } else if (arg === "--gpu" || arg === "-g") {
      const raw = argv[++i];
      gpu = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
    } else if (arg === "--log") {
      logPath = argv[++i] ?? null;
    } else if (arg === "--job") {
      jobId = argv[++i] ?? null;
    } else if (arg === "--session") {
      session = argv[++i] ?? null;
    } else {
      rest.push(arg);
    }
  }

  if (!name) return { error: "缺少 --name（给这个任务起个你认得出的名字）" };
  if (rest.length === 0) return { error: "缺少要执行的命令（用 -- 隔开，例如 -- python train.py）" };
  return { name, gpu, jobId, session, logPath, cwd: process.cwd(), command: rest };
}

export function newRunId(now = Date.now()): string {
  return `r${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

type Pump = { stop: () => void };

function pumpTo(stream: ReadableStream, sink: (chunk: Uint8Array) => void): Pump {
  let stopped = false;
  (async () => {
    const reader = stream.getReader();
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) sink(value);
      }
    } catch {
      /* 管道关闭 */
    }
  })();
  return {
    stop() {
      stopped = true;
    },
  };
}

export async function commandRun(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const id = newRunId();
  const startedAt = Date.now();
  const logPath = parsed.logPath ?? join(logDir(), `${id}.log`);
  mkdirSync(dirname(logPath), { recursive: true });

  const db = openStore();
  // 队列里起的活：入队那台机器上的会话号跟着 job 走，daemon 不必知道任何会话信息。
  let inherited: string | null = null;
  if (parsed.jobId) {
    try {
      inherited = getJob(db, parsed.jobId)?.session ?? null;
    } catch {
      inherited = null;
    }
  }
  // 显式 --session 最优先；队列里起的活认入队时那个会话，不认 daemon 自己的环境——
  // daemon 可能正好是被某个会话拉起来的，按环境走会把所有排队任务算到它头上。
  const explicit = parsed.session ? resolveSession(parsed.session) : null;
  const session = explicit ?? inherited ?? resolveSession(null);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GPULEASE_RUN_ID: id,
    GPULEASE_TASK_ID: id,
    GPULEASE_RUN_NAME: parsed.name,
  };
  if (session) env.GPULEASE_SESSION = session;
  if (parsed.gpu !== null) env.CUDA_VISIBLE_DEVICES = String(parsed.gpu);

  const header = `# gpulease run ${id} · ${parsed.name} · ${new Date(startedAt).toISOString()}\n# $ ${parsed.command.join(" ")}\n`;
  appendFileSync(logPath, header);

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(parsed.command, {
      cwd: parsed.cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    // 起不来（Windows 上没有 echo 这种命令）也是失败：队列得知道，别让它永远停在 starting。
    const detail = err instanceof Error ? err.message : String(err);
    appendFileSync(logPath, `出错了：${detail}\n`);
    console.error(`出错了：${detail}`);
    if (parsed.jobId) {
      try {
        updateJob(db, parsed.jobId, {
          state: "failed",
          ended_at: Date.now(),
          reason: `起不来：${detail.slice(0, 100)}`,
        });
      } catch {
        /* 队列账记不上不影响退出码 */
      }
    }
    db.close();
    return 1;
  }

  insertRun(db, {
    id,
    name: parsed.name,
    command: parsed.command.join(" "),
    cwd: parsed.cwd,
    root_pid: child.pid ?? null,
    started_at: startedAt,
    ended_at: null,
    exit_code: null,
    pids: child.pid ? [child.pid] : [],
    gpu_hint: parsed.gpu,
    log_path: logPath,
    last_output_at: startedAt,
    session,
  });

  // 队列里起的活：把 run 挂回 job，队列那边才知道它真的在跑了。
  if (parsed.jobId) {
    try {
      updateJob(db, parsed.jobId, {
        state: "running",
        run_id: id,
        gpu: parsed.gpu,
        started_at: startedAt,
        reason: null,
      });
    } catch {
      /* 队列账记不上不影响任务 */
    }
  }

  // 输出既进日志也上屏；同时把"最后有输出的时间"记下来——判定全靠它。
  let lastFlush = 0;
  const touch = () => {
    const now = Date.now();
    if (now - lastFlush < 1000) return;
    lastFlush = now;
    try {
      updateRun(db, id, { last_output_at: now });
    } catch {
      /* 写库失败不影响任务本身 */
    }
  };

  const tee = (fd: 1 | 2) => (chunk: Uint8Array) => {
    try {
      appendFileSync(logPath, chunk);
    } catch {
      /* 日志写不动就算了 */
    }
    const target = fd === 1 ? process.stdout : process.stderr;
    target.write(chunk);
    touch();
  };

  const out = pumpTo(child.stdout as ReadableStream, tee(1));
  const err = pumpTo(child.stderr as ReadableStream, tee(2));

  const forward = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      /* 已经结束 */
    }
  };
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  const code = await child.exited;
  out.stop();
  err.stop();
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);

  const endedAt = Date.now();
  updateRun(db, id, { ended_at: endedAt, exit_code: code, last_output_at: endedAt });
  if (parsed.jobId) {
    try {
      updateJob(db, parsed.jobId, {
        state: code === 0 ? "done" : "failed",
        ended_at: endedAt,
        reason: code === 0 ? "完成" : `退出码 ${code}`,
      });
    } catch {
      /* 同上 */
    }
  }
  appendFileSync(logPath, `# exited ${code} after ${Math.round((endedAt - startedAt) / 1000)}s\n`);

  const verdict =
    code === 0 ? "完成" : `失败（退出码 ${code}）`;
  console.log(`\n「${parsed.name}」${verdict} · 用时 ${Math.round((endedAt - startedAt) / 1000)} 秒`);
  console.log(`日志：${logPath}`);
  return code;
}
