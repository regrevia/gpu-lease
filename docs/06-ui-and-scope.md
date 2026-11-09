# 面板复用与 Windows-only 收窄

两件事定下来：**面板能不能从现成项目搬**，以及**只做 Windows 之后范围怎么变**。

## 1. 结论：搬"语法"，不搬"代码"

我把 GitHub 上以 `gpu monitor` 为名、按 star 排前 12 的项目逐个查了许可证和活跃度。结果对"直接复用一个好看面板"这个想法不利：

| 项目 | star | 许可 | 状态 | 能搬吗 |
|---|---|---|---|---|
| `XuehaiPan/nvitop` | 7246 | Apache-2.0 | 活跃 | ✅ **TUI 的布局语法可搬**（保留 NOTICE） |
| `wookayin/gpustat-web` | 370 | MIT | 活跃 | ✅ **单页 Web 骨架可搬** |
| `Syllo/nvtop` | 11131 | GPL-3.0 | 活跃 | ❌ 进 MIT 项目即污染 |
| `mountassir/gmonitor` | 209 | GPL-3.0 | **2019 停更** | ❌ 许可 + 死项目 |
| `evilsocket/gptop` | 96 | NOASSERTION | 活跃 | ❌ 许可不明 |
| `Asimok/GPU-Monitor` | 47 | **无** | 2024 | ❌ 无授权 = 保留所有权利 |
| `NVIDIA/gpu-monitoring-tools` | 1072 | Apache-2.0 | 2021 停更，Linux only | ❌ 不是面板 |

也就是说：**市面上没有一个"好看的、可合法复用、Windows 原生"的 GPU 面板**。能合法搬的两个都不是 Windows 面板，而且都缺我们要的那一层信息。

### 为什么整块搬不划算

它们的信息模型只有四个字段：`index / name / util / memory`。我们的每一行要比它多三样：

- **归属**：这个 pid 属于哪个 dsh 会话的哪个任务（它们只有 pid 和进程名截断）；
- **判定**：正常 / 卡住 / 可疑 / 已断联（它们没有状态列）；
- **进度**：第 12/40 张、epoch 3/10、下载 62%（它们没有进度列）。

字段对不上的结果是：搬来的组件要改八成，还不如按它们的**视觉语法**重写。真正值得拿的是：

1. **一卡一区块 + 进程子行缩进**（gpustat-web 的结构，MIT）；
2. **条形图的字符与配色纪律**（nvitop：8 色、满格用色块、不用渐变）；
3. **表格密度**（nvitop 一行一卡，不画卡片不画阴影）。

这三样是"看起来专业"的来源，且是我们的代码，不欠许可债。

## 2. 面板形态（v0.1 定稿）

| 形态 | 何时 | 技术 | 体积代价 |
|---|---|---|---|
| **TUI**：`gpulease watch` | v0.1 | Bun 自带 ANSI 绘制 | 0 |
| **浏览器单页**：`127.0.0.1:7788` | v0.1 | 内嵌 HTML + SSE，无框架 | ~30 KB |
| **托盘 + 气泡** | v0.2 | Win32 托盘 + Windows 通知 | 极小 |
| **桌面窗口** | 不做 | — | — |

不引入 Electron（+150 MB）、不引入 WebView2 运行时依赖（系统自带，但 v0.1 不需要）、不引入前端框架（一个 SSE 加 `textContent` 赋值就够）。

面板的定位是**判决书**，不是仪表盘：一屏之内回答"哪张卡在跑什么、正常吗、要不要我做什么"。所以它天然比 nvitop 那种纯数字表**更少列、更多句子**。

## 3. Windows-only：砍掉什么

确认只做 Windows 之后，范围直接砍掉一半：

- ❌ NVML 双平台 dlopen（`libnvidia-ml.so`）
- ❌ Linux 权限模型、容器 / nvidia-docker、systemd unit
- ❌ DCGM 与 Xid 事件（Linux 专属）
- ❌ SLURM / SkyPilot / k8s 集成
- ❌ HPC 多机场景

## 4. Windows-only：背上什么（必须做对的）

| 事项 | 事实 | 对策 |
|---|---|---|
| 按进程显存拿不到 | WDDM 下 `--query-compute-apps=used_memory` 恒 N/A | 只报整卡显存 + 把进程归属到 pid 树；文案说"卡满了"，不说"你的任务占了 18.2G" |
| 跨用户进程看不到命令行 | 提权/跨会话进程 `CommandLine` 为空 | 标 `external` + 名字 + pid，绝不猜 |
| 外接显卡会热拔 | `NVML_ERROR_GPU_IS_LOST` / `DXGI_ERROR_DEVICE_REMOVED` | 按 GPU UUID 认卡；任务标 `unknown` 不标 `failed` |
| 驱动崩溃看不到 | TDR Event 4101、`nvlddmkm` 13/14/153 | 读 Windows 事件日志，这是 Windows 上最接近 Xid 的信号 |
| 未签名会被拦 | SmartScreen 强拦 | SHA256 + 安装说明；后续 OV 或 SignPath OSS |
| 要能开机自起 | 用户的训练可能跑一夜 | `gpulease service install`（Windows 服务），不是计划任务 |

## 5. "做专业一点" = 六条可验收的硬标准

每条都要能在 CI 或诊断包里被验，否则不算：

1. **产物可校验**：每个 Release 带 `SHA256SUMS.txt`，README 写明校验命令。
2. **崩溃可见**：未捕获异常写 `%LOCALAPPDATA%\gpulease\logs\`，`gpulease doctor --bundle` 一键打诊断包（版本、驱动、适配器列表、事件日志片段、脱敏路径）。
3. **不装驱动、不碰注册表**（除服务注册）、不常驻高 CPU：分级轮询 2s 活动 / 5s 空闲 / 窗口不可见退避。
4. **文案纪律**：界面字符串只允许标签、值、动作、以及会改变用户下一步的后果。不写实现细节。
5. **发布纪律**：语义化版本 + CHANGELOG + tag 触发自动发布（`windows-gate.yml` 已就位）。
6. **诚实边界**：文档里每条"支持"都对应一条 gate 断言；验不了的写"按资料推断"，不写成"已支持"。

## 6. 许可债清单

第三方代码只有一处可能进来（gpustat-web 的页面骨架），所以维护 `docs/THIRD-PARTY.md`：项目名、许可、用在哪、NOTICE 要求。自己写的全部 MIT。

GPL 项目（nvtop、gmonitor）连片段都不抄——它们连"参考实现"的注释都不该出现在代码里，只写进设计文档的竞品分析。
