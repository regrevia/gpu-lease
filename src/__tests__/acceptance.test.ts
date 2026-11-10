import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAcceptance, renderAcceptance, writeAcceptance, type AcceptanceInput } from "../acceptance";

function input(over: Partial<AcceptanceInput> = {}): AcceptanceInput {
  return {
    version: "1.0.0",
    platform: "win32",
    now: 1_700_000_000_000,
    nvidia_smi: "present",
    gpus: [{ index: 0, name: "NVIDIA GeForce RTX 4090", memory_total_mb: 24564, utilization: 0, temperature: 41 }],
    process_layer: "ok",
    used_memory: "na",
    tdr_4101: 0,
    nvlddmkm: 2,
    history_samples: 12,
    has_tty: true,
    single_file_exe: true,
    ...over,
  };
}

const byId = (list: ReturnType<typeof buildAcceptance>["items"], id: string) => list.find((i) => i.id === id)!;

describe("doctor --acceptance", () => {
  test("有卡有 exe 的机器：能自动判的都通过，真要动手的仍是待真机", () => {
    const report = buildAcceptance(input());
    expect(byId(report.items, "1.1").status).toBe("proven");
    expect(byId(report.items, "2.2").status).toBe("proven");
    expect(byId(report.items, "2.5").status).toBe("proven");
    expect(byId(report.items, "3.6").status).toBe("proven");
    expect(byId(report.items, "8.5").status).toBe("proven");
    expect(byId(report.items, "8.6").status).toBe("proven");
    // 拔线、真负载、真 ComfyUI、真并发、TUI 这五条机器替不了
    for (const id of ["3.4", "3.5", "4.4", "5.5", "7.5"]) {
      expect(byId(report.items, id).status).toBe("pending");
      expect(byId(report.items, id).how).toBeTruthy();
    }
    expect(report.counts.proven + report.counts.pending + report.counts.failed).toBe(report.items.length);
  });

  test("无卡机器：不把没卡说成通过", () => {
    const report = buildAcceptance(input({ nvidia_smi: "absent", gpus: [], used_memory: "unknown", tdr_4101: null }));
    expect(byId(report.items, "2.2").status).toBe("pending");
    expect(byId(report.items, "2.5").status).toBe("pending");
    expect(byId(report.items, "2.3").status).toBe("proven");
    expect(report.machine.gpus).toBe(0);
  });

  test("Windows 上脚本模式算不过：验收必须用 exe", () => {
    const report = buildAcceptance(input({ single_file_exe: false }));
    expect(byId(report.items, "1.1").status).toBe("failed");
    expect(byId(report.items, "1.1").how).toContain("gpulease.exe");
  });

  test("开发机（非 Windows）脚本模式只是待真机，不算失败", () => {
    const report = buildAcceptance(input({ platform: "darwin", single_file_exe: false }));
    expect(byId(report.items, "1.1").status).toBe("pending");
  });

  test("按进程显存读到数字时，证据说读到数字而不是回退到 N/A", () => {
    const report = buildAcceptance(input({ used_memory: "numbers" }));
    expect(byId(report.items, "2.5").evidence).toContain("读到数字");
  });

  test("渲染带结论行，落盘写出 json 与 md", () => {
    const report = buildAcceptance(input());
    const lines = renderAcceptance(report).join("\n");
    expect(lines).toContain("待真机");
    expect(lines).toContain("通过");
    const dir = mkdtempSync(join(tmpdir(), "gpulease-acc-"));
    try {
      const files = writeAcceptance(report, dir);
      const back = JSON.parse(readFileSync(files.json, "utf8"));
      expect(back.items.length).toBe(report.items.length);
      expect(readFileSync(files.md, "utf8")).toContain("验收自检 1.0.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
