# Windows 可行性边界 & 单 exe 打包调研

> 调研对象：Windows 单机、多 NVIDIA 卡（外接 eGPU + 集显）的显卡值班员，v0.1 交付为单 exe。
> 约束：低占用、双击即用、不要求用户装 Node。
> 调研环境：macOS（darwin/arm64）写代码，Windows 节点 `regrevia-win-runner`（Windows 11 build 26200，**无 NVIDIA 驱动**）验打包与降级。凡只在有卡机器上成立的事实，标「待真机验证」。

---

## 结论速览

| # | 问题 | 结论 | 对 v0.1 的影响 |
|---|---|---|---|
| 1 | 进程归属 | pid 拿得到，进程名可用，**per-process 显存拿不到**（WDDM 下恒为 N/A） | 显存只按整卡说，不做精确分摊 |
| 2 | 卡号归属 | `--query-compute-apps` 不返回 `gpu_uuid`，pid 归不到卡 | v0.1 不回答"在哪个卡上"，留到 v0.2 |
| 3 | 健康信号 | TDR 走事件日志（4101）；**Xid 是 Linux 概念，Windows 没有** | 用「进程消失 + 输出静默 + 卡读不到」当主信号 |
| 4 | DCGM | 官方支持列表只有 Linux | 不依赖，只能走 `nvidia-smi`（v0.2 换 NVML） |
| 5 | eGPU 热拔 | 设备 surprise removal，句柄失效，`nvidia-smi` 可能挂住 | 所有采集调用必须带硬超时 |
| 6 | 单 exe | Bun `--compile` 可行，实测 109.9 MB；Node SEA 受原生模块限制 | 用 `bun:sqlite`，禁用任何 `.node` |
| 7 | CI/签名 | 自托管 Windows 节点能编译并冒烟；不签名会被 SmartScreen 强拦 | 首发不签名 + SHA256，留 OV 升级路径 |
| 8 | 常驻开销 | `nvidia-smi` 每次 spawn 要起进程、重新初始化；常驻 NVML 更省 | v0.1 按次 spawn，v0.2 才换常驻 |

---

## 1. 进程归属：nvidia-smi pid → 程序 / 任务

**能拿到 pid，拿不到显存。** WDDM 驱动模型（Windows 桌面默认）下显存由内核态驱动管理器统一管理，NVIDIA 驱动不知道每个进程占了多少。`nvidia-smi` 摘要表显示 `N/A`，`-q` 会直说 "Not available in WDDM driver model"。
证据：[NVIDIA 论坛：GPU Memory Usage shows "N/A"](https://forums.developer.nvidia.com/t/gpu-memory-usage-shows-n-a/169140)（NVIDIA 员工回复）；同一行为 2013 年即有记录：[nvidia-smi reports incorrect memory usage in Windows 7/8 x64](https://forums.developer.nvidia.com/t/expected-behavior-nvidia-smi-reports-incorrect-memory-usage-in-windows-7-8-x64/31404)。

| 字段 | Windows 上的值 |
|---|---|
| `--query-compute-apps=used_memory` | **恒为 N/A**，不是某代驱动的 bug |
| `--query-compute-apps=process_name` | 有值，会被截断；非本用户进程显示 `Insufficient Permissions` |
| `--query-compute-apps=pid` | 有值，可直接用 |
| `--query-compute-apps=gpu_uuid` | **不返回**，所以 pid 归不到卡 |
| 整卡 `memory.used` / `memory.total` | 有值，可做"总量 − 已用"估算 |

TCC 模式（数据中心卡）下 per-process 显存可读；消费级 GeForce 在较新 WDDM 驱动上是否有部分字段恢复可读：**待真机验证**。

**pid → 程序/任务**：WMI/CIM `Win32_Process` 取 `ProcessId`、`ParentProcessId`、`Name`、`CommandLine`。
证据：[Win32_Process class（Microsoft Learn）](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)。

坑：

- `CommandLine` 对**跨用户 / 受保护 / 提权进程**返回 `NULL`，需要管理员或 `SeDebugPrivilege` 才补齐。
  证据：[Win32_Process CommandLine 为 NULL](https://stackoverflow.com/questions/76199039/why-is-the-wmi-win32-process-commandline-property-null-for-only-some-processes-o)；[WMI permissions: CommandLine returns no data](https://serverfault.com/questions/193858/wmi-permissions-select-commandline-processid-from-win32-process-returns-no-dat)。
- **`Win32_Process` 没有 `Environment` 字段**，`CUDA_VISIBLE_DEVICES` 查不到。要拿只能读目标进程 PEB（需 `PROCESS_VM_READ` + 同用户/提权），所以 v0.1 干脆不回读，只认自己记录过的 pid 树。
- 每进程显存若一定要量化：任务管理器「详细信息 → 专用 GPU 内存」列可人工看；程序化路径是 GPU Process Memory 性能计数器，但有微软官方记录的**上报不准**。
  证据：[GPU Process Memory counters report incorrect value（Microsoft Learn）](https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/gpu-process-memory-counters-report-wrong-value)。
- **CIM 可能很慢**：真机上 `Get-CimInstance Win32_Process` 观测到接近 100 s 的返回时间，所以每次枚举都要设上限（当前 8 s）并缓存 4 s。

**v0.1 决定：** 归属只做「pid + exe 名 + 命令行（尽力而为）」，显存用整卡粒度，不做 per-process 显存承诺。拿不到就标 `external`，不猜。

## 2. 健康 / 异常信号

**TDR（超时检测与恢复）** 是 Windows 唯一官方的事故通道。默认超时 2 秒；恢复成功后系统弹「Display driver stopped responding and has recovered」并写入事件查看器；1 分钟内 5 次以上 GPU hang（0x117）会在第 6 次直接 bugcheck。
证据：[Timeout Detection and Recovery (TDR) — Microsoft Learn](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/timeout-detection-and-recovery)。

- 事件 ID **4101**（来源 `Display`）是社区与运维文档公认的 TDR 记录号；微软的 TDR 文档只写「记录到 Event Viewer」而未点名 ID，**ID 号本身属经验值**。
  证据：[Fix Event ID 4101 — Display Driver Recovered](https://www.visioncomputers.com/display-driver-event-4101)。
- `nvlddmkm` 来源的 **13 / 14 / 153** 是 NVIDIA 驱动自己的错误日志（掉卡、显存错误、引擎重置）。
  证据：[Event ID 13 nvlddmkm（NVIDIA 论坛）](https://www.nvidia.com/en-us/geforce/forums/gaming-pcs/8/281279/event-id-13-nvlddmkm/)；[Event ID 153 nvlddmkm（Microsoft Q&A）](https://learn.microsoft.com/en-us/answers/questions/2282086/how-to-fix-event-id-153-nvlddmkm)。

**Xid 在 Windows 上不存在。** 它是 Linux 内核态驱动（`NVRM`）打印的故障码（Xid 79 = GPU has fallen off the bus），官方 Xid 目录整篇以 Linux 驱动日志为对象。Windows 的等价物是上面那组 `nvlddmkm` 事件 + TDR。
证据：[Analyzing Xid Errors（NVIDIA）](https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html)；真实用法见 [open-gpu-kernel-modules#1440](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1440)。

消费级卡上 `nvidia-smi -q` 各字段的可用性：

| 字段 | GeForce | 说明 |
|---|---|---|
| `clocks_throttle_reasons.*` | 可用 | 温控/功耗墙判定的主力信号 |
| `temperature.gpu` / `tlimit` | 可用 | 撞温度墙可直接观测 |
| `pcie.replay_counter` | 通常可用 | PCIe 链路质量 |
| `ecc.errors.*` | 多半 N/A | GeForce 无 ECC，返回形态**待真机验证** |
| `retired_pages.*` | 多半不支持 | 面向数据中心卡，**待真机验证** |

**v0.1 决定：** 判定只采「进程存活 + 输出静默 + `nvidia-smi` 是否可读」，即 `src/rules.ts` 的 6 条短路。throttle / 温度 / PCIe replay / TDR 计数进 `doctor` 自检，不做实时判定；ECC 与 retired pages 不做功能承诺。

## 3. DCGM：Windows 不能用

DCGM 官方「Supported Platforms」只列 Linux 发行版，整页无 Windows 条目，安装前提是系统包管理器接 NVIDIA 的 Linux 仓库。
证据：[DCGM Getting Started — Supported Platforms](https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/getting-started.html)；仓库自述定位为集群环境的 datacenter GPU 管理：[NVIDIA/DCGM](https://github.com/NVIDIA/DCGM)。

所以健康判定不指望任何第三方 agent：`nvidia-smi` 加事件日志就是全部信号源，这也让"零依赖"成立。

## 4. eGPU 热拔

**Windows 侧的行为**是设备 surprise removal：GPU 从 PCIe 总线消失，D3D/CUDA 句柄失效，调用返回 `DXGI_ERROR_DEVICE_REMOVED` / `DXGI_ERROR_DEVICE_RESET`；应用必须释放并重建全部设备对象。TDR 文档明确「正确处理 Device Remove 的 D3D 应用会继续工作，旧式应用可能直接黑屏」。
证据：[TDR 文档「Desktop recovery」段](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/timeout-detection-and-recovery)；真实案例：[DXGI_ERROR_DEVICE_REMOVED（eGPU.io）](https://egpu.io/forums/expresscard-mpcie-m-2-adapters/error-dxgi_error_device_removed/)。

**最坏情况是整机挂死，不只是报错。** Linux 上有完整实证：拔掉 Thunderbolt eGPU 后 `Xid 79`，合成器卡在不可中断睡眠，只能强制断电。Windows 上是否有同等程度的整机挂死：**待真机验证**，但同属 surprise removal 语义，不能假设更安全。
证据：[open-gpu-kernel-modules#1440](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1440)。

**工程结论：**

1. 所有 GPU 查询走可 kill 的子进程 + 硬超时（当前 3 s）。`nvidia-smi` 在掉卡瞬间卡住不返回是已知形态（Linux 上甚至有永久 hang 的 issue：[#971](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/971)）。
2. 掉卡后不重试打满：连续超时只报降级文案，判定为 `suspect`（"还在跑，但显卡这一刻读不到"），**不冒充 `failed`**——任务进程其实还活着。
3. 恢复后自己爬起来，不需要重启面板。

## 5. 单 exe 打包（已实测）

| 项 | 结果 |
|---|---|
| 命令 | `bun build --compile --minify --target=bun-windows-x64` |
| exe | **109.9 MB** |
| zip（压缩后发布物） | **52.2 MB** |
| Bun 版本 | 1.4.4 |
| `--minify` | 对体积没有可测影响 |
| `--trim` | 1.4.4 **没有这个参数**，网上流传的"省 14 MB"不成立 |
| 交叉编译 | 可在 macOS 生成，但必须在 Windows 上冒烟（PATH 摘掉 node 后跑 `--version` / `doctor --json` / `ls --json`） |

**Node SEA 不可行**：单文件可执行无法从 VFS 加载 `.node`，任何原生插件都进不去。这直接排除了 `better-sqlite3`、`koffi` 系 NVML 绑定、`sharp` 一类依赖。
**Tauri / Wails / Electron 也不选**：体积更小，但要引入第二语言或依赖目标机 WebView2，对一个只画一屏的面板是过度工程。
证据：[Bun single-file executable 文档](https://bun.sh/docs/bundler/executables)；[Node SEA 限制](https://nodejs.org/api/single-executable-applications.html)。

## 6. CI 与签名

节点 `regrevia-win-runner`（Windows 11，build 26200，23.5 GB RAM，管理员身份运行），项目实例注册名 `regrevia-gpu-lease`，标签 `self-hosted,Windows,X64,regrevia-win`。

**这台节点没有 NVIDIA 显卡**，所以它能证明的只有：exe 能生成、不依赖本机 Node、无卡时诚实降级、JSON 契约稳定、SHA256 可复现。GPU 相关行为必须在有卡的机器上验，见 `docs/05-windows-verification.md`。

- 触发：`workflow_dispatch`、`push` 到 `main`、`v*` tag；**绝不接 `pull_request`**（公开仓库的自托管 runner 会让 fork 代码直接在那台机器上执行）。
- 发布：tag 触发 `gh release create`，上传 exe 与 `SHA256SUMS.txt`。
- 签名：首发不签名，首次运行被 SmartScreen 拦（微软文档定性为 "Strong SmartScreen block"）。之后走开源免费的 SignPath Foundation，或 OV 证书（$150–300/年）。

## 7. 常驻开销与 NVML 路线

`nvidia-smi` 每次调用都是起进程、重新初始化驱动上下文、解析文本。官方手册只描述 `--loop` / `-lms` 的语义（按间隔重复），**没有任何 CPU/内存开销指标**。
证据：[nvidia-smi 官方手册](https://docs.nvidia.com/deploy/nvidia-smi/index.html)。

NVML 设计为「初始化一次、长期持有」：`nvmlInit` 约 1–2 ms，之后查询是内存内调用；反复 init/shutdown 才是浪费。
证据：[ts-nvml README（Koffi 绑定 NVML，定位即"替代 spawn nvidia-smi 并解析文本"）](https://github.com/rh-aiservices-bu/ts-nvml)。

Windows 上落地只有两条路，且都不能带 `.node`：

| 路线 | 形态 | 状态 |
|---|---|---|
| `bun:ffi` 直接 `dlopen("nvml.dll")` | 进程内调用，`nvml.dll` 由驱动装在 `System32` | 目标方案，v0.2 |
| `nvidia-smi --loop-ms=2000` | 一条常驻子进程，流式读 | 保底方案，v0.2 |
| 每次 spawn `nvidia-smi` | 无状态，按需 | **v0.1 现状** |

**Windows 上 NVML 的实际开销数值待真机验证**（没有带卡设备可测）。

## 8. 已核实 / 待真机验证

**已核实（文档、issue 或本机实测）**

- WDDM 下 `--query-compute-apps=used_memory` 恒为 N/A；整卡总量可读。
- `--query-compute-apps` 不返回 `gpu_uuid`。
- `Win32_Process` 无 `Environment` 字段；跨用户 `CommandLine` 为 NULL。
- DCGM 官方不支持 Windows。
- 单 exe 109.9 MB / zip 52.2 MB；Bun 1.4.4 无 `--trim`。
- 无 NVIDIA 驱动的 Windows 上 exe 能启动并降级。

**待真机验证（需要一张真卡）**

- 消费级 GeForce 在较新 WDDM 驱动上 per-process 显存是否有部分字段可读。
- `ecc.errors.*` / `retired_pages.*` 在 GeForce 上的具体返回形态。
- TDR 事件 4101、`nvlddmkm` 13/14/153 能否在本机事件日志中读到。
- Thunderbolt eGPU surprise removal 在 Windows 上是否也会导致整机挂死。
- 掉卡瞬间 `nvidia-smi` 返回的错误码序列（`NVML_ERROR_GPU_IS_LOST` 是否出现）。
- `nvml.dll` 上用 `bun:ffi` 调用的真实开销与稳定性。

## 9. 两个分叉（已决）

1. **是否允许非单文件**：不允许。凡是需要 `.node` 的方案一律排除，SQLite 用 `bun:sqlite`，NVML 用 `bun:ffi`。
2. **是否接受首次运行的 SmartScreen 提示**：接受。首发 0 成本，签名留到有用户量之后。
