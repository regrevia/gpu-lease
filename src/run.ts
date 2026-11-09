// run 包装器：任务的归属从这一行命令开始，而不是从猜 pid 开始。
// 用法：gpulease run --name "训练" -- python train.py

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { logDir } from "./paths";
import { insertRun, openStore, updateRun } from "./store";

export type RunOptions = {
  name: string;
  gpu: number | null;
  logPath: string | null;
  cwd: string;
  command: string[];
};

export function parseRunArgs(argv: string[]): RunOptions | { error: string } {
  let name: string | null = null;
  let gpu: number | null = null;
  let logPath: string | null = null;
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
    } else {
      rest.push(arg);
    }
  }

  if (!name) return { error: "缺少 --name（给这个任务起个你认得出的名字）" };
  if (rest.length === 0) return { error: "缺少要执行的命令（用 -- 隔开，例如 -- python train.py）" };
  return { name, gpu, logPath, cwd: process.cwd(), command: rest };
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

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GPULEASE_RUN_ID: id,
    GPULEASE_TASK_ID: id,
    GPULEASE_RUN_NAME: parsed.name,
  };
  if (parsed.gpu !== null) env.CUDA_VISIBLE_DEVICES = String(parsed.gpu);

  const db = openStore();
  const header = `# gpulease run ${id} · ${parsed.name} · ${new Date(startedAt).toISOString()}\n# $ ${parsed.command.join(" ")}\n`;
  appendFileSync(logPath, header);

  const child = Bun.spawn(parsed.command, {
    cwd: parsed.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

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
  });

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
  appendFileSync(logPath, `# exited ${code} after ${Math.round((endedAt - startedAt) / 1000)}s\n`);

  const verdict =
    code === 0 ? "完成" : `失败（退出码 ${code}）`;
  console.log(`\n「${parsed.name}」${verdict} · 用时 ${Math.round((endedAt - startedAt) / 1000)} 秒`);
  console.log(`日志：${logPath}`);
  return code;
}
