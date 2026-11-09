# GPU 任务调度 + 健康播报：竞品分析

调研时间：2026-11-09。星数用 `gh api repos/<owner>/<repo>` 在当日取快照，会随时间变化。
平台结论只认 README / docs 原文；README 没写的一律标「未核实」，不猜。

目标产品假设：Windows/Linux 本地多 GPU，管任务（谁在跑什么、排队、占卡），并把健康状态用自然语言播报出来。

---

## 一、总览

| 项目 | 星数 | 协议 | Windows | 一句话定位 |
|---|---:|---|---|---|
| XuehaiPan/nvitop | 7246 | Apache-2.0 | ✅ 官方声明 | 交互式 GPU 进程查看器 + 进程管理 API |
| wookayin/gpustat | 4387 | MIT | 未核实 | 一行一卡的 nvidia-smi 精简版 |
| wookayin/gpustat-web | 370 | MIT | 未核实 | 用 SSH 聚合多机 gpustat 的网页 |
| Syllo/nvtop | 11131 | 未核实（NOASSERTION） | ❌ 原生不支持（仅 WSL2） | htop 风格的跨厂商 GPU 监视器 |
| ml-energy/zeus | 386 | Apache-2.0 | 未核实 | 测 AI 应用能耗（焦耳/功率）的库与 CLI |
| NVIDIA/DCGM | 813 | Apache-2.0 | ❌ 官方 Linux only | 数据中心 GPU 遥测与健康诊断守护进程 |
| NVIDIA/dcgm-exporter | 1924 | Apache-2.0 | ❌ 随 DCGM，Linux only | DCGM 遥测 → Prometheus 指标 |
| prometheus/node_exporter | 13912 | Apache-2.0 | ✅ | 主机指标 exporter（不含 GPU） |
| skypilot-org/skypilot | 10809 | Apache-2.0 | ❌ 原生（需 Linux/WSL） | 跨云/K8s 的 GPU 编排 |
| dstackai/dstack | 2308 | MPL-2.0 | ⚠️ 仅 WSL2 / CLI | 异构算力统一编排 + run 面板 |
| SchedMD/slurm | 4509 | GPL-2.0（NOASSERTION） | ❌ | Linux 集群作业调度器 |

---

## 二、逐个调研

### 1. XuehaiPan/nvitop — 7246★ / Apache-2.0 / 2026-11-02

**定位**：一条命令看所有卡和所有进程，并能对进程发信号、杀进程的 TUI。

**Windows**：README 明写 “Portable: work on both Linux and Windows”，附 Windows Terminal 截图；代价是 `windows-curses`，鼠标等行为可能不一致。
URL：https://github.com/XuehaiPan/nvitop

**窗口里看到什么**
- 每卡的利用率、显存、温度、功耗、风扇、时钟，柱状图 + 历史曲线。
- 进程树：PID、用户、命令行、显存、计算/图形类型（C/G），可排序、筛选。
- 进程环境变量、快照导出、`nvitop-exporter` + Grafana 面板。

**缺什么**
- 只有「当下」，没有队列：不能提交任务、不能排队、不能占卡预留。
- 没有任务语义：能看到 `python train.py`，不知道它属于哪个实验/哪次跑、跑到第几步。
- 没有健康判定与推送：只有颜色变化，没有“这次要挂了”的结论，也没有 IM/桌面通知。
- 跨机要自己拼 exporter + Prometheus + Grafana。

### 2. wookayin/gpustat — 4387★ / MIT / 2026-10-08

**定位**：把 `nvidia-smi` 压成一行一卡的文本，给 `watch` 和脚本用。

**Windows**：README 全篇未出现 Windows；实现依赖 `nvidia-ml-py` + 驱动，理论上能跑，**未核实**。
URL：https://github.com/wookayin/gpustat

**看到什么**：`-p/-c` 时列出进程 PID、用户、命令、显存；支持 NVIDIA / AMD ROCm / 华为 Ascend。
**缺什么**：无历史、无告警、无交互界面、无任务归属；本质是格式化查询。

### 3. wookayin/gpustat-web — 370★ / MIT / 2026-02-17

**定位**：浏览器里聚合多台机器的 gpustat（README 自称 alpha）。

**Windows**：未声明；运行方式是 SSH 到各节点执行 gpustat，Windows 只能作为「浏览器端」，**未核实**。
URL：https://github.com/wookayin/gpustat-web

**看到什么**：多机多卡的实时进度条与占用表。
**缺什么**：alpha 阶段、异常处理不完善；只读聚合，无历史、无告警、无任务队列；节点必须开 SSH。

### 4. Syllo/nvtop — 11131★ / 协议未核实 / 2026-11-08

**定位**：htop 式跨厂商 GPU/加速器监视器（AMD、Intel、Apple、NVIDIA、Ascend、Adreno 等）。

**Windows**：**原生不支持**。README 的支持列表全是 Linux 驱动；Windows 只有 WSL2 一节（在 WSL2 里透传厂商驱动才可用）。
URL：https://github.com/Syllo/nvtop

**看到什么**：每卡曲线 + 进程列表 + 交互式设置窗口。
**缺什么**：无 Windows 原生、无队列、无告警、无任务语义；协议在 GitHub 上是 NOASSERTION，商用前需人工读 LICENSE。

### 5. ml-energy/zeus — 386★ / Apache-2.0 / 2026-11-04

**定位**：量 AI 应用的能耗（时间、焦耳、功率），顺带做能耗优化。

**Windows**：README 未声明 Windows；测量依赖 NVML 与平台能量计数器，**未核实**。
URL：https://github.com/ml-energy/zeus

**看到什么**：程序级/GPU 级的能耗与功率时间序列、CLI 与 Python API。
**缺什么**：不是看板也不是调度器；无进程编排、无告警通道、无多机任务视图。

### 6. NVIDIA/DCGM（nv-hostengine）— 813★ / Apache-2.0 / 2026-10-27

**定位**：数据中心的 GPU 遥测 + 健康诊断：XID、ECC、NVLink、PCIe、热/功耗违规、`dcgmi diag`。

**Windows**：**不支持**。官方写明 “DCGM supports Linux operating systems on x86_64, and aarch64”。
URL：https://github.com/NVIDIA/DCGM ｜ https://developer.nvidia.com/dcgm

**看到什么**：字段级遥测、健康检查、策略与告警事件（数据中心口径）。
**缺什么**：没有任务/进程语义；部署是驱动级守护进程，个人机偏重；Windows 完全缺席；播报要自己接。

### 7. NVIDIA/dcgm-exporter — 1924★ / Apache-2.0 / 2026-11-06

**定位**：把 DCGM 字段转成 Prometheus 文本指标，附官方 Grafana dashboard 与 Helm chart。

**Windows**：**不支持**（依赖 DCGM；部署走容器/Helm）。
URL：https://github.com/NVIDIA/dcgm-exporter

**看到什么**：`DCGM_FI_*` 指标族，Grafana 里出曲线。
**缺什么**：只出数字；判定、播报、告警规则全要人写 PromQL + Alertmanager。

### 8. prometheus/node_exporter — 13912★ / Apache-2.0 / 2026-11-02

**定位**：主机指标 exporter（CPU、内存、磁盘、网络、负载）。

**Windows**：**支持**（官方发布含 windows-amd64 包；部分 collector 仅 Linux）。
URL：https://github.com/prometheus/node_exporter

**缺什么**：**完全没有 GPU 指标**。GPU 要靠 dcgm-exporter（Linux）或 nvidia_gpu_exporter（有 Windows 版）。

### 9. Prometheus + node_exporter + dcgm-exporter + Grafana（标准栈）

**定位**：事实标准：采集 → 存储 → 看图 → 阈值告警。不是单个仓库，是四件套拼装。

**Windows**：半可用。Prometheus/Grafana 有 Windows 构建，dcgm-exporter 不行；Windows 上的等价物是 `windows_exporter` + `nvidia_gpu_exporter`。
URL：https://github.com/prometheus/prometheus ｜ https://grafana.com/grafana/dashboards/

**看到什么**：任意时间窗的曲线、面板、Alertmanager 告警。
**缺什么**：全是数字，没有人话结论；“这堆 python 进程各自在干什么”这一层根本不在模型里；面板与告警规则要自己搭自己维护。

### 10. skypilot-org/skypilot — 10809★ / Apache-2.0 / 2026-11-09

**定位**：把碎片算力（云、K8s、SSH 集群）变成一台「AI 超级计算机」，`sky launch/serve` 提交作业。

**Windows**：**不支持原生**；安装文档在 Windows 上要求走 WSL（“Use WSL on Windows”）。
URL：https://github.com/skypilot-org/skypilot

**看到什么**：集群/作业列表、成本、跨云状态。
**缺什么**：解决的是「去哪找卡」，不是「本机这几张卡谁在跑什么」；本地 Windows 多卡不在射程内；无健康播报。

### 11. dstackai/dstack — 2308★ / MPL-2.0 / 2026-11-06

**定位**：统一控制面，跨 GPU 云 / K8s / VM / 裸金属跑训练与推理，带 Web UI 看 run。

**Windows**：server 可装在 Windows（**仅 WSL 2**），CLI 原生支持 Windows；本机 Windows GPU 不做一等公民。
URL：https://github.com/dstackai/dstack

**看到什么**：run 列表、日志、资源与状态。
**缺什么**：面向远程算力与团队协作；本机多卡排队、进程级归因、自然语言健康播报都不在范围。

### 12. SchedMD/slurm — 4509★ / GPL-2.0 / 2026-11-06

**定位**：Linux 集群作业调度器：队列、资源分配、cgroups 隔离、公平共享、记账、抢占、多节点。

**它解决了什么**：多用户多节点下的「谁能用几张卡、排多久、用完记多少账」，这是学术/企业集群的刚需。
URL：https://slurm.schedmd.com/overview.html

**为什么个人机器不用**
- 组件重：`slurmctld` + `slurmd` + `munge` + cgroup 配置，单机等于给自己造运维负担。
- 只面向 Linux 集群（官方定位 “for Linux clusters”），Windows 无解。
- 单机 2–8 卡的冲突概率低，排队收益 < 配置成本。
- 它给的是作业状态与记账，**不给**“这条训练曲线是不是要崩”的健康判断。

---

## 三、中小型「GPU 任务看板 / 告警」项目（自行检索）

关键词命中量（GitHub 搜索 total_count，2026-11-09）：`gpu monitor` 4770、`gpu dashboard` 1528、`gpu queue` 578、`comfyui queue` 202、`gpu alert` 363。**供给极多，但绝大多数停在图表层**。

| 项目 | 星数 | 协议 | Windows | 定位 | 看到什么 | 缺什么 |
|---|---:|---|---|---|---|---|
| psalias2006/gpu-hot | 1643 | MIT | 未核实（仅 Docker） | 实时 NVIDIA 看板，单机/多机 hub | 亚秒级指标、历史曲线、PID+显存、系统指标 | 进程无命令行/任务语义、无队列、无告警 |
| utkuozdemir/nvidia_gpu_exporter | 1582 | MIT | ✅ 原生 exe | 用 nvidia-smi 或 NVML 出 Prometheus 指标 | XID、能耗、MIG、PCIe、NVLink、进程指标 | 只出指标，判定/播报要自建 |
| jizongFox/GPUQueues | 12 | 无 LICENSE | 未核实 | 极简 GPU 任务数组调度，按空闲卡分 `CUDA_VISIBLE_DEVICES` | 终端输出任务成功/失败 | 无 UI、无健康、无告警、无观测 |
| sakmor/ComfyQueueBar | 4 | MIT | ❌（macOS 原生） | macOS 菜单栏看 ComfyUI 队列 | 队列项、进度、优先级、中断 | 绑定 ComfyUI + macOS，无跨任务/多卡语义 |

**读法**：`gpu-hot` 证明「好看的实时看板」已经卷到 1.6k 星；`nvidia_gpu_exporter` 证明「Windows 上出 GPU 指标」已有现成答案；`GPUQueues` 与 `ComfyQueueBar` 说明「队列」这一步只有玩具级实现，且各自绑死一个场景。

---

## 四、Windows 桌面侧的既有替代品

| 工具 | 能看到 | 看不到 |
|---|---|---|
| 任务管理器 → 详细信息 → GPU 列 | 每个进程的 GPU 占用%、专用/共享显存、引擎类型（3D / Copy / Video Decode / Encode / Compute）；性能页整卡曲线 | 「这堆 python.exe 各自在跑哪个任务」；显存里是什么模型；超过 60 秒的历史；任何告警 |
| GPU-Z | 卡级传感器：核心/显存频率、温度、功耗、电压、PCIe 链路、VRel、节流原因，可存 CSV | 进程级归因；任务/队列；告警通道 |
| HWiNFO | 全机传感器（温度、功耗、电压、风扇、节流），可记录 CSV、OSD、远程 | 任务语义；进程级显存明细要另配；告警要自己设 |
| MSI Afterburner + RivaTuner | 超频、风扇曲线；RTSS 在游戏画面上叠 FPS/占用/温度 | 非游戏负载的进程归因；队列；CI 式告警 |
| NZXT CAM | 一体式监控（温度、负载、风扇、泵速）、游戏 FPS 叠加 | CUDA 任务、进程级显存、告警规则；面向自家硬件与游戏 |
| Windows 性能计数器 `GPU Engine` | `\GPU Engine(*)\Utilization Percentage`，实例名含 pid 与引擎类型，可 perfmon/typeperf 采集 | 显存要另用 `GPU Process Memory`（Win10 有已知错值）；命令行/任务身份；健康判定 |

参考：https://devblogs.microsoft.com/directx/gpus-in-the-task-manager/ ｜ https://learn.microsoft.com/en-us/answers/questions/1536413/performancecountercategory-gpu-engine-getinstancen ｜ https://www.techpowerup.com/gpuz/ ｜ https://www.hwinfo.com/ ｜ https://www.msi.com/Landing/afterburner ｜ https://nzxt.com/software/cam

**共同盲区（本节结论）**
1. 全部以「进程」为单位，且 Windows 上进程名只有 `python.exe`，PVM/conda 多环境更是同名。
2. 全部只给瞬时数值，没有「这个任务健康吗」的判定。
3. 全部没有队列与准入：谁先占卡、等多久，无人回答。
4. 告警要么没有，要么要求用户自己写规则。

---

## 五、结论：空白在哪

1. **数字仪表盘已经过剩，且头部极强。**
   `gpu monitor` 4770 个仓库、`gpu dashboard` 1528 个；nvitop 7246★、nvtop 11131★ 已覆盖 TUI/跨厂商/进程管理；Windows 侧还有任务管理器、GPU-Z、HWiNFO 免费覆盖卡级传感器。再做一块「好看的数字面板」没有增量。

2. **「进程」到「任务」的语义层，全行业没人做。**
   NVML / `nvidia-smi` 只给 pid、进程名、显存（https://docs.nvidia.com/deploy/nvidia-smi/index.html）；nvitop 最多补到命令行与环境变量；Windows 任务管理器只有 `python.exe` + 引擎占用。**谁在跑什么实验、属于哪个队列条目、进度如何**——没有产品回答。

3. **健康判定停在阈值，不在「判定」。**
   DCGM 有 XID/ECC/热违规字段与 `dcgmi diag`，但官方只支持 Linux 数据中心（https://developer.nvidia.com/dcgm）；dcgm-exporter 只把字段转成指标（https://github.com/NVIDIA/dcgm-exporter）；Grafana 路线要求用户自己写 PromQL 与告警规则。没有工具会主动说「这张卡的 ECC 在涨，这次训练大概率白跑」。

4. **主动播报没有产品化。**
   nvitop、gpustat、nvtop、gpu-hot 的 README 功能列表里都没有 alert/notify 模块；中小项目里只有 ComfyQueueBar 做到菜单栏提示，且绑死 ComfyUI + macOS。要「自然语言健康播报」，今天只能自己拼 Alertmanager + 模板 + IM webhook。

5. **Windows 原生是结构性空白，「四者交集」为空。**
   DCGM 不支持 Windows；nvtop 只在 WSL2；gpu-hot 只有 Docker；gpustat/zeus 未声明 Windows；skypilot 要求 WSL。Windows 上能用的只有 `nvidia_gpu_exporter`（只出指标，1582★）与桌面传感器工具（无任务语义）。**Windows + 多卡 + 任务语义 + 主动播报，目前没有竞品。**

---

## 六、核实方式与未核实清单

核实命令（逐仓库执行）：
```bash
gh api repos/<owner>/<repo> --jq '[.stargazers_count,.license.spdx_id,.pushed_at[0:10]]|@tsv'
```
平台结论来自 README 原文抓取：
```bash
gh api repos/<owner>/<repo>/contents/README.md --jq .content | base64 -d | grep -inE "windows|wsl|linux"
```

**未核实 / 需人工确认**
- gpustat、gpustat-web、zeus、gpu-hot、GPUQueues 的 Windows 支持：README 未声明，未实测。
- nvtop 的 SPDX：GitHub 返回 NOASSERTION，LICENSE 文本未逐字比对（业界通行说法为 GPL-3.0）。
- slurm 的 SPDX：同上，COPYING 为 GPL-2.0 文本。
- gpu-hot 在 Windows 上的实际可用性：只有 Docker + NVIDIA Container Toolkit 路径，未在 Windows 实测。
- 各项目「窗口里看到什么」基于 README 截图/功能列表，未逐个安装运行。
