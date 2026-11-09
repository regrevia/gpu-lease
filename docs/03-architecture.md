# 架构与技术决策

> 目标：单机、跨平台（Windows 优先）、常驻开销 < 40 MB / < 0.5% CPU、无外部服务依赖。
> 形态：一个 exe（守护 + CLI + 本地 Web UI），HTTP 接口对内对外都是同一套。

---

## 1. 进程与模块

```
gpulease.exe
 ├─ supervisor    子进程管理（spawn/attach、pid 树、退出码、日志落盘）
 ├─ collector     GPU 采样（nvidia-smi 常驻 loop，失败降级）
 ├─ engine        进度归一 + 规则判定 + 播报生成
 ├─ store        SQLite（tasks / runs / samples / alerts）
 ├─ http         REST + SSE（127.0.0.1:7788，绑定回环）
 └─ ui           静态页（内嵌，不打前端框架，原生 DOM）
```

单进程、单线程事件循环为主；采样与规则在定时器里跑，绝不为每个任务起线程。

## 2. 采集层

| 方案 | 开销 | 取舍 |
|---|---|---|
| **A. 进程内 NVML**（`nvml.dll` / `libnvidia-ml.so`，用 `bun:ffi` 直接 dlopen） | 最低：init 一次 ~1–2 ms，之后 1–2 s 轮询 | **目标方案**：不 spawn、不引入 `.node`，保住单 exe |
| **B. `nvidia-smi --loop-ms=2000`** 一条常驻进程 | 首版可接受 | **保底方案**：零原生依赖，两平台一致；断卡时靠 kill + 超时兜住 |
| C. 每次 spawn `nvidia-smi` | 每次 100–400 ms | 不用：监控插件普遍这么干，三个同装就是纯浪费 |

采集字段（每卡）：`uuid, index, name, utilization.gpu, memory.used, memory.total, temperature.gpu, power.draw, clocks_throttle_reasons.*`
每 5 s 额外一次：`--query-compute-apps=pid,process_name,used_memory`（这个只能一次性 spawn，没法 loop）。

**故障处理**：每次查询加 3 s 超时并杀进程；连续 2 次超时或 UUID 从枚举中消失 → 该卡 `lost`，触发规则 #7。外接显卡拔线时 nvidia-smi 可能挂死，超时是必须的，不是可选。

## 3. 归属层（产品的命门）

```
托管：spawn(cmd, env={GPULEASE_TASK_ID, GPULEASE_RUN_ID}) → 记 root_pid
      → 定时遍历子进程树（psutil / Win32_Process）→ 已知 pid 集合
      退出时捕获 exit code，flush 日志，落库

纳入：attach(pid) → 读命令行 + cwd + 父进程 → 建议任务类型
      → 用户确认名字 → 从此按"已知 pid"处理（但退出码可能看不到）

只读：nvidia-smi 报了不在表里的 pid → 显示 "外部进程"，不猜归属
```

判定"这个 pid 是不是我的任务"只看 pid 集合，**不做环境变量回读**（Windows 上读别人的环境需管理员权限）。

## 4. 进度适配器（可插拔，按任务类型选）

统一输出：`{phase, done, total, unit, rate, eta, ts}`

| 适配器 | 数据源 | 用在 |
|---|---|---|
| `log-activity` | 日志文件的 mtime / 新增行数 | **兜底**，所有任务都有 |
| `tqdm` | stderr 里的 `\r45%\|...` | 大多数 python 训练 |
| `jsonl` | 训练脚本每步写一行 JSON | 推荐给自定义训练 |
| `comfyui` | `/queue` + `/history` + WS `progress` 事件 | 生图/生视频 |
| `trainer-stdout` | epoch/loss 正则（可配） | HF Trainer / Lightning |
| `http-progress` | 下载的 content-length / 文件数 | 模型下载、批量 |

**没有适配器也能用**：只有 `log-activity` 时，播报退化为"最后输出 3 分钟前"，仍然能覆盖规则 #4/#5。这是设计上最重要的一条降级路径。

## 5. 规则引擎

```ts
type Fact = { task, run, gpu, samples[], progress[], logs[], process }
type Rule = { id: string; when(f: Fact): Verdict | null; cooldownMs: number }
```

- 规则纯函数，输入是快照，输出 `Verdict | null`，好测。
- 每条规则自带冷却与"需要连续 N 次满足"，防抖。
- 判定优先级：`lost > failed > stalled > suspect > slow > ok`。
- 播报由 `Verdict → 模板` 生成，模板里只允许插值，不允许自由文本。

## 6. 存储

SQLite（WAL）：

```sql
tasks(id, name, kind, created_at, archived)
runs(id, task_id, argv, gpu_uuid, root_pid, started_at, ended_at, exit_code, attempt)
samples(gpu_uuid, ts, util, mem_used, mem_total, temp, power)   -- 环形保留 6h，1 分钟粒度
progress(run_id, ts, phase, done, total, unit, rate)
alerts(id, run_id, rule_id, level, message, ts, acked)
```

SQLite 用运行时内置模块（`bun:sqlite` 或 `node:sqlite`），**不用 `better-sqlite3`**：native `.node` 无法从单文件 VFS 加载，用了就没有单 exe。若某天必须换，退化为 JSONL + 内存索引（数据量本来就小，6 小时环形）。

## 7. HTTP 接口（UI、CLI、DSH 插件共用）

```
GET  /api/state            当前全量快照（任务+卡+队列）
GET  /api/events           SSE，增量推送
POST /api/tasks            启动任务
POST /api/tasks/:id/stop
POST /api/tasks/:id/ack    已读告警
GET  /api/tasks/:id/logs?tail=200
GET  /api/doctor           自检
```

只绑 `127.0.0.1`，不做鉴权；需要远程时走 SSH 隧道（文档写明）。

## 8. 安全边界

- 不做自动杀进程（v0.3 前），所有"释放"动作需人点。
- 启动子进程用 `shell: false` + 数组参数，避免注入。
- 日志落盘目录用户可配，默认 `%LOCALAPPDATA%\gpulease\logs`。

## 9. 打包（已定）

**`bun build --compile --target=bun-windows-x64`，产物单 exe。** 官方口径体积 gzip 33 MB、`--trim` 后 14 MB 左右，可在 macOS/Linux 上交叉编译出 Windows 产物。

理由：Node SEA 明确不支持从 VFS 加载 `.node`，任何原生依赖都进不去；Tauri/Wails 体积最小但要引入第二语言 + 依赖目标机 WebView2，对一个只会画一屏的面板是过度工程。

三条硬约束据此落定：
1. 不引入任何 `.node` 依赖（SQLite 用内置，NVML 用 `bun:ffi` 而不是 npm 绑定包）。
2. 首发**不签名**：GitHub Releases + SHA256，接受首次运行的 SmartScreen 提示（微软文档定性为 "Strong SmartScreen block"）。有用户量后再走开源免费的 SignPath Foundation，或 OV 证书（$150–300/年）。
3. CI：`windows-latest` 上 build + `actions/upload-artifact`，tag 触发发布到 Releases。

## 10. 测试策略

- 规则引擎：纯函数单测，喂构造的时序快照（停滞/泄漏/过热/断联各一组）。
- 采集：录一段真实 `nvidia-smi --loop-ms` 输出做 golden file，解析测试不依赖显卡。
- 端到端：假的 GPU 后端（`--fake-gpu` 标志 + fixture），让 CI 无卡可跑。
- 真机：一台 Windows + eGPU 手测拔线。
