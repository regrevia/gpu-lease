// 共享类型：一个显卡、一个进程、一个任务、一次判定。
// 这些名字是产品语言，不是数据库语言——面板上直接这么说。

export type Gpu = {
  index: number;
  uuid: string;
  name: string;
  driver: string | null;
  vram_total_mb: number | null;
  vram_used_mb: number | null;
  util: number | null;
  temp_c: number | null;
  power_w: number | null;
  /** Windows 上按进程显存拿不到；这里恒为 null，用来提醒调用方别编数字。 */
  per_process_vram_available: boolean;
};

export type GpuProc = {
  pid: number;
  name: string;
  /** 归属到哪个 run；null 表示不是我们起的 */
  run_id: string | null;
  vram_mb: number | null;
};

export type RunStatus = "running" | "exited";

export type Run = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  root_pid: number | null;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  /** 我们自己记录的 pid 集合（root + 采到的子孙） */
  pids: number[];
  gpu_hint: number | null;
  log_path: string | null;
  last_output_at: number | null;
};

export type Verdict =
  | "ok"
  | "slow"
  | "suspect"
  | "stalled"
  | "failed"
  | "lost"
  | "unknown";

export type Assessment = {
  run_id: string;
  verdict: Verdict;
  /** 一句人话，直接上屏 */
  sentence: string;
  since: number;
};

export type Sample = {
  at: number;
  gpus: Gpu[];
  procs: GpuProc[];
  /** 采集是否降级（拿不到 nvidia-smi / WMI 超时等） */
  degraded: string | null;
};

export type DoctorReport = {
  version: string;
  platform: string;
  arch: string;
  nvidia_smi: "present" | "absent" | "error";
  nvidia_smi_detail: string | null;
  gpus: Gpu[];
  wmi: "ok" | "partial" | "unavailable" | "timeout";
  wmi_detail: string | null;
  event_log: { tdr_4101: number | null; nvlddmkm: number | null } | null;
  store_path: string;
  notes: string[];
  probe?: { label: string; cmd: string; code: number; timedOut: boolean; ms: number; out_bytes: number; err_head: string }[];
};
