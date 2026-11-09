// 跑一条外部命令拿到 stdout，带硬超时。
// 采 nvidia-smi 最怕的不是报错，是卡住：外接卡拔掉的瞬间驱动会让调用挂在那里，
// 所以每个采集路径都必须有超时和 kill，不能让它拖住整个面板。

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
};

/** 增量读管道。不要用 `new Response(stream).text()`：Bun 在 Windows 上读子进程管道时
 *  那个写法会在子进程退出后仍等不到流关闭，采集层就整体超时（在自托管节点上实测到过）。 */
async function drain(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(out);
}

export async function exec(
  cmd: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const started = Date.now();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
  } catch (err) {
    return { code: -1, stdout: "", stderr: String(err), timedOut: false, ms: Date.now() - started };
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
    const [stdout, stderr, code] = await Promise.all([
      drain(proc.stdout as ReadableStream<Uint8Array>),
      drain(proc.stderr as ReadableStream<Uint8Array>),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut, ms: Date.now() - started };
  } catch (err) {
    return { code: -1, stdout: "", stderr: String(err), timedOut, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** nvidia-smi / PowerShell 在 Windows 上按 cmd 找，别拼 .exe 路径。 */
export const IS_WIN = process.platform === "win32";
