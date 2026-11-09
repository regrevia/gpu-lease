# 架构与技术决策

> 目标：Windows 单机、常驻开销 < 40 MB / < 0.5% CPU、无外部服务依赖、不装 Node。
> 形态：一个 exe（守护 + CLI + 本地 Web UI），HTTP 接口对内对外都是同一套。

---

## 0. 一句话

采集只有两个来源：显卡用 `nvidia-smi`，进程用 Windows 的进程表。两个来源都会坏（驱动不给、WMI 慢、跨用户没权限），所以每一层都有一条"降级但说实话"的路，而不是直接空面板。

## 1. 进程与模块

```
gpulease.exe
 ├─ cli          main.ts：run / ls / watch / serve / daemon / alerts / doctor / --version
 ├─ supervisor   run.ts：spawn 子进程、注入环境变量、双路 tee 落日志、转发退出码
 ├─ collector    collect/smi.ts（唯一的 nvidia-smi 入口）+ collect/nvidia.ts（解析）
 │                + collect/winproc.ts（三级降级进程树），exec.ts 带硬超时
  progress.ts      读日志尾巴里的进度（纯函数，宁可空着也不编）
  alerts.ts        什么时候该吵醒人（纯函数：只报变坏与恢复）
  notify.ts        把一句话推到 webhook（ntfy / 飞书 / 钉钉 / 通用 JSON）
  daemon.ts        常驻值班：单实例锁 + 心跳 + 每轮对比判定
 ├─ engine       attribute.ts（pid → 任务）+ rules.ts（判定）
 ├─ store        bun:sqlite，一张 runs 表，WAL
 ├─ http         server.ts：REST + SSE，127.0.0.1:7788
 └─ ui           内嵌 HTML + 原生 DOM，无前端框架、无图表库
```

单进程、事件循环为主；采样在定时器里跑，不为每个任务起线程。

## 2. 采集层

| 方案 | 状态 | 开销 / 取舍 |
|---|---|---|
| A. 每次 spawn `nvidia-smi` | **v0.1 在用** | 每次约 100–400 ms；零原生依赖，保住单 exe |
| B. `nvidia-smi --loop-ms=2000` 常驻 | 计划 v0.2 | 省掉进程创建，但要自己解析流式输出、断卡时还得 kill |
| C. 进程内 NVML（`bun:ffi` 打开 `nvml.dll`） | 计划 v0.2，目标方案 | init 一次约 1–2 ms，之后是内存内调用；不引入 `.node` |

**v0.1 走 A，理由只有一条**：单文件 exe 不能带原生 addon，`nvidia-smi` 是驱动自带的、永远和驱动同版本。代价是每次查询都要起进程，所以每个采集调用都带 3 s 硬超时并 `SIGKILL`（`src/collect/exec.ts`）。

采集字段（每卡）：`index,uuid,name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw`（`src/collect/nvidia.ts`）。
同一次快照再查一次 `--query-compute-apps=pid,process_name,used_memory`。**Windows 上 `used_memory` 恒为 N/A**，`Gpu.per_process_vram_available` 固定为 `false`，上层据此不显示按任务的 GB。

**故障处理**：`nvidia-smi` 超时 → `status = "error"`，`nvidia-smi` 不存在 → `status = "absent"`。外接显卡拔线时 `nvidia-smi` 可能挂住不返回，超时是必须的，不是可选。

### 2.1 读卡命令是可注入的（`GPULEASE_SMI`）

`collect/smi.ts` 是唯一构造这条命令的地方：默认 `nvidia-smi`，找不到时退到 `%ProgramFiles%\NVIDIA Corporation\NVSMI\nvidia-smi.exe`；设了 `GPULEASE_SMI` 就用它（按空格切参数）。

这个开关只为两件事存在：

1. **门禁**：自托管节点没有 NVIDIA 卡。靠 `test/fixture/smi.ts` 这个替身，多卡异型号、单卡、无卡、驱动报错、断联、无权限、空载、超时这 8 种输入都能在真 Windows 上跑完整链路（`run` → `ls` → 判定 → `doctor`），而不是只在 mac 上测个解析函数。
2. **现场诊断**：用户报"面板说没卡"时，可以让他把这条命令指到自己的包装脚本上，看是驱动问题还是解析问题。

代价与边界：替身只能验证"给定这些行，我们怎么做判断"，不能验证驱动真会吐这些行。所以 `doctor` 在替身生效时会明说"显卡数据来自替身"，任何"支持多卡"的说法仍然只认真卡证据。

## 3. 归属层（产品的命门）

```
托管：spawn(cmd, env={GPULEASE_RUN_ID, GPULEASE_TASK_ID, GPULEASE_RUN_NAME}) → 记 root_pid
      → 枚举 Win32_Process 建父子表 → 取 root 的全部子孙 → 已知 pid 集合
      退出时捕获 exit code，flush 日志，落库

只读：nvidia-smi 报了不在集合里的 pid → 标 external，不猜归属
```

Windows 侧只用 `Win32_Process` 的四个字段：`ProcessId`、`ParentProcessId`、`Name`、`CommandLine`（`src/collect/winproc.ts`）。

| 事 | 实现 | 备注 |
|---|---|---|
| 一次枚举 | `Get-CimInstance Win32_Process \| ConvertTo-Json` | 6 s 超时；真机上 CIM 可能很慢（观测到接近 100 s），所以必须有上限 |
| 失败回退 ①| `Get-Process \| Select Id,ProcessName \| ConvertTo-Json` | .NET 自己枚举进程，**不碰 WMI**；只有 pid 和名字，`ppid=0`、`command=null` |
| 失败回退 ②| `tasklist /FO CSV /NH` | 只有进程名和 pid；实测在某些 Win11 25H2 上会一直不返回，所以放最后 |
| 缺字段怎么报 | `DoctorReport.wmi = "partial"` | 只拿到名字时明说"命令行为空"，不假装全知 |
| 缓存 | 4 s | 面板 2 s 刷一次，不缓存就是每 2 s 起一个 PowerShell |
| 存活判断 | `process.kill(pid, 0)` | 不读别人的环境变量，也不做提权 |

两条硬限制，决定了 v0.1 能承诺什么：

- **`CommandLine` 对跨用户 / 提权 / 受保护进程是 `NULL`**。拿不到就显示进程名，不补全。
- **`--query-compute-apps` 不返回 `gpu_uuid`**，所以 pid 归不到具体卡：`gpuIndexOf()` 恒返回 `null`（`src/state.ts`）。v0.1 只回答"这台机器上有哪些任务在跑"，不回答"这个任务在哪张卡上"。按卡归属留到 v0.2：走 NVML 拿每进程卡号，或用显存增量做推断——后者**待真机验证**。

判定"这个 pid 是不是我的任务"只看我们记录过的 pid 树，**不做环境变量回读**（Windows 上读别人的环境需要管理员权限）。认不出就是 `external`，不猜。

## 4. 进度适配器（v0.2，尚未实现）

统一输出：`{phase, done, total, unit, rate, eta, ts}`

| 适配器 | 数据源 | 用在 |
|---|---|---|
| `log-activity` | 日志文件 mtime / 新增字节数 | 兜底，所有任务都有 |
| `tqdm` | stderr 里的 `\r45%\|...` | 大多数 python 训练 |
| `jsonl` | 训练脚本每步写一行 JSON | 自定义训练 |
| `comfyui` | `/queue` + `/history` + WS `progress` | 生图 / 生视频 |
| `trainer-stdout` | epoch / loss 正则（可配） | HF Trainer / Lightning |
| `http-progress` | content-length / 文件数 | 模型下载、批量 |

v0.1 只有最粗的一层：`run` 把子进程输出 tee 进日志，顺手更新 `last_output_at`（最多每秒写一次库）。判定全靠这个时间戳，所以**没有适配器也能用**。

## 5. 规则引擎

```ts
type JudgeInput = {
  run: Run; now: number; alive: boolean;
  lastOutputAt: number | null;
  gpuStatus: "present" | "absent" | "error";
};
type Assessment = { run_id: string; verdict: Verdict; sentence: string; since: number };
```

`judge()` 是纯函数（`src/rules.ts`），按固定顺序短路，第一条命中即返回：

| # | 条件 | 判定 |
|---|---|---|
| 1 | 未结束，且 `gpuStatus = "error"` | `suspect`（卡读不到，可能是外接卡断联） |
| 2 | `exit_code = 0` / `exit_code ≠ 0` | `ok` / `failed` |
| 3 | 未结束，进程不在，且已过 30 s 宽限 | `lost`（不说"失败"，说"消失"） |
| 4 | 过了宽限，静默 > 600 s | `stalled` |
| 5 | 过了宽限，静默 > 180 s | `slow` |
| 6 | 其余 | `ok` |

阈值集中在 `THRESHOLDS`：`slowSec 180`、`stalledSec 600`、`graceSec 30`。
判定优先级 `lost > failed > stalled > suspect > slow > ok`，`unknown` 兜底（`rank()` / `worst()`，一张卡上只要一个任务出事，卡就是那个状态）。
播报由模板拼装，模板里只允许插值：`「训练」已经 12 分钟没有输出了，可能卡住`。

## 6. 存储

SQLite（`bun:sqlite`，WAL + `busy_timeout 3000`），v0.1 只有一张表：

```sql
runs(id, name, command, cwd, root_pid, started_at, ended_at, exit_code,
     pids, gpu_hint, log_path, last_output_at)
```

**不存每 2 s 的采样**：那是把面板变成时序数据库的开端。`samples` / `progress` / `alerts` 是 v0.2 的事。
不用 `better-sqlite3`：原生 `.node` 无法从单文件 VFS 加载，用了就没有单 exe。

## 7. HTTP 接口（UI、CLI、DSH 插件共用）

```
GET  /             内嵌面板
GET  /api/state    全量快照（卡 + 任务 + degraded）
GET  /api/doctor   自检报告
GET  /api/events   SSE，每 2 s 一帧
```

计划中、**当前不存在**：`POST /api/tasks`、`POST /api/tasks/:id/stop`、`POST /api/tasks/:id/ack`、`GET /api/tasks/:id/logs`。v0.1 的启动入口只有 CLI 的 `run`。

只绑 `127.0.0.1`，不做鉴权；需要远程时走 SSH 隧道（文档写明）。

## 8. 安全边界

- v0.1 没有杀进程接口，也不自动抢卡；`run` 只把 Ctrl+C 转发给子进程。
- 启动子进程用数组参数、不开 shell，避免注入。
- 日志默认落 `%LOCALAPPDATA%\gpulease\logs`，诊断包用 `doctor --bundle` 生成。

## 9. 打包（已定）

**`bun build --compile --minify --target=bun-windows-x64`，产物单 exe。** 在 Windows 节点上实测：exe **109.9 MB**、zip **52.2 MB**（Bun 1.4.4；`--minify` 对体积没有可测影响，1.4.4 也没有 `--trim`）。可在 macOS 交叉编译，但必须到 Windows 上冒烟。

理由：Node SEA 明确不支持从 VFS 加载 `.node`，任何原生依赖都进不去；Tauri / Wails / Electron 体积更小，但要引入第二语言或依赖目标机 WebView2，对一个只画一屏的面板是过度工程。

三条硬约束据此落定：

1. 不引入任何 `.node` 依赖（SQLite 用内置，NVML 走 `bun:ffi` 而不是 npm 绑定包）。
2. 首发**不签名**：GitHub Releases + `SHA256SUMS`，接受首次运行的 SmartScreen 提示（微软文档定性为 "Strong SmartScreen block"）。有用户量后再走开源免费的 SignPath Foundation，或 OV 证书（$150–300/年）。
3. CI：自托管 Windows 节点 `regrevia-win-runner`（实例 `regrevia-gpu-lease`，标签 `self-hosted,Windows,X64,regrevia-win`）上跑 `windows-gate.yml`：build + 无 Node 冒烟 + SHA256，tag 触发发布到 Releases。**不接 `pull_request`**——公开仓库的自托管 runner 会让 fork 代码直接在那台机器上执行。

## 10. 测试策略

- **解析器**：`src/__tests__/parse.test.ts` 覆盖 `nvidia-smi` CSV、CIM JSON、`tasklist` CSV 三种输入，含引号卡名与 N/A 字段。
- **规则**：`judge()` 是纯函数，按 7 个状态各喂一组构造输入——单测待补。
- **无卡端到端**：`--fake-gpu` + fixture 注入构造的 `nvidia-smi` 输出，让无 GPU 的 CI 也能跑通面板——尚未实现。
- **真机**：一台 Windows + eGPU 手测拔线，验 `suspect` 与降级文案。
