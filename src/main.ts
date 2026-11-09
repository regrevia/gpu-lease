// 打包探针：v0 只做三件事——证明单文件 exe 能跑、证明无卡时诚实降级、
// 证明 JSON 契约的形状。真正的采集 / 归属 / 规则 / 播报在 v0.1 落这里之上。
//
// 这条文件存在的意义是让 .github/workflows/windows-gate.yml 有东西可编译：
// 我们最早要确认的不是界面好不好看，而是"用户双击的那个 exe 会不会因为缺
// Node、缺驱动、缺 GPU 就崩"。

type Gpu = {
  index: number;
  uuid: string;
  name: string;
  driver: string | null;
  vram_total_mb: number | null;
  vram_used_mb: number | null;
  util: number | null;
};

type DoctorReport = {
  version: string;
  platform: string;
  arch: string;
  nvidia_smi: "present" | "absent";
  gpus: Gpu[];
  notes: string[];
};

const VERSION = "0.0.1";

const FAKE_GPU: Gpu = {
  index: 0,
  uuid: "GPU-fake-0",
  name: "Fake NVIDIA RTX (test)",
  driver: "000.00",
  vram_total_mb: 24576,
  vram_used_mb: 8123,
  util: 61,
};

function hasNvidiaSmi(): boolean {
  try {
    const p = Bun.spawnSync({
      cmd: ["nvidia-smi", "--version"],
      stdout: "ignore",
      stderr: "ignore",
    });
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

function doctor(fakeGpu: boolean): DoctorReport {
  const present = hasNvidiaSmi();
  const notes: string[] = [];

  if (fakeGpu) {
    notes.push("--fake-gpu：使用构造数据，用于验证解析与规则");
    return {
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      nvidia_smi: present ? "present" : "absent",
      gpus: [FAKE_GPU],
      notes,
    };
  }

  if (!present) {
    // 没有驱动不是错误，是一种状态。说清楚，然后正常退出。
    notes.push("未找到 nvidia-smi：这台机器没有 NVIDIA 显卡，或驱动未安装");
    return {
      version: VERSION,
      platform: process.platform,
      arch: process.arch,
      nvidia_smi: "absent",
      gpus: [],
      notes,
    };
  }

  notes.push("nvidia-smi 可用，但 v0 尚未接采集层");
  return {
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    nvidia_smi: "present",
    gpus: [],
    notes,
  };
}

function tasks(): unknown[] {
  // v0 不主动托管任何任务，所以这里恒为空；shape 先定下来。
  return [];
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const fakeGpu = args.includes("--fake-gpu");
  const cmd = args.find((a) => !a.startsWith("-")) ?? "";

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return 0;
  }

  if (cmd === "doctor") {
    const report = doctor(fakeGpu);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`gpulease ${report.version} · ${report.platform}/${report.arch}`);
      console.log(`nvidia-smi: ${report.nvidia_smi}`);
      console.log(`显卡: ${report.gpus.length} 张`);
      for (const n of report.notes) console.log(`  ${n}`);
    }
    return 0;
  }

  if (cmd === "ls") {
    const list = tasks();
    if (json) console.log(JSON.stringify(list, null, 2));
    else console.log("还没有托管任务。用 gpulease run --name <名字> -- <命令> 启动一个。");
    return 0;
  }

  console.log("gpulease — 显卡值班员");
  console.log("  gpulease ls [--json]       看正在跑什么");
  console.log("  gpulease doctor [--json]   自检：驱动、显卡、权限");
  console.log("  gpulease --version");
  return cmd === "" ? 0 : 2;
}

process.exit(main(process.argv));
