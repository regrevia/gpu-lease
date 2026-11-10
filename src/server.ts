// 浏览器单页：127.0.0.1，只读，SSE 推送。
// 不做前端框架、不做图表库、不画历史曲线——一屏回答"谁在跑、正常吗"。

import { buildState } from "./state";
import { buildDoctor } from "./doctor";
import type { PanelState } from "./state";

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gpulease</title>
<style>
  :root {
    --bg: #0f1012; --fg: #e6e6e6; --dim: #8a8f98; --line: #24262b;
    --ok: #5fbf7f; --warn: #d9a441; --bad: #d9615a; --cool: #5b9dd9;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.55 ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; }
  main { max-width: 940px; margin: 0 auto; padding: 28px 20px 40px; }
  header { display: flex; align-items: baseline; justify-content: space-between;
    border-bottom: 1px solid var(--line); padding-bottom: 10px; margin-bottom: 18px; }
  h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: .02em; }
  #stamp { color: var(--dim); font-size: 12px; }
  section { margin-bottom: 26px; }
  h2 { font-size: 12px; font-weight: 500; color: var(--dim); margin: 0 0 8px; }
  .gpu { display: grid; grid-template-columns: 30px 1fr 108px 120px; gap: 12px;
    align-items: baseline; padding: 7px 0; border-bottom: 1px solid var(--line); }
  .gpu:last-child { border-bottom: 0; }
  .idx { color: var(--dim); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mem { color: var(--dim); font-variant-numeric: tabular-nums; }
  .meter { display: flex; align-items: center; gap: 8px; }
  .bar { flex: 1; height: 5px; background: #1c1e22; border-radius: 2px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--cool); }
  .bar i.hot { background: var(--bad); }
  .pct { color: var(--dim); font-variant-numeric: tabular-nums; width: 34px; text-align: right; }
  .task { display: grid; grid-template-columns: 52px 1fr auto; gap: 12px;
    align-items: baseline; padding: 7px 0; border-bottom: 1px solid var(--line); }
  .task:last-child { border-bottom: 0; }
  .tag { font-size: 12px; }
  .ok { color: var(--ok); } .slow, .suspect, .stalled { color: var(--warn); }
  .failed, .lost { color: var(--bad); } .unknown { color: var(--dim); }
  .pid { color: var(--dim); font-size: 12px; }
  .note { color: var(--dim); font-size: 12px; }
  .empty { color: var(--dim); padding: 6px 0; }
</style>
</head>
<body>
<main>
  <header><h1>gpulease</h1><span id="stamp"></span></header>
  <section><h2>显卡</h2><div id="gpus"></div></section>
  <section><h2>任务</h2><div id="tasks"></div></section>
  <section><div id="notes" class="note"></div></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const gb = (mb) => mb == null ? "?" : (mb / 1024).toFixed(1);
const LABEL = { ok: "正常", slow: "偏慢", suspect: "可疑", stalled: "卡住", failed: "失败", lost: "丢失", unknown: "未知" };

function draw(s) {
  $("stamp").textContent = new Date(s.at).toLocaleTimeString("zh-CN", { hour12: false }) + " 刷新";
  const gpus = $("gpus"); gpus.replaceChildren();
  if (!s.gpus.length) gpus.append(el("div", "empty", s.degraded[0] || "显卡不可用"));
  for (const g of s.gpus) {
    const row = el("div", "gpu");
    row.append(el("div", "idx", "#" + g.index), el("div", "name", g.name));
    const meter = el("div", "meter");
    const track = el("div", "bar"); const fill = el("i");
    const ratio = g.vram_used_mb && g.vram_total_mb ? Math.min(1, g.vram_used_mb / g.vram_total_mb) : 0;
    fill.style.width = (ratio * 100).toFixed(1) + "%"; if (ratio > 0.9) fill.className = "hot";
    track.append(fill); meter.append(track, el("span", "pct", g.util == null ? "?" : Math.round(g.util) + "%"));
    row.append(meter, el("div", "mem", gb(g.vram_used_mb) + "/" + gb(g.vram_total_mb) + " GB"));
    gpus.append(row);
  }
  const tasks = $("tasks"); tasks.replaceChildren();
  const running = s.tasks.filter((t) => t.run.ended_at === null);
  if (!running.length) tasks.append(el("div", "empty", "没有我们托管的任务在跑"));
  for (const t of running) {
    const row = el("div", "task");
    row.append(el("span", "tag " + t.verdict, LABEL[t.verdict] || t.verdict), el("span", null, t.sentence));
    row.append(el("span", "pid", t.run.root_pid ? "pid " + t.run.root_pid : ""));
    if (t.run.session) row.append(el("span", "pid", "会话 " + t.run.session.replace(/^session-/, "").slice(0, 8)));
    tasks.append(row);
  }
  const notes = $("notes"); notes.replaceChildren();
  for (const n of s.degraded) notes.append(el("div", null, "· " + n));
  if (s.external > 0) notes.append(el("div", null, "· 另有 " + s.external + " 个进程占了显卡但不是我们起的"));
}
const es = new EventSource("/api/events");
es.onmessage = (ev) => { try { draw(JSON.parse(ev.data)); } catch (_) {} };
es.onerror = () => { $("stamp").textContent = "连接断开，正在重连"; };
</script>
</body>
</html>`;

export type ServeOptions = {
  port: number;
  host: string;
};

export function startServer(opts: ServeOptions) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    if (clients.size === 0) return;
    let state: PanelState;
    try {
      state = await buildState();
    } catch (err) {
      state = {
        at: Date.now(),
        gpus: [],
        procs: [],
        tasks: [],
        degraded: [`读取失败：${String(err)}`, "gpulease doctor --bundle 生成诊断包"],
        external: 0,
        nvidia: "error",
      };
    }
    const payload = encoder.encode(`data: ${JSON.stringify(state)}\n\n`);
    for (const client of clients) {
      try {
        client.enqueue(payload);
      } catch {
        clients.delete(client);
      }
    }
  };

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/api/state") {
        return buildState().then(
          (state) => Response.json(state),
          (err) => Response.json({ error: String(err) }, { status: 500 }),
        );
      }
      if (url.pathname === "/api/doctor") {
        return buildDoctor().then(
          (report) => Response.json(report),
          (err) => Response.json({ error: String(err) }, { status: 500 }),
        );
      }
      if (url.pathname === "/api/events") {
        let self: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            self = controller;
            clients.add(controller);
            controller.enqueue(encoder.encode(": connected\n\n"));
            if (!timer) {
              timer = setInterval(tick, 2000);
              void tick();
            }
            req.signal.addEventListener("abort", () => {
              if (self) clients.delete(self);
              if (clients.size === 0 && timer) {
                clearInterval(timer);
                timer = null;
              }
            });
          },
          cancel() {
            if (self) clients.delete(self);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return server;
}
