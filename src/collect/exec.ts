// 跑一条外部命令拿到 stdout，带硬超时。
// 采 nvidia-smi 最怕的不是报错，是卡住：外接卡拔掉的瞬间驱动会让调用挂在那里，
// 所以每个采集路径都必须有超时和 kill，不能让它拖住整个面板。

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export async function exec(
  cmd: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
  } catch (err) {
    return { code: -1, stdout: "", stderr: String(err), timedOut: false };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** nvidia-smi / PowerShell 在 Windows 上按 cmd 找，别拼 .exe 路径。 */
export const IS_WIN = process.platform === "win32";
