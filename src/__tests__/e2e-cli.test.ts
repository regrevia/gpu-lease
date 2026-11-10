// 端到端：用假 nvidia-smi 在一台没卡的机器上跑真实的 CLI 链路
// （run 起子进程 → ls --json 读回 → 判定 → doctor 诚实报告）。
// 这些断言在 Windows 节点上同样成立，所以门禁覆盖的是"有卡时的逻辑"，不是只覆盖解析函数。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "test", "fixture", "smi.ts");
const MAIN = join(ROOT, "src", "main.ts");
let home = "";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "gpulease-e2e-"));
});

afterAll(() => {
  // Windows 上子进程可能还捏着 sqlite/WAL 句柄；清理失败只影响临时目录，不能让测试红。
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* 留给系统 temp 清理 */
  }
});

function baseEnv(scenario: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.GPULEASE_HOME = home;
  env.GPULEASE_SMI = `${process.execPath} ${FIXTURE}`;
  env.GPULEASE_SMI_SCENARIO = scenario;
  env.GPULEASE_SMI_FAKE_PID = String(process.pid);
  return env;
}

async function cli(args: string[], scenario = "two-gpu", env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    env: { ...baseEnv(scenario), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

describe("CLI 端到端（假 GPU）", () => {
  test("托管起一个任务后，ls 能按名字读回它，并判为正常完成", async () => {
    // 先真起一个子进程再等它结束：这样读回的是落盘记录，不受"读进程树要几秒"的影响。
    const started = await cli(["run", "--name", "假训练", "--", process.execPath, "-e", "await Bun.sleep(300)"]);
    expect(started.code).toBe(0);

    const ls = await cli(["ls", "--json"]);
    expect(ls.code).toBe(0);
    const state = JSON.parse(ls.out);
    expect(state.gpus.length).toBe(2);
    expect(state.nvidia).toBe("present");
    const task = state.tasks.find((t: { run: { name: string } }) => t.run.name === "假训练");
    expect(task).toBeTruthy();
    expect(task.run.exit_code).toBe(0);
    expect(task.alive).toBe(false);
    expect(task.verdict).toBe("ok");
  }, 60000);

  test("ls 的人类可读输出里带卡的名字和任务的名字", async () => {
    const ls = await cli(["ls", "--no-color"]);
    expect(ls.code).toBe(0);
    expect(ls.out).toContain("RTX 4090");
    expect(ls.out).toContain("假训练");
  }, 60000);

  test("没有显卡的机器：doctor 说没有 NVIDIA 卡，而不是装死", async () => {
    const doc = await cli(["doctor", "--json"], "absent");
    expect(doc.code).toBe(0);
    const report = JSON.parse(doc.out);
    expect(report.nvidia_smi).toBe("absent");
  }, 60000);

  test("单卡机器：报一张卡；读不到按进程显存时不编数字", async () => {
    const ls = await cli(["ls", "--json"], "single");
    const state = JSON.parse(ls.out);
    expect(state.gpus.length).toBe(1);
    expect(state.gpus[0].vram_used_mb).toBe(18234);
    for (const p of state.procs) expect(p.vram_mb).toBeNull();
  }, 60000);
  test("submit 的 --need-mb 与 --need-vram 是同一个东西，两种写法都落进 need_mb", async () => {
    const a = await cli(["submit", "--name", "别名-vram", "--need-vram", "8192", "--", process.execPath, "-e", "0"], "two-gpu");
    expect(a.code).toBe(0);
    const b = await cli(["submit", "--name", "别名-mb", "--need-mb", "4096", "--", process.execPath, "-e", "0"], "two-gpu");
    expect(b.code).toBe(0);
    const q = await cli(["queue", "--json"], "two-gpu");
    const jobs = JSON.parse(q.out) as { name: string; need_mb: number }[];
    expect(jobs.find((j) => j.name === "别名-vram")!.need_mb).toBe(8192);
    expect(jobs.find((j) => j.name === "别名-mb")!.need_mb).toBe(4096);
  }, 60000);

  test("会话归属：run --session 落库，ls --json 读得回", async () => {
    const started = await cli([
      "run", "--name", "带会话", "--session", "s-e2e-flag", "--", process.execPath, "-e", "await Bun.sleep(200)",
    ]);
    expect(started.code).toBe(0);
    const ls = await cli(["ls", "--json"]);
    const state = JSON.parse(ls.out);
    const task = state.tasks.find((t: { run: { name: string } }) => t.run.name === "带会话");
    expect(task.run.session).toBe("s-e2e-flag");
  }, 60000);

  test("会话归属：没给 --session 时读 GPULEASE_SESSION，再没有就是 null", async () => {
    const viaEnv = await cli([
      "run", "--name", "环境会话", "--", process.execPath, "-e", "await Bun.sleep(200)",
    ], "two-gpu", { GPULEASE_SESSION: "s-e2e-env", DSH_SESSION_ID: "" });
    expect(viaEnv.code).toBe(0);
    const none = await cli([
      "run", "--name", "没有会话", "--", process.execPath, "-e", "await Bun.sleep(200)",
    ], "two-gpu", { GPULEASE_SESSION: "", DSH_SESSION_ID: "" });
    expect(none.code).toBe(0);

    const ls = await cli(["ls", "--json"]);
    const state = JSON.parse(ls.out);
    const env = state.tasks.find((t: { run: { name: string } }) => t.run.name === "环境会话");
    const bare = state.tasks.find((t: { run: { name: string } }) => t.run.name === "没有会话");
    expect(env.run.session).toBe("s-e2e-env");
    expect(bare.run.session).toBeNull();
  }, 60000);

  test("会话归属：submit 把会话带进队列，--session 压过环境变量", async () => {
    const envOnly = await cli(
      ["submit", "--name", "排队-环境", "--", process.execPath, "-e", "0"],
      "two-gpu",
      { GPULEASE_SESSION: "s-e2e-env", DSH_SESSION_ID: "" },
    );
    expect(envOnly.code).toBe(0);
    const explicit = await cli(
      ["submit", "--name", "排队-显式", "--session", "s-e2e-flag", "--", process.execPath, "-e", "0"],
      "two-gpu",
      { GPULEASE_SESSION: "s-e2e-env" },
    );
    expect(explicit.code).toBe(0);
    const q = await cli(["queue", "--json"], "two-gpu");
    const jobs = JSON.parse(q.out) as { name: string; session: string | null }[];
    expect(jobs.find((j) => j.name === "排队-环境")!.session).toBe("s-e2e-env");
    expect(jobs.find((j) => j.name === "排队-显式")!.session).toBe("s-e2e-flag");
  }, 60000);

  test("队列里起的活：认入队时的会话，不认 daemon 的环境变量", async () => {
    const sub = await cli(
      ["submit", "--name", "继承会话", "--session", "s-e2e-job", "--", process.execPath, "-e", "await Bun.sleep(150)"],
      "two-gpu",
      { GPULEASE_SESSION: "s-daemon-env" },
    );
    expect(sub.code).toBe(0);
    const q = await cli(["queue", "--json"], "two-gpu");
    const job = (JSON.parse(q.out) as { id: string; name: string }[]).find((j) => j.name === "继承会话")!;
    const child = await cli(
      ["run", "--name", "继承会话的任务", "--job", job.id, "--", process.execPath, "-e", "await Bun.sleep(150)"],
      "two-gpu",
      { GPULEASE_SESSION: "s-daemon-env" },
    );
    expect(child.code).toBe(0);
    const ls = await cli(["ls", "--json"]);
    const state = JSON.parse(ls.out);
    const task = state.tasks.find((t: { run: { name: string } }) => t.run.name === "继承会话的任务");
    expect(task.run.session).toBe("s-e2e-job");
  }, 60000);

  test("ls 人读输出里也能看见会话短名", async () => {
    const ls = await cli(["ls", "--no-color"]);
    expect(ls.out).toContain("会话 s-e2e-f");
  }, 60000);
  test("会话汇总：sessions 把排队任务算进会话，没会话号的单独一行", async () => {
    const a = await cli(
      ["submit", "--name", "汇总-甲", "--session", "s-sess-aa", "--", process.execPath, "-e", "0"],
      "two-gpu",
      { GPULEASE_SESSION: "", DSH_SESSION_ID: "" },
    );
    expect(a.code).toBe(0);
    const b = await cli(
      ["submit", "--name", "汇总-乙", "--", process.execPath, "-e", "0"],
      "two-gpu",
      { GPULEASE_SESSION: "", DSH_SESSION_ID: "" },
    );
    expect(b.code).toBe(0);

    const json = await cli(["sessions", "--json"], "two-gpu");
    const rows = JSON.parse(json.out) as { session: string | null; label: string; queued: number }[];
    expect(rows.find((r) => r.session === "s-sess-aa")!.queued).toBeGreaterThanOrEqual(1);
    expect(rows.find((r) => r.session === null)!.label).toBe("未标会话");

    const human = await cli(["sessions", "--no-color"], "two-gpu");
    expect(human.out).toContain("s-sess-a");
    expect(human.out).toContain("个排队");
    expect(human.out).toContain("还没上卡");
  }, 60000);
  test("并发起活：多个会话同时 run 不撞库", async () => {
    const names = ["并一", "并二", "并三", "并四"];
    const results = await Promise.all(
      names.map((name) =>
        cli(
          ["run", "--name", name, "--session", `s-conc-${name}`, "--", process.execPath, "-e", "await Bun.sleep(300)"],
          "two-gpu",
          { GPULEASE_SESSION: "", DSH_SESSION_ID: "" },
        ),
      ),
    );
    for (const result of results) expect(result.code).toBe(0);
    const ls = await cli(["ls", "--json"]);
    const state = JSON.parse(ls.out) as { tasks: { run: { name: string; session: string | null } }[] };
    for (const name of names) {
      const task = state.tasks.find((t) => t.run.name === name);
      expect(task).toBeDefined();
      expect(task!.run.session).toBe(`s-conc-${name}`);
    }
  }, 60000);
});
