// 把三路采集（显卡、进程、我们自己的 runs）拼成一份面板状态。
// 所有入口（ls / watch / serve）都读这一份，避免三个界面各算一遍、各说各话。

import { snapshot } from "./collect/nvidia";
import { listProcesses, isAlive } from "./collect/winproc";
import { attribute } from "./attribute";
import { parseProgress, readTail, type Progress } from "./progress";
import { judge } from "./rules";
import { activeRuns, listRuns, openStore } from "./store";
import type { Gpu, GpuProc, Run, Verdict } from "./types";

export type TaskView = {
  run: Run;
  verdict: Verdict;
  sentence: string;
  alive: boolean;
  since: number;
  gpus: number[];
  /** 从任务自己的日志尾巴里读到的进度；读不到就是 null，不编数字 */
  progress: Progress | null;
};

export type PanelState = {
  at: number;
  gpus: Gpu[];
  procs: GpuProc[];
  tasks: TaskView[];
  degraded: string[];
  external: number;
  nvidia: "present" | "absent" | "error";
};

export async function buildState(opts: { limit?: number; includeEnded?: boolean } = {}): Promise<PanelState> {
  const db = openStore();
  const [nv, procLayer] = await Promise.all([snapshot(), listProcesses()]);

  const runs = opts.includeEnded ? listRuns(db, opts.limit ?? 20) : activeRuns(db);
  const running = runs.filter((r) => r.ended_at === null);
  const attribution = attribute(nv.procs, running, procLayer.procs);

  const degraded: string[] = [];
  if (nv.status === "absent") degraded.push("这台机器上没有 nvidia-smi：显卡数据不可用");
  else if (nv.status === "error") degraded.push(nv.detail ?? "显卡读取失败");
  if (procLayer.degraded) degraded.push(procLayer.degraded);

  const tasks: TaskView[] = runs.map((run) => {
    const alive = run.ended_at === null && isAlive(run.root_pid ?? -1);
    const lastOutputAt = run.last_output_at;
    const assessment = judge({ run, now: Date.now(), alive, lastOutputAt, gpuStatus: nv.status });
    const gpus = attribution.procs.filter((p) => p.run_id === run.id).map((p) => gpuIndexOf(p, nv.gpus));
    return {
      run,
      verdict: assessment.verdict,
      sentence: assessment.sentence,
      alive,
      since: assessment.since,
      gpus: [...new Set(gpus)].filter((g): g is number => g !== null),
      progress: run.ended_at === null && run.log_path ? parseProgress(readTail(run.log_path)) : null,
    };
  });

  return {
    at: Date.now(),
    gpus: nv.gpus,
    procs: attribution.procs,
    tasks,
    degraded,
    external: attribution.external,
    nvidia: nv.status,
  };
}

function gpuIndexOf(_proc: GpuProc, _gpus: Gpu[]): number | null {
  // Windows 的 --query-compute-apps 不返回 gpu_uuid，只能给整卡视图；
  // 这里返回 null，等 Linux 版或用 NVML 时再补按进程的卡号。
  return null;
}
