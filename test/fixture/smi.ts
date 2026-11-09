// 假 nvidia-smi：给没有显卡的 Windows 节点用。
// 用法：GPULEASE_SMI="<bun> test/fixture/smi.ts" GPULEASE_SMI_SCENARIO=two-gpu bun run src/main.ts ls
// 输出格式与真 nvidia-smi 的 --format=csv,noheader,nounits 一致（含 WDDM 下的 [N/A]）。

const scenario = (process.env.GPULEASE_SMI_SCENARIO ?? "two-gpu").trim();
const args = process.argv.slice(2).join(" ");

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  process.exit(0);
}

function fail(code: number, message: string): void {
  process.stderr.write(message + "\n");
  process.exit(code);
}

const isGpu = args.includes("--query-gpu");
const isApps = args.includes("--query-compute-apps");

if (scenario === "timeout") {
  // 外接卡断联时真 nvidia-smi 会挂住：这里照做，让上层超时。
  await Bun.sleep(120_000);
  fail(1, "never returns");
}

if (scenario === "absent") {
  fail(127, "'nvidia-smi' is not recognized as an internal or external command");
}

if (scenario === "error") {
  fail(1, "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.");
}

if (isGpu) {
  if (scenario === "single") {
    out("0, GPU-0f2c1a44-1111-2222-3333-444455556666, NVIDIA GeForce RTX 4090, 566.14, 24564, 18234, 97, 71, 402.31");
  } else {
    // 外接 4090 + 内置 4060：型号不同、显存不同、利用率不同，正好验"多卡不同型号"。
    out(
      [
        "0, GPU-0f2c1a44-1111-2222-3333-444455556666, NVIDIA GeForce RTX 4090, 566.14, 24564, 18234, 97, 71, 402.31",
        "1, GPU-77aa88bb-9999-8888-7777-666655554444, NVIDIA GeForce RTX 4060, 566.14, 8188, 3201, 12, 54, 38.90",
      ].join("\n"),
    );
  }
}

if (isApps) {
  if (scenario === "lost") {
    // 卡还在，但按进程的表读不到（断联后常见）：exit 1。
    fail(1, "Failed to initialize NVML: GPU access blocked by the operating system");
  }
  if (scenario === "permission") {
    fail(1, "Insufficient Permissions");
  }
  if (scenario === "idle") process.exit(0);
  // WDDM 下 used_memory 永远是 [N/A]：上层不许据此编数字。
  out(
    [
      `${process.env.GPULEASE_SMI_FAKE_PID ?? 4242}, C:\\Program Files\\Python311\\python.exe, [N/A]`,
      "5252, C:\\Windows\\System32\\dwm.exe, [N/A]",
    ].join("\n"),
  );
}

fail(1, `unknown query: ${args}`);
