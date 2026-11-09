// 归属：把 nvidia-smi 报的 pid 认回我们起的任务。
// 规则只有一条——只认我们自己记录过的 pid 树；认不出就是 external，绝不猜。

import type { GpuProc, Run } from "./types";
import { descendants, type ProcessInfo } from "./collect/winproc";

export type Attribution = {
  procs: GpuProc[];
  external: number;
  matched: number;
  weak: boolean;
};

export function attribute(gpuProcs: GpuProc[], runs: Run[], procs: ProcessInfo[]): Attribution {
  const ownedBy = new Map<number, string>();
  for (const run of runs) {
    if (run.ended_at !== null) continue;
    const seeds = new Set<number>(run.pids.filter((p) => p > 0));
    if (run.root_pid) seeds.add(run.root_pid);
    for (const seed of seeds) {
      ownedBy.set(seed, run.id);
      for (const child of descendants(seed, procs)) ownedBy.set(child, run.id);
    }
  }

  let matched = 0;
  const procsMapped = gpuProcs.map((p) => {
    const runId = ownedBy.get(p.pid) ?? null;
    if (runId) matched++;
    return { ...p, run_id: runId };
  });

  return {
    procs: procsMapped,
    external: procsMapped.filter((p) => p.run_id === null).length,
    matched,
    // 进程表拿不到时归属只能靠 root pid 自己，标记为弱证据，文案里别说得太满。
    weak: procs.length === 0,
  };
}
