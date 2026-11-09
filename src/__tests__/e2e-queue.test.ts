// 端到端：排队 → 值班进程选卡 → 起 run → 真跑完 → 队列记 done。
// 走的是和 Windows gate 完全同一条路（真子进程、真 sqlite），所以这里过不去，Windows 上也别想。
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listJobs, openStore } from "../store";

const ROOT = join(import.meta.dir, "..", "..");
const BUN = process.execPath;
const MAIN = join(ROOT, "src", "main.ts");
const FIXTURE = join(ROOT, "test", "fixture", "smi.ts");

test("排队的活由值班进程自己找卡起跑，跑完回写队列", async () => {
  const home = mkdtempSync(join(tmpdir(), "gpulease-e2e-q-"));
  const before = process.env.GPULEASE_HOME;
  process.env.GPULEASE_HOME = home;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.GPULEASE_HOME = home;
  env.GPULEASE_SMI = `${BUN} ${FIXTURE}`;
  env.GPULEASE_SMI_SCENARIO = "single";

  const cli = async (args: string[]) => {
    const child = Bun.spawn([BUN, MAIN, ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, out };
  };

  let daemon: ReturnType<typeof Bun.spawn> | null = null;
  let db: ReturnType<typeof openStore> | null = null;
  try {
    expect((await cli(["submit", "--name", "q-fit", "--need-vram", "4096", "--", "echo", "queued-ran"])).code).toBe(0);
    expect((await cli(["submit", "--name", "q-wait", "--need-vram", "40000", "--", "echo", "never"])).code).toBe(0);

    // 真值班进程：`--once` 跑完就退，Windows 上它刚起的 run 可能跟着被收走，所以让它活几秒。
    daemon = Bun.spawn([BUN, MAIN, "daemon", "--interval", "500", "--quiet"], {
      cwd: home,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });

    db = openStore();
    const byName = (name: string) => listJobs(db!, 50).find((job) => job.name === name);

    // 轮询数据库而不是每次起一个 CLI：Windows 上起进程要一秒，40 次轮询会把测试拖死。
    let fit = byName("q-fit");
    let wait = byName("q-wait");
    for (let i = 0; i < 60 && fit?.state !== "done"; i++) {
      await Bun.sleep(500);
      fit = byName("q-fit");
      wait = byName("q-wait");
    }

    expect(fit?.gpu).toBe(0);
    expect(wait?.state).toBe("queued");
    expect(wait?.reason).toBeTruthy();
    expect(fit?.state).toBe("done");
    expect(fit?.run_id).not.toBeNull();

    const logs = join(home, "logs");
    const text = readdirSync(logs)
      .map((file) => readFileSync(join(logs, file), "utf8"))
      .join("\n");
    expect(text).toContain("queued-ran");
  } finally {
    daemon?.kill();
    try {
      db?.close();
    } catch {
      /* 已经关了 */
    }
    if (before === undefined) delete process.env.GPULEASE_HOME;
    else process.env.GPULEASE_HOME = before;
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* Windows：子进程句柄还没放干净也不该让测试红 */
    }
  }
}, 90_000);
