# Windows 可行性边界 & 单 exe 打包调研

> 调研对象：本地多 GPU 任务调度器（Node/TypeScript），v1 交付为 Windows 单 exe。
> 约束：低占用、双击即用、不要求用户安装 Node。
> 调研环境：macOS（darwin/arm64）。**本机无 Windows 设备**，凡涉及 Windows 运行时行为的结论均来自官方文档 / 上游 issue，无法本机复现的一律标注「未核实」。

---

## 结论速览

| # | 问题 | 结论 | 对 v1 的影响 |
|---|---|---|---|
| 1 | 进程归属 | pid 拿得到，`process_name` 基本可用，**per-process 显存拿不到**（WDDM 下恒为 N/A） | 显存按「整卡总量 − 已用」估算，不做精确分摊 |
| 2 | 健康信号 | TDR 走事件日志（4101）；**Xid 是 Linux 概念，Windows 没有** | 用「TDR 计数 + 进程消失」当异常主信号 |
| 3 | DCGM | 官方支持列表只有 Linux，**Windows 无官方支持** | 不依赖 DCGM，自己走 NVML |
| 4 | eGPU 热拔 | 设备 surprise removal，句柄失效；Linux 有整机挂死实证 | 所有 GPU 调用必须带超时 + 可降级 |
| 5 | 单 exe | Bun `--compile` 最优；Node SEA 受原生模块限制 | 用 `bun:sqlite`，禁用 better-sqlite3 |
| 6 | CI/签名 | 自托管 Windows 节点 `regrevia-win` 能编译并冒烟；不签名会被 SmartScreen 强拦 | 首发不签名 + SHA256，留 OV/Artifact Signing 升级路径 |
| 7 | 常驻开销 | 进程内 NVML ≫ 优于 `nvidia-smi --loop-ms` 子进程轮询 | 进程内 NVML，1–2s 轮询 + 事件驱动 |

---

## 1. 进程归属：nvidia-smi pid → 程序 / 任务

**能拿到 pid，拿不到显存。** 在 WDDM 驱动模型（Windows 桌面的默认模型）下，显存分配由 Windows 内核态驱动管理器统一管理，NVIDIA 驱动不知道每个进程占了多少。`nvidia-smi` 摘要表里显示 `N/A`，`nvidia-smi -q` 会直说 "Not available in WDDM driver model"。
证据：[NVIDIA 开发者论坛：GPU Memory Usage shows "N/A"](https://forums.developer.nvidia.com/t/gpu-memory-usage-shows-n-a/169140)（NVIDIA 员工 njuffa 回复）；同一行为 2013 年即有记录：[nvidia-smi reports incorrect memory usage in Windows 7/8 x64](https://forums.developer.nvidia.com/t/expected-behavior-nvidia-smi-reports-incorrect-memory-usage-in-windows-7-8-x64/31404)。

**哪些字段会 N/A：**

- `--query-compute-apps=used_memory` → **恒为 N/A**（WDDM 下全部驱动世代均如此，不是某代修好的 bug）。
- `--query-compute-apps=process_name` → **有值**，但会被截断（形如 `...ore_22.fah\FahCore_22.exe`），且非本用户进程会显示 `Insufficient Permissions`。
- `--query-compute-apps=pid` → 有值，可直接用。
- 整卡 `memory.used` / `memory.total` → 有值，可用于「总量 − 已用」估算。
证据：同上帖中 njuffa 贴出的真实 WDDM 输出（Processes 表 pid 正常、GPU Memory Usage 列全 N/A，其中一个进程名为 `Insufficient Permissions`）。

> 关于「哪代驱动改善」：没有哪一代驱动让 WDDM 下的 per-process 显存变得可读；驱动只是把提示文案从 `N/A` 改成更明确的 `Not available in WDDM driver model`（461.40 时代已如此）。TCC 模式（数据中心卡）下 per-process 显存可读。**消费级 GeForce 是否有部分字段在 WDDM 2.x 新驱动上转好：未核实。**

**把 pid 映射到「程序 / 任务」：** 用 WMI/CIM `Win32_Process` 取 `ExecutablePath`、`CommandLine`、`ParentProcessId`、`CreationDate`。
证据：[Win32_Process class（Microsoft Learn）](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)。

坑：

- `CommandLine` 对**跨用户 / 受保护 / 提权进程**会返回 `NULL`，需要以管理员或 `SeDebugPrivilege` 运行才能补齐。
  证据：[Why is the WMI Win32_Process CommandLine property NULL for only some processes](https://stackoverflow.com/questions/76199039/why-is-the-wmi-win32-process-commandline-property-null-for-only-some-processes-o)；[WMI permissions: CommandLine returns no data](https://serverfault.com/questions/193858/wmi-permissions-select-commandline-processid-from-win32-process-returns-no-dat)。
- **`Win32_Process` 没有 `Environment` 字段**，环境变量（如 `CUDA_VISIBLE_DEVICES`）无法通过 CIM 查询获得。要拿只能读目标进程 PEB（需 `PROCESS_VM_READ` + 同用户/提权），实现成本高。
  证据：上述 Win32_Process 属性列表（无 Environment 相关属性）。
- 每进程显存若一定要量化：任务管理器「详细信息 → 专用 GPU 内存」列可人工查看；程序化路径是 GPU Process Memory 性能计数器，但该计数器存在**已知上报不准**的问题。
  证据：[GPU Process Memory counters report incorrect value（Microsoft Learn）](https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/gpu-process-memory-counters-report-wrong-value)。

**v1 决定：** 归属只做「pid + exe 名 + 命令行（尽力而为）」，显存用整卡粒度。不做 per-process 显存承诺。

---

## 2. 健康 / 异常信号

**TDR（超时检测与恢复）** 是 Windows 唯一官方的事故通道。默认超时 2 秒；恢复成功后系统弹「Display driver stopped responding and has recovered」，并**写入事件查看器**；1 分钟内出现 5 次以上 GPU hang（0x117）会在第 6 次直接 bugcheck。
证据：[Timeout Detection and Recovery (TDR) — Microsoft Learn](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/timeout-detection-and-recovery)。

- 事件 ID：**4101**（来源 `Display`）是社区与运维文档中公认的 TDR 记录号；Microsoft 的 TDR 文档只描述「记录到 Event Viewer」而未点名 ID，**ID 号本身属经验值，未在官方文档中核实**。
  证据：[Fix Event ID 4101 — Display Driver Recovered](https://www.visioncomputers.com/display-driver-event-4101)。
- 还有 `nvlddmkm` 来源的 Event ID **13 / 14 / 153**，是 NVIDIA 驱动自己的错误日志（常见于掉卡、显存错误、引擎重置）。
  证据：[Event ID 13 nvlddmkm（NVIDIA 官方论坛）](https://www.nvidia.com/en-us/geforce/forums/gaming-pcs/8/281279/event-id-13-nvlddmkm/)；[Event ID 153 nvlddmkm（Microsoft Q&A）](https://learn.microsoft.com/en-us/answers/questions/2282086/how-to-fix-event-id-153-nvlddmkm)。

**Xid 在 Windows 上不存在。** Xid 是 Linux 内核态驱动（`NVRM`）打印的故障码（如 Xid 79 = GPU has fallen off the bus）。官方 Xid 目录整篇以 Linux 驱动日志为对象，Windows 上没有对应机制。Windows 的等价物是上面那组 `nvlddmkm` 事件 + TDR。
证据：[Analyzing Xid Errors with the Xid Catalog（NVIDIA 官方）](https://docs.nvidia.com/deploy/xid-errors/analyzing-xid-catalog.html)；Xid 79 的真实用法见 [open-gpu-kernel-modules#1440](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1440)。

**`nvidia-smi -q` 里各字段在消费级卡上的可用性：**

| 字段 | 消费级 GeForce | 说明 |
|---|---|---|
| `clocks_throttle_reasons.*`（SW Power Cap / HW Slowdown / HW Thermal / SW Thermal） | ✅ 可用 | 温控/功耗墙判定的主力信号 |
| `temperature.gpu`、`temperature.gpu.tlimit` | ✅ 可用 | 撞温度墙可直接观测 |
| `pcie.replay_counter` | ✅ 通常可用 | PCIe 链路质量 |
| `ecc.errors.*` | ⚠️ GeForce 无 ECC 硬件，字段多半报 N/A 或不支持 | 具体返回形态**未核实** |
| `retired_pages.*` | ⚠️ 面向数据中心卡 | GeForce 上通常为空/不支持，**未核实** |

证据：[nvidia-smi 官方手册](https://docs.nvidia.com/deploy/nvidia-smi/index.html)；字段全清单见 [`nvidia-smi --help-query-gpu` 输出](https://gist.github.com/sansmoraxz/8a98d987f12d7edc983d611b8326fc67)（含 `clocks_event_reasons.*` / `clocks_throttle_reasons.*`）。

**v1 决定：** 健康信号只采「throttle reasons + 温度 + PCIe replay + TDR 事件计数 + 进程存活」。ECC / retired pages 不做功能承诺，仅透传展示。

---

## 3. DCGM：Windows 能不能用

**不能。** DCGM 官方「Supported Platforms」只列 Linux 发行版（Amazon Linux / Debian / Fedora / RHEL / SLES / Ubuntu 等），整页无 Windows 条目；安装前提是系统包管理器接 NVIDIA 的 Linux 仓库。
证据：[DCGM Getting Started — Supported Platforms](https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/getting-started.html)；仓库自述亦定位为集群环境的 datacenter GPU 管理：[NVIDIA/DCGM](https://github.com/NVIDIA/DCGM)。

**WSL2 里跑 DCGM 的代价：** 官方支持矩阵未列 WSL2，属于**非支持组合**。即便跑通，代价是：一个常驻 WSL2 虚拟机（`vmmem` 内存占用，正是我们要避免的「低占用」反面）、`nv-hostengine` 守护进程、跨 VM 的 IPC 跳转、以及对 WSL2 GPU 半虚拟化下部分 NVML 字段不可用的风险。**WSL2 内 DCGM 能否正常出数：未核实，不建议作为 v1 依赖。**

---

## 4. eGPU 热拔

**Windows 侧的行为**是设备 surprise removal：GPU 从 PCIe 总线消失，D3D/CUDA 设备句柄失效，调用返回 `DXGI_ERROR_DEVICE_REMOVED` / `DXGI_ERROR_DEVICE_RESET`；应用必须释放并重建全部设备对象才能继续。TDR 文档明确「正确处理 Device Remove 的 D3D 应用会继续工作，旧式应用可能直接黑屏」。
证据：[TDR 文档「Desktop recovery」段](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/timeout-detection-and-recovery)；真实案例：[DXGI_ERROR_DEVICE_REMOVED（eGPU.io 论坛）](https://egpu.io/forums/expresscard-mpcie-m-2-adapters/error-dxgi_error_device_removed/)。

**最坏情况是整机挂死，不只是报错。** Linux 上有完整实证：拔掉 Thunderbolt eGPU 后 `Xid 79 GPU has fallen off the bus`，合成器卡在 `nvkms_close` 的 D 状态不可中断睡眠，只能强制断电恢复；插入正常、拔出必挂。
证据：[NVIDIA/open-gpu-kernel-modules#1440 — Surprise removal of a Thunderbolt eGPU ... hangs the system](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/1440)（复现步骤完整，含内核日志）。Windows 上是否有同等程度的整机挂死：**未核实**，但同属 surprise removal 语义，不能假设更安全。

**程序侧如何检测（工程结论）：**

1. **所有 GPU 查询走可 kill 的子进程 + 硬超时**（例如 300–800ms）。`nvidia-smi` 在掉卡瞬间卡住不返回是已知形态（Linux 上甚至有 `nvidia-smi` 永久 hang 的 issue：[#971](https://github.com/NVIDIA/open-gpu-kernel-modules/issues/971)）。
2. **用 GPU UUID 判存在性**，不要用索引号 —— 拔卡后索引会重排。
3. **认 NVML 错误码**：`NVML_ERROR_GPU_IS_LOST`、`NVML_ERROR_UNKNOWN` 表示设备已不可用；CUDA 侧对应 `cudaErrorDevicesUnavailable`。错误码名来自 NVML 头文件，**其在 Windows + eGPU 场景的实际返回值未核实**。
4. **降级状态机**：检测到掉卡 → 立即停止向该卡派发新任务 → 该卡上运行中的任务标记 `unknown`（不要标 failed）→ 等设备重新出现（同 UUID）再恢复。

---

## 5. 打包成单 exe：方案对比

| 方案 | 产物大小 | 原生模块 | 双击即用 | 交叉编译 |
|---|---|---|---|---|
| **Node.js SEA** | ≈ `node.exe` 体积（约 70–90MB，**未实测**） | ❌ 受限严重 | ✅ | 需在 Windows 上构建 |
| **Bun `build --compile`** | **实测 Windows x64 + Bun 1.4.4：exe 109.9MB，zip 52.2MB**（`--minify` 无差别，运行时占绝大部分） | ⚠️ 可用但破坏裁剪 | ✅ | ✅ 可在 mac/Linux 出 exe |
| **Tauri**（Rust + WebView2） | 几 MB + 依赖系统 WebView2 | ✅（走 Rust 侧） | ✅（前提有 WebView2） | ✅ |
| **Wails**（Go + WebView2） | 官方称「小运行时」，社区报 ~15MB | ✅（走 Go 侧） | ✅（前提有 WebView2） | ✅ |
| **Go 纯 CLI** | 5–15MB 单文件 | — | ✅（终端） | ✅ |

### Node.js SEA

制作方式两代并存：Node 20/21 时代用 `sea-config.json` 生成 blob，再用 `postject` 注入；新版（文档当前为 v26）提供 `node --build-sea sea-config.json` 一步完成，产物可直接运行（Windows 上 `signtool` 签名是可选项，不签也能跑）。
证据：[Single executable applications — Node.js 官方文档](https://nodejs.org/api/single-executable-applications.html)。

致命限制（官方原文）：**「Native addons (`.node` files) cannot be loaded directly from the VFS because `process.dlopen()` requires files on the real file system.」** 也就是说 better-sqlite3 这类 `.node` 插件无法塞进单个 exe，必须外置成散文件 —— **直接破坏「单 exe」目标**。
证据：同上文档「Using native addons in the injected main script」章节；社区同类结论：[How to bundle Node.js app to SEA along with Native Modules](https://stackoverflow.com/questions/70662886/how-to-bundle-node-js-application-to-single-executable-application-sea-along-n)；better-sqlite3 自身的路径敏感问题：[issue #1015](https://github.com/WiseLibs/better-sqlite3/issues/1015)。

平台支持：SEA 只在 Windows / macOS(arm64) / Linux 上跑 CI，Windows 是**一等公民**。
证据：同上文档「Platform support」。

### Bun `build --compile`

一条命令出 Windows exe，且**可在 mac 上交叉编译**：`bun build --compile --target=bun-windows-x64 ./src/cli.ts --outfile gpu-lease`（会自动补 `.exe`）。
证据：[Bun Docs — Executables / Cross-compile](https://bun.com/docs/bundler/executables)。

体积口径已用真机实测替换官方说法：**Windows x64 上 exe 109.9MB、zip 后 52.2MB**（`--minify` 对体积无影响，几乎全是 Bun 运行时）。早期资料里的"33MB / `--trim` 后 14MB"不适用于当前版本，v1 的发布包按 ~52MB 下载量设计；如果这个体积不可接受，唯一实质的替代是换 Rust/Go 重写核心（~8–15MB），不在 v1 范围。
证据：[Bun Docs — Smaller executables](https://bun.com/docs/compiler/size)；真实抱怨与量级参照：[oven-sh/bun#14546](https://github.com/oven-sh/bun/issues/14546)（1.1.30 hello world 即 57MB）、[HN 讨论](https://news.ycombinator.com/item?id=47657049)。

### Tauri / Wails

两者都是「系统 WebView2 + 小外壳」，不内嵌 Chromium，因此产物只有几 MB 到十几 MB。代价是**引入第二种语言**（Rust / Go）与前后端两套构建，且**强依赖目标机已有 WebView2 运行时**（Win10 1803+ 通常自带；精简版 / Server 核心版可能没有）。
证据：[Wails 官方介绍：does not embed a browser，single executable，Windows 用 WebView2](https://wails.io/docs/introduction)；体积对比参考（社区实测，Tauri 6.4MB vs Wails 15MB）：[r/golang 讨论](https://www.reddit.com/r/golang/comments/1aejybo/any_way_to_reduce_bundle_size_in_wails/)、[Tauri vs Electron vs Wails 2026 对比](https://www.digitalapplied.com/blog/desktop-apps-web-stack-tauri-electron-deno-wails-2026)（后者注明 Wails 数字为厂商自述，**未独立核实**）。

### 推荐：**Bun `build --compile --target=bun-windows-x64`**

在「低占用 + 双击即用 + 不要求装 Node」三条硬约束下它最优：

1. **真单文件**，无 WebView2 前置依赖（Tauri/Wails 的隐性外部依赖，在精简 Windows 上是真实故障点）。
2. **可在 macOS/Linux 上交叉编译出 Windows exe**，但"能不能跑"必须在 Windows 节点上验（见第 6 节）。
3. **TypeScript 直接跑**，不引入 Rust/Go 第二语言。
4. 体积可控：单 exe 约 110MB、zip 约 52MB，对一个常驻后台工具偏大但可接受；改用 Rust/Go 可降到 10MB 级，代价是开发成本。
5. 风险点明确且可规避：**禁用 better-sqlite3**，改用 `bun:sqlite`（或 Node 侧 `node:sqlite` 内置模块，避免 `.node` 外置）。

**若产品后续必须用原生扩展**（如 GPU FFI 绑定走 `koffi`，它本身就是 native addon）：退回 Node SEA 并把 `.node` 作为旁置文件分发 —— 那就**不再是单 exe**，需要重新和产品确认这条约束。

---

## 6. GitHub Actions 产 Windows exe

**构建与验收：** 走自托管节点 `regrevia-win`（标签 `self-hosted, windows, x64, regrevia-win`），不是托管镜像——目标是证明产物在"像用户的机器"上能跑。实测细节见 `docs/05-windows-verification.md`：编译单 exe → 摘掉 PATH 里的 Node 再执行 → JSON 契约逐条 `ConvertFrom-Json` → `--fake-gpu` 验解析 → 出 SHA256。注意默认 shell 是 PowerShell；自托管上不能用需要符号链接的 action（`oven-sh/setup-bun` 在 NetworkService 下 EPERM）。
证据：[GitHub Hosted Runners 文档](https://docs.github.com/en/actions/using-github-hosted-runners/about-github-hosted-runners)；[actions/upload-artifact](https://github.com/actions/upload-artifact)。

**未签名 exe 的 SmartScreen 行为：微软官方对比表给的是「❌ Strong SmartScreen block」。** 用户首次运行会看到「Windows 已保护你的电脑」，需要点「更多信息 → 仍要运行」。
证据：[Code signing options for Windows app developers — Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)。

**是否必须签名 / 成本（同一官方来源）：**

| 方式 | 成本 | SmartScreen |
|---|---|---|
| 不签名 | 0 | ❌ 强拦截，企业可能直接禁止 |
| Azure Artifact Signing（原 Trusted Signing） | **~$9.99/月** | ⚠️ 需累积信誉；地区限制：组织限美/加/欧盟/英，个人限美/加 |
| OV 证书 | **$150–300/年** | ⚠️ 同上（需 HSM/硬件令牌） |
| EV 证书 | **$400+/年** | ⚠️ **2024 起不再免拦截**，不值得为绕 SmartScreen 买 |
| 商店 MSIX | 0（微软重签） | ✅ 无警告 |
| SignPath Foundation | 开源项目免费 | OV 级签名 |

**分发：**

- **winget**：需要一份 YAML manifest（最小 singleton 需 PackageIdentifier / Version / Installer 等），`wingetcreate new` 可交互生成并自动提 PR 到 winget-pkgs。
  证据：[Create your package manifest — winget-cli 官方文档](https://github.com/microsoft/winget-cli/blob/master/doc/windows/package-manager/package/manifest.md)。
- **scoop**：需要自建 bucket 仓库存一份 manifest JSON，用户 `scoop bucket add` + `scoop install`。**官方最简要求未核实**，实操门槛低于 winget（无审核）。
- **务实路径：** 首发只发 GitHub Releases（附 SHA256），**不签名**，README 写明 SmartScreen 提示与绕过方式；有用户量后再上 Azure Artifact Signing（$9.99/月最便宜的正规方案）与 winget。

---

## 7. 常驻开销：`nvidia-smi --loop-ms` vs 进程内 NVML

**`nvidia-smi --loop-ms=`** 每次都启动一个新进程、重新初始化驱动上下文、解析文本输出。官方手册只描述 `--loop` / `-lms` 的语义（按间隔重复），**没有任何 CPU/内存开销指标**。
证据：[nvidia-smi 官方手册](https://docs.nvidia.com/deploy/nvidia-smi/index.html)（`--loop-ms` 与 `dmon -d <secs>` 均只说「按间隔采集直到 Ctrl-C」）。

**进程内 NVML 明显更省：** NVML 设计为「初始化一次、长期持有」，`Nvml.init()` 约 1–2ms，之后查询是内存内调用；反复 init/shutdown 才是浪费。
证据：[ts-nvml README（Koffi FFI 绑定 NVML，定位即「替代 spawn nvidia-smi 并解析文本」）](https://github.com/rh-aiservices-bu/ts-nvml)。

**Windows 上的落地注意：**

- `nvml.dll` 随驱动安装在 `System32`（由驱动安装器放入），Node 侧绑定需显式指向 `nvml.dll` 而非 Linux 的 `libnvidia-ml.so`。上面这个 `ts-nvml` 包**明确只支持 Linux**，Windows 需自行用 `koffi` 绑 `nvml.dll`，或找 `node-nvml` 一类绑定。
- 用 `koffi` 意味着**必须带一个原生 addon** → 单文件 exe 直接作废（Node SEA 无法内嵌 `.node`，Bun 打包也要额外释放）。NVML 必须走 `bun:ffi` 或 `nvidia-smi` 子进程。
- **Windows 上 NVML 的实际开销数值：未核实**（无 Windows 设备可测）。

**v1 决定：** 进程内 NVML 常驻 + 1–2s 轮询；进程启停、任务提交等事件触发立即刷新；`nvidia-smi` 只作为**调试 / 兜底路径**保留（带超时），不进热路径。

---

## 需要产品确认的两个分叉

1. **是否允许「非单文件」**：只要用到 better-sqlite3 或任何 `.node` 插件，单 exe 就不成立。若不允许 → 必须接受 `bun:sqlite` / `node:sqlite` 内置模块。
2. **是否接受首次运行的 SmartScreen 提示**：接受 → 0 成本发布；不接受 → 需 $9.99/月（且个人开发者仅美/加可申请）或 $150–300/年 OV 证书。

## 未核实清单（无 Windows 设备，无法实测）

- 消费级 GeForce 在较新 WDDM 驱动上 per-process 显存字段是否有任何部分恢复可读。
- `ecc.errors.*` / `retired_pages.*` 在 GeForce 上的具体返回形态。
- TDR 事件 ID 4101 在微软官方文档中的明文记载（仅社区/运维文档佐证）。
- WSL2 内 DCGM 能否正常出数及其资源代价。
- Windows 上 Thunderbolt eGPU surprise removal 是否也会导致整机挂死（Linux 已证实）。
- NVML 在 Windows + 掉卡场景返回的具体错误码序列。
- Node SEA 产物与 Bun 产物的 Windows 实测体积（本文用的是官方/社区口径）。
- scoop manifest 的官方最简要求。
