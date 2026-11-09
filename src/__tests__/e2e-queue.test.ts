// 端到端：排队 → daemon 选卡 → 起 run → 真跑完 → 队列记 done。
// 走的是和 Windows gate 完全同一条路（真子进程），所以这里过不去，Windows 上也别想。
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const BUN = process.execPath;

test("排队的活由 daemon 自己找卡起跑，跑完回写队列", async () => {
  const home = mkdtempSync(join(tmpdir(), "gpulease-e2e-q-"));
  const env = {
    ...(process.env as Record<string, string>),
    GPULEASE_HOME: home,
    GPULEASE_SMI: `${BUN} ${join(ROOT, "test", "fixture", "smi.ts")}`,
    GPULEASE_SMI_SCENARIO: "single",
  };
  const run = async (args: string[]) => {
    const child = Bun.spawn([BUN, join(ROOT, "src", "main.ts"), ...args], {
      cwd: home,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(child.stdout).text();
    const code = await child.exited;
    return { code, out };
  };
  const queue = async () => JSON.parse((await run(["queue", "--json"])).out) as {
    name: string;
    state: string;
    gpu: number | null;
    run_id: string | null;
    reason: string | null;
  }[];

  try {
    expect((await run(["submit", "--name", "q-fit", "--need-vram", "4096", "--", "echo", "queued-ran"])).code).toBe(0);
    expect((await run(["submit", "--name", "q-wait", "--need-vram", "40000", "--", "echo", "never"])).code).toBe(0);

    expect((await run(["daemon", "--once", "--quiet"])).code).toBe(0);

    let jobs = await queue();
    const fit = jobs.find((job) => job.name === "q-fit")!;
    const wait = jobs.find((job) => job.name === "q-wait")!;
    expect(fit.gpu).toBe(0);
    expect(wait.state).toBe("queued");
    expect(wait.reason).toBeTruthy();

    for (let i = 0; i < 40; i++) {
      jobs = await queue();
      if (jobs.find((job) => job.name === "q-fit")?.state === "done") break;
      await Bun.sleep(250);
    }
    const done = jobs.find((job) => job.name === "q-fit")!;
    expect(done.state).toBe("done");
    expect(done.run_id).not.toBeNull();

    const logs = join(home, "logs");
    const text = readdirSync(logs)
      .map((file) => readFileSync(join(logs, file), "utf8"))
      .join("\n");
    expect(text).toContain("queued-ran");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90_000);
