// CLI 入口：一个二进制，六条命令。
// hier：run（起任务并记归属）、ls、watch、serve、doctor、version。

import { buildState } from "./state";
import { renderList } from "./render";
import { commandWatch } from "./tui";
import { commandRun } from "./run";
import { buildDoctor, renderDoctor, writeBundle, VERSION } from "./doctor";
import { startServer } from "./server";
import { runDaemon, readDaemonStatus, daemonAlive } from "./daemon";
import { listEvents, openStore } from "./store";

const HELP = `gpulease ${VERSION} — 显卡值班员

用法：
  gpulease run --name 训练 [--gpu 0] [--log FILE] -- python train.py
  gpulease ls [--json]
  gpulease watch [--fast] [--no-color]
  gpulease serve [--port 7788] [--host 127.0.0.1]
  gpulease daemon [--interval 5000] [--webhook URL] [--once]
  gpulease alerts [--json] [--limit 30]
  gpulease doctor [--json] [--bundle]
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

async function commandDoctor(argv: string[]): Promise<number> {
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
    case "daemon":
      return await commandDaemon(rest);
    case "alerts":
      return await commandAlerts(rest);
    case "serve":
      return commandServe(rest);
    case "doctor":
      return commandDoctor(rest);
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
