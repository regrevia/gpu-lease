# gpulease · 显卡值班员

一台机器上几张卡，跑着训练、ComfyUI、推理服务、下载。任务管理器里它们**全都叫 `python.exe`**。
你真正想知道的只有三件事：**这是哪个任务？它还正常吗？出事了叫我。**
gpulease 就是替你看住这张卡的值班员。

```
$ gpulease ls
正常  2026/11/10 18:59  「训练 SDXL LoRA」在跑，正常 · 42% · 420/1000 · 还剩 47 秒
正常  2026/11/10 18:41  「ComfyUI 批量」在跑，正常 · 65% · 13/20 · 还剩 2 分钟
卡住  2026/11/10 17:12  「下载 FLUX 模型」已经 15 分钟没有输出了，可能卡住
失败  2026/11/10 16:03  「测评」退出码 137，失败了
```

（这是 v0.2 的输出形状：进度只报日志里真读到的数；读不到就不给数字，不给假数字。）

v0.4 加了历史：`gpulease history` 把每张卡最近 30 分钟画成方块曲线（`--minutes 120` 看更久，`--gpu 1` 只看一张），值班进程每 15 秒记一行、留 24 小时——没有采样就直说没有，不拿 0 冒充"显卡很闲"。`gpulease doctor --soak --seconds 30` 量出值班自己的每轮耗时、CPU 与内存，数字直接进发布说明；值班进程自己炸了会在 `logs/daemon-crash-*.log` 留现场，`doctor --bundle` 一起带走。

v0.3 加了排队：`gpulease submit --name "训练 SDXL LoRA" --need-vram 12 -- python train.py` 入列，`gpulease daemon` 常驻按每张卡的余量挑卡起跑，跑挂/断联自动让出卡位，出事推 `alerts`。命令与样例见 [变更记录](CHANGELOG.md#030)。

## 下载（Windows）

**[gpulease 0.7.0](https://github.com/regrevia/gpu-lease/releases/tag/v0.7.0)** → `gpulease-windows-x64.zip`（54,747,790 字节 / 52.2 MB，SHA256 `27297520…31be16`），解压得到 `gpulease.exe`（115,340,288 字节 / 110 MB，SHA256 `c970977c…2a44c3`）。
旁边 `SHA256SUMS.txt` 里有 exe 与 zip 两行，先核对再运行：

```powershell
Get-FileHash .\gpulease-windows-x64.zip -Algorithm SHA256   # 和 SHA256SUMS.txt 里 zip 那行比
```

未签名，首次运行会被 SmartScreen 拦一次（更多信息 → 仍要运行）。没有显卡的机器也能跑，`doctor` 会直说没有 NVIDIA 卡。

装进系统（可选，装完任何终端里都能直接敲 `gpulease`）：

```powershell
.\gpulease.exe install --autostart   # 放 %LOCALAPPDATA%\gpulease\bin + 用户 PATH + 开始菜单 + 登录后自启值班
.\gpulease.exe install               # 不想要自启就去掉 --autostart
.\gpulease.exe uninstall --purge     # 连程序文件和状态目录一起删
```

升级就是下载新版、再跑一次 `install`。细节与排障：[安装与排障](docs/07-install-and-troubleshooting.md)。

## 为什么做这个

- GitHub 上 `gpu monitor` 有 4770 个仓库、`gpu dashboard` 1528 个 —— **数字层已经过剩**。
- 但 NVML / 任务管理器只给 pid 和利用率，**没有任务语义、没有健康判定、没有主动告警**。
- Windows 原生 + 多卡 + 任务语义 + 主动播报，这个交集**目前没有竞品**：DCGM 只支持 Linux、nvtop 只在 WSL2、gpu-hot 只有 Docker，Windows 上只有指标导出器和传感器工具。

详见 [竞品分析](docs/research/competitors.md)。

## 它是什么

| 层 | 做什么 |
|---|---|
| 归属 | 托管启动注入 task_id，进程树精确可追溯；外部进程可 attach，不猜 |
| 进度 | 读任务日志尾巴：tqdm / ComfyUI 进度条、下载大小、`Epoch 3/10`、`step 420/1000`，归一成 `{percent,label,eta}` |
| 判定 | 12 条健康规则 → `正常 / 变慢 / 停滞 / 疑似 / 失败 / 断联` |
| 播报 | 模板生成的人话，异常置顶；托盘气泡 + ntfy 推手机 |
| 调度（v0.5+） | 租约 + 等待队列 + 空占用回收 + 断联迁移 |
| 会话（v0.7+） | 任务带会话号，`sessions` 按会话汇总在跑 / 排队 / 最差 / 整体进度；多会话同时起活不撞库 |

**它不是仪表盘。** 仪表盘回答"用了多少"，它回答"谁在跑、还活着吗、要不要管"。

## 用法

一个 exe，六条命令。托管启动这一条是根：只有我们起的任务，我们才敢说归属。

```powershell
gpulease run --name "训练 SDXL LoRA" --gpu 0 -- python train.py
gpulease run --name "ComfyUI" --gpu 1 -- python main.py --port 8188
gpulease ls                # 一行一个任务，人话结论
gpulease watch             # 终端面板，2 秒刷新，q 退出
gpulease serve             # 浏览器面板 http://127.0.0.1:7788
gpulease doctor            # 自检；--bundle 出诊断包
```

`run` 会把子进程的 stdout/stderr 同时写进日志（`<状态目录>\logs\<run id>.log`）和终端，退出码原样传回，所以它可以直接替换你原来的启动命令。

单文件、无运行时依赖、不发网络请求。[技术决策](docs/03-architecture.md) · [第三方与许可证](docs/THIRD-PARTY.md)

## 只做 Windows

Linux、容器、多机、SLURM 一律不做。换来的是：一条验收线、一套权限模型、一个诚实的信息模型（Windows 拿不到按进程显存，就说整卡占用，不编数字）。面板只保留三种形态：终端 TUI、`127.0.0.1:7788` 单页、v0.2 的托盘气泡。不引入 Electron、不引入前端框架。

面板的视觉语法借自两个可合法复用的项目（nvitop 的 TUI 密度、gpustat-web 的单页结构），代码自己写；GPL 项目只看不抄。详见 [面板复用与范围收窄](docs/06-ui-and-scope.md)。

## Windows 验收

产物不是"我们机器上编译过"，而是在真的 Windows 上跑过才算数。自托管节点 `regrevia-gpu-lease`（Windows 11，管理员服务）承接 `.github/workflows/windows-gate.yml`：编译单文件 exe → 摘掉 PATH 里的 Node 再跑 → `doctor --json` 必须诚实报告无卡 → `run` 真起子进程且 stdout 被转发 → `ls --json` 能查到这条记录且判定为正常 → 子进程退出码 7 原样传回 → 出 SHA256 → tag 才发 Release。

那条节点**没有 NVIDIA 显卡**，所以它验的是打包、CLI/JSON 契约、托管启动、进程归属、无卡降级；显卡数字与多卡行为要靠真机 `gpulease doctor --bundle` 的输出补。细节见 [Windows 真机验收](docs/05-windows-verification.md)；每条结论对应哪条证据（节点 / 夹具 / 待真机）见 [v1.0 验收矩阵](docs/09-acceptance.md)。

实测体积：**exe 110 MB，zip 52.2 MB**（Bun 运行时占绝大部分，`--minify` 无差别）。比调研阶段的官方口径大得多，按这个数字设计下载与首启体验。

## 文档

| 文档 | 内容 |
|---|---|
| [五分钟上手](docs/QUICKSTART.md) | 装上、看一眼卡、托管一个任务、看进度、排队换卡 |
| [CLI 与 JSON 契约](docs/08-contract.md) | v1.0 冻结：命令、退出码、每个 `--json` 的字段、HTTP 路由、semver 规则 |
| [v1.0 验收矩阵](docs/09-acceptance.md) | 每句「支持」的证据来源；剩下哪几条只能在有卡的机器上验 |
| [安装与排障](docs/07-install-and-troubleshooting.md) | 装、升级、卸、七种常见现象怎么查 |
| [产品设计](docs/02-product-design.md) | 命题、用户、核心概念、播报规则表、面板、路线 |
| [技术架构](docs/03-architecture.md) | 模块、采集、归属、适配器、规则引擎、API、打包 |
| [竞品分析](docs/research/competitors.md) | 11 个同类项目 + Windows 桌面工具 + 空白在哪 |
| [Windows 与打包](docs/research/windows-and-packaging.md) | WDDM 显存限制、TDR/Xid、DCGM、eGPU、exe 方案 |
| [面板与范围](docs/06-ui-and-scope.md) | 哪些能复用、为什么只做 Windows、六条专业标准 |
| [第三方与许可证](docs/THIRD-PARTY.md) | 参考过什么、GPL 项目为什么只看 |
| [变更记录](CHANGELOG.md) | 每个版本加了什么、边界在哪 |

## 目前范围

已做（v0.7）：采集 + 托管启动 + 归属 + 判定 + 进度 + `ls` / `watch` / `serve` 三个入口 + `doctor` 自检 + 诊断包 + 排队与常驻值班选卡 + 告警（冷却、`recovered` 照发）+ 占用率历史（`history`）+ 值班崩溃现场 + 开销自测（`doctor --soak`）+ `install` / `uninstall` + 任务认会话（`--session` / `DSH_SESSION_ID`）+ `sessions` 按会话汇总。
在做（1.0）：按 [验收矩阵](docs/09-acceptance.md) 补齐真机八项（显卡读数、WDDM 显存、真负载判定、eGPU 热拔、TDR、真训练进度、真多任务调度、TUI），再复核一次契约冻结。
没做：托盘气泡、自动杀、多机、Linux / macOS 的生产支持。这些按 [路线](ROADMAP.md) 排。

**验收标准：第一眼能看出"原来这是我的训练在跑，跑到哪了"。**

## 状态

v0.4.0 已发布（[release](https://github.com/regrevia/gpu-lease/releases/tag/v0.4.0)，tag run `42713747045`）：`run` / `ls` / `watch` / `serve` / `submit` / `queue` / `cancel` / `daemon` / `alerts` / `history` / `doctor` 在本机 macOS 与 Windows 自托管节点上都跑过，`bun test` 92 条绿 / 242 断言，Windows 门禁（run `42696447220`）17 步全过，真机验到"历史跨值班进程重启累积""稀疏曲线留白不画成 0""浸泡量出监控自己的 CPU 与内存"。显卡数字（多卡、eGPU 断联、真机刷新间隔）还需要有卡的机器验。MIT。

v0.5.0 可下载（[release](https://github.com/regrevia/gpu-lease/releases/tag/v0.5.0)，tag run `42763081158`）：`install` / `uninstall` 在自托管 Windows 节点的真注册表、真用户 PATH 上装过、敲过、卸过（门禁 `42762620953` 20 步全绿）；这一步先抓出「卸完用户 PATH 还原不了」，修掉之后才打的 tag。`bun test` 112 条绿 / 282 断言。节点上没有 NVIDIA 卡，显存读数、按进程显存、eGPU 断联仍然只有假 SMI 覆盖的逻辑路径，没在真卡上验过。

v0.6.0 可下载（[release](https://github.com/regrevia/gpu-lease/releases/tag/v0.6.0)，tag run `42782258490`）：任务认会话——`--session`、`GPULEASE_SESSION`、`DSH_SESSION_ID` 三条来源，`ls` / `watch` / `serve` 面板 / `queue` 都标出「哪个会话的任务」；队列任务派出去时认入队时记的会话，daemon 自己的环境不覆盖；老库启动自动加列，不丢历史。门禁 20 步全绿，真机上验了「`--session` 原样落库」与「没给就是 null」。`bun test` 123 条绿 / 311 断言。节点没有 NVIDIA 卡，显存与按进程占用仍只有假 SMI 覆盖的逻辑路径。

v0.7.0 可下载（[release](https://github.com/regrevia/gpu-lease/releases/tag/v0.7.0)，tag run `42811132081`）：多开会话时按会话收口——`gpulease sessions` 一行一个会话，带在跑几个、排队几个、最差判定、整体进度（只平均真报了百分比的任务，并写明覆盖几个；一个都没报就说「进度看不到」）；`ls` / `watch` / `serve` 底部也跟着出小结，两个以上会话才出现。同时修掉多会话同时 `run` 时的 `database is locked`：先设 `busy_timeout` 再切 WAL，切不动就退让重试；4 会话同起进回归。门禁 `42807901871` 20 步全绿，真机上验了排队任务按会话出现在 `sessions --json` 里、人读输出带短名；tag run 重建后同号。`bun test` 130 条绿 / 346 断言。值班自身开销 11 tick、平均 403.5 ms、CPU 0.9%、RSS 27.5 MB。节点没有 NVIDIA 卡，显存与按进程占用仍只有假 SMI 覆盖的逻辑路径。

## 没有 NVIDIA 卡也能验

门禁跑在一台没有 NVIDIA 显卡的 Windows 机器上。为了不把"有卡时的逻辑"降级成"在 mac 上看看解析函数"，`nvidia-smi` 这一层是可注入的：

```powershell
$env:GPULEASE_SMI = "<bun 的绝对路径> test\\fixture\\smi.ts"
$env:GPULEASE_SMI_SCENARIO = "two-gpu"    # two-gpu | single | absent | error | lost | permission | idle | timeout
.\\gpulease.exe ls
```

替身按真 `nvidia-smi --format=csv,noheader,nounits` 的输出格式走，包括 WDDM 下按进程显存为 `[N/A]` 这件事。`doctor` 会明说"显卡数据来自替身"，不会把假数据当真卡报出去。这套开关同时是门禁的一部分：`bun test` 里有 10 条场景用例和 4 条 CLI 端到端用例，在 Windows 节点上跑。
