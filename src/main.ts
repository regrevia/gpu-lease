// CLI 入口：一个二进制，六条命令。
// hier：run（起任务并记归属）、ls、watch、serve、doctor、version。

import { buildState } from "./state";
import { renderList } from "./render";
import { commandWatch } from "./tui";
import { commandRun } from "./run";
import { buildDoctor, renderDoctor, renderSoak, soak, writeBundle, VERSION } from "./doctor";
import { startServer } from "./server";
import { runDaemon, readDaemonStatus, daemonAlive } from "./daemon";
import {
  getJob,
  insertJob,
  listEvents,
  listJobs,
  listSamples,
  openStore,
  updateJob,
} from "./store";
import { buildHistory, renderHistory } from "./history";
import { commandInstall, commandUninstall } from "./install";

const HELP = `gpulease ${VERSION} — 显卡值班员

用法：
  gpulease run --name 训练 [--gpu 0] [--log FILE] -- python train.py
  gpulease ls [--json]
  gpulease watch [--fast] [--no-color]
  gpulease serve [--port 7788] [--host 127.0.0.1]
  gpulease daemon [--interval 5000] [--webhook URL] [--once]
  gpulease submit --name 训练 [--need-vram 12] [--priority 5] -- python train.py
  gpulease queue [--json]
  gpulease cancel <队列号>
  gpulease alerts [--json] [--limit 30]
  gpulease history [--minutes 30] [--gpu N] [--json]
  gpulease doctor [--json] [--bundle] [--soak [--seconds 30]]
  gpulease install [--autostart] [--no-start-menu] [--dir DIR] [--json]
  gpulease uninstall [--purge] [--dir DIR] [--json]
  gpulease --version

它只回答三个问题：哪张卡在跑哪个任务、还正常吗、出问题要不要你动手。
`;

const color = (): boolean => process.stdout.isTTY === true && !process.argv.includes("--no-color");

async function commandLs(argv: string[]): Promise<number> {
  const state = await buildState({ includeEnded: true, limit: 20 });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }
  for (const line of renderList(state, { color: color() })) console.log(line);
  if (daemonAlive()) console.log(`\n值班进程在跑（pid ${readDaemonStatus()?.pid}），有变化会记进 gpulease alerts。`);
  return 0;
}

async function commandServe(argv: string[]): Promise<number> {
  const portArg = argv[argv.indexOf("--port") + 1];
  const port = argv.includes("--port") && portArg ? Number(portArg) : 7788;
  const hostArg = argv[argv.indexOf("--host") + 1];
  const host = argv.includes("--host") && hostArg ? hostArg : "127.0.0.1";

  const server = startServer({ port, host });
  console.log(`面板：http://${host}:${port}  （Ctrl+C 退出）`);
  return await new Promise<number>((resolve) => {
    const stop = () => {
      void server.stop(true).then(() => resolve(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

const JOB_STATE_LABEL: Record<string, string> = {
  queued: "排队",
  starting: "起",
  running: "在跑",
  done: "完成",
  failed: "失败",
  cancelled: "取消",
};

function newJobId(now = Date.now()): string {
  return `q${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

type SubmitOptions = { name: string; needMb: number; priority: number; command: string[] };

function parseSubmit(argv: string[]): SubmitOptions | { error: string } {
  let name: string | null = null;
  let needMb = 0;
  let priority = 0;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--name" || arg === "-n") name = argv[++i] ?? null;
    else if (arg === "--need-vram") needMb = Math.max(0, Number(argv[++i] ?? 0) || 0);
    else if (arg === "--priority" || arg === "-p") priority = Number(argv[++i] ?? 0) || 0;
    else rest.push(arg);
  }
  if (!name) return { error: "缺少 --name（给这个任务起个你认得出的名字）" };
  if (!rest.length) return { error: "缺少要执行的命令（用 -- 隔开，例如 -- python train.py）" };
  return { name, needMb, priority, command: rest };
}

async function commandSubmit(argv: string[]): Promise<number> {
  const parsed = parseSubmit(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const db = openStore();
  const id = newJobId();
  insertJob(db, {
    id,
    name: parsed.name,
    command: JSON.stringify(parsed.command),
    cwd: process.cwd(),
    need_mb: parsed.needMb,
    priority: parsed.priority,
  });
  const ahead = listJobs(db, 200).filter((job) => job.state === "queued" && job.id !== id).length;
  console.log(`已入队 ${id}：「${parsed.name}」${parsed.needMb ? `要 ${parsed.needMb} MB 显存` : ""}`);
  console.log(
    ahead ? `前面还有 ${ahead} 个 · 用 gpulease queue 看进度` : "排队等卡 · 起 gpulease daemon 就会自动上卡",
  );
  return 0;
}

async function commandQueue(argv: string[]): Promise<number> {
  const db = openStore();
  const jobs = listJobs(db, 50);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(jobs, null, 2));
    return 0;
  }
  if (!jobs.length) {
    console.log("队列是空的：用 gpulease submit --name 训练 -- python train.py 排一个");
    return 0;
  }
  for (const job of jobs) {
    const label = JOB_STATE_LABEL[job.state] ?? job.state;
    const gpu = job.gpu === null ? "" : ` · 卡 ${job.gpu}`;
    const need = job.need_mb ? ` · 要 ${fmtMb(job.need_mb)}` : "";
    const reason = job.reason ? ` · ${job.reason}` : "";
    const run = job.run_id ? ` · ${job.run_id}` : "";
    console.log(`${label}  ${job.id}  ${job.name}${need}${gpu}${reason}${run}`);
  }
  return 0;
}

async function commandCancel(argv: string[]): Promise<number> {
  const id = argv.find((arg) => !arg.startsWith("-"));
  if (!id) {
    console.error("用法：gpulease cancel <队列号>（gpulease queue 里那一列）");
    return 2;
  }
  const db = openStore();
  const job = getJob(db, id);
  if (!job) {
    console.error(`没有这个队列号：${id}`);
    return 1;
  }
  if (job.state !== "queued") {
    console.error(`「${job.name}」现在是「${JOB_STATE_LABEL[job.state] ?? job.state}」，只有排队中的能取消`);
    return 1;
  }
  updateJob(db, id, { state: "cancelled", ended_at: Date.now(), reason: "手动取消" });
  console.log(`已取消 ${id}「${job.name}」`);
  return 0;
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

async function commandDaemon(argv: string[]): Promise<number> {
  const idx = argv.indexOf("--interval");
  const intervalArg = idx >= 0 ? argv[idx + 1] : undefined;
  const webhookIdx = argv.indexOf("--webhook");
  const webhook = webhookIdx >= 0 ? (argv[webhookIdx + 1] ?? null) : (process.env.GPULEASE_WEBHOOK ?? null);
  return await runDaemon({
    intervalMs: intervalArg ? Number(intervalArg) : undefined,
    webhook,
    once: argv.includes("--once"),
    quiet: argv.includes("--quiet"),
  });
}

async function commandAlerts(argv: string[]): Promise<number> {
  const idx = argv.indexOf("--limit");
  const limit = idx >= 0 ? Number(argv[idx + 1]) : 30;
  const db = openStore();
  const events = listEvents(db, Number.isFinite(limit) ? limit : 30);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(events, null, 2));
    return 0;
  }
  if (!events.length) {
    const beat = readDaemonStatus();
    console.log(
      beat && daemonAlive()
        ? "还没有告警。值班进程在跑，有变化会记在这里。"
        : "还没有告警，也没有值班进程：用 gpulease daemon 起一个。",
    );
    return 0;
  }
  for (const event of events) {
    const when = new Date(event.at).toLocaleString("zh-CN", { hour12: false });
    const mark = event.delivered ? "" : "（未推送）";
    console.log(`${when}  ${event.message}${mark}`);
  }
  return 0;
}

async function commandHistory(argv: string[]): Promise<number> {
  const mArg = argv[argv.indexOf("--minutes") + 1];
  const minutes = argv.includes("--minutes") && mArg ? Math.max(1, Number(mArg) || 30) : 30;
  const gArg = argv[argv.indexOf("--gpu") + 1];
  const onlyGpu = argv.includes("--gpu") && gArg ? Number(gArg) : null;

  const now = Date.now();
  const state = await buildState({ includeEnded: false });
  const db = openStore();
  const samples = listSamples(db, now - minutes * 60_000, onlyGpu);
  db.close();

  const gpus = state.gpus
    .filter((g) => onlyGpu === null || g.index === onlyGpu)
    .map((g) => ({ index: g.index, label: g.name }));
  const history = buildHistory(gpus, samples, now, minutes);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(history, null, 2));
    return 0;
  }
  for (const line of renderHistory(history)) console.log(line);
  return 0;
}

async function commandDoctor(argv: string[]): Promise<number> {
  if (argv.includes("--soak")) {
    const sArg = argv[argv.indexOf("--seconds") + 1];
    const seconds = argv.includes("--seconds") && sArg ? Number(sArg) : 30;
    const report = await soak({ seconds, intervalMs: 2000 });
    if (argv.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    console.log(renderSoak(report));
    return 0;
  }
  if (argv.includes("--bundle")) {
    const path = await writeBundle();
    console.log(`诊断包已生成：${path}`);
    return 0;
  }
  const report = await buildDoctor({ probe: argv.includes("--probe") });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(renderDoctor(report));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(VERSION);
    return 0;
  }

  switch (cmd) {
    case "run":
      return commandRun(rest);
    case "ls":
      return commandLs(rest);
    case "watch":
      return commandWatch(rest);
    case "submit":
      return await commandSubmit(rest);
    case "queue":
      return await commandQueue(rest);
    case "cancel":
      return await commandCancel(rest);
    case "daemon":
      return await commandDaemon(rest);
    case "alerts":
      return await commandAlerts(rest);
    case "history":
      return await commandHistory(rest);
    case "serve":
      return commandServe(rest);
    case "doctor":
      return commandDoctor(rest);
    case "install":
      return await commandInstall(rest);
    case "uninstall":
      return await commandUninstall(rest);
    default:
      console.error(`未知命令：${cmd}\n`);
      console.log(HELP);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`出错了：${err?.stack ?? err}`);
      process.exit(1);
    },
  );
}
