# gpulease · 显卡值班员

一台机器上几张卡，跑着训练、ComfyUI、推理服务、下载。任务管理器里它们**全都叫 `python.exe`**。
你真正想知道的只有三件事：**这是哪个任务？它还正常吗？出事了叫我。**
gpulease 就是替你看住这张卡的值班员。

```
$ gpulease ls
训练 SDXL LoRA   卡0  62%  epoch 7/30   预计 2h10m   正常
ComfyUI 批量     卡1  88%  214/500 张   预计 28m     正常
下载 FLUX 模型   卡0  --   停滞 15 分钟  显存仍占满  ⚠
```

## 为什么做这个

- GitHub 上 `gpu monitor` 有 4770 个仓库、`gpu dashboard` 1528 个 —— **数字层已经过剩**。
- 但 NVML / 任务管理器只给 pid 和利用率，**没有任务语义、没有健康判定、没有主动告警**。
- Windows 原生 + 多卡 + 任务语义 + 主动播报，这个交集**目前没有竞品**：DCGM 只支持 Linux、nvtop 只在 WSL2、gpu-hot 只有 Docker，Windows 上只有指标导出器和传感器工具。

详见 [竞品分析](docs/research/competitors.md)。

## 它是什么

| 层 | 做什么 |
|---|---|
| 归属 | 托管启动注入 task_id，进程树精确可追溯；外部进程可 attach，不猜 |
| 进度 | 进度适配器（tqdm / jsonl / ComfyUI WS / 日志活跃度兜底）归一成 `{done,total,eta}` |
| 判定 | 12 条健康规则 → `正常 / 变慢 / 停滞 / 疑似 / 失败 / 断联` |
| 播报 | 模板生成的人话，异常置顶；托盘气泡 + ntfy 推手机 |
| 调度（v0.5+） | 租约 + 等待队列 + 空占用回收 + 断联迁移 |

**它不是仪表盘。** 仪表盘回答"用了多少"，它回答"谁在跑、还活着吗、要不要管"。

## 形态

一个 exe：双击 → 托盘 + 本地看板（`127.0.0.1:7788`），同时兼作 CLI。

```bash
gpulease run --name "训练 SDXL LoRA" --gpu 0 -- python train.py
gpulease attach 12345 --name "生图批量"
gpulease ls / status / logs <id> / stop <id> / doctor
```

单文件、无 Node 依赖、常驻 < 40 MB。[技术决策](docs/03-architecture.md)

## 只做 Windows

Linux、容器、多机、SLURM 一律不做。换来的是：一条验收线、一套权限模型、一个诚实的信息模型（Windows 拿不到按进程显存，就说整卡占用，不编数字）。面板只保留三种形态：终端 TUI、`127.0.0.1:7788` 单页、v0.2 的托盘气泡。不引入 Electron、不引入前端框架。

面板的视觉语法借自两个可合法复用的项目（nvitop 的 TUI 密度、gpustat-web 的单页结构），代码自己写；GPL 项目只看不抄。详见 [面板复用与范围收窄](docs/06-ui-and-scope.md)。

## Windows 验收

产物不是"我们机器上编译过"，而是在真的 Windows 上跑过才算数。自托管节点 `regrevia-gpu-lease`（Windows 11，管理员服务）承接 `.github/workflows/windows-gate.yml`：编译单文件 exe → 摘掉 PATH 里的 Node 再跑 → `doctor --json` / `ls --json` 必须可解析 → `--fake-gpu` 验解析与规则 → 出 SHA256 → tag 才发 Release。

第一次真实跑通（2026-11-09）：[windows-gate #42588508102](https://github.com/regrevia/gpu-lease/actions/runs/42588508102) 绿——Bun 1.4.4 编译出单文件 exe，摘掉 PATH 里的 Node 后 `--version` / `doctor --json` / `ls --json` / `--fake-gpu` 全部通过，`smoke=ok`。

实测体积：**exe 109.9 MB，zip 52.2 MB**（运行时占绝大部分，`--minify` 无差别）。比调研阶段的官方口径大得多，按这个数字设计下载与首启体验。

这条节点**没有 NVIDIA 显卡**，所以它验的是打包、CLI、JSON 契约、无卡降级；有卡的判断要靠真机 `gpulease doctor --dump` 的输出来补。细节见 [Windows 真机验收](docs/05-windows-verification.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [产品设计](docs/02-product-design.md) | 命题、用户、核心概念、播报规则表、面板、路线 |
| [技术架构](docs/03-architecture.md) | 模块、采集、归属、适配器、规则引擎、API、打包 |
| [竞品分析](docs/research/competitors.md) | 11 个同类项目 + Windows 桌面工具 + 空白在哪 |
| [Windows 与打包](docs/research/windows-and-packaging.md) | WDDM 显存限制、TDR/Xid、DCGM、eGPU、exe 方案 |

## v0.1 范围

只做：采集 + 托管启动 + 任务列表 + 一条自然语言摘要 + 一条告警。
不做：自动杀、自动调度、多机、历史曲线。

**验收标准：第一眼能看出"原来这是我的训练在跑"。**

## 状态

调研、竞品分析、产品设计、架构、Windows 打包与真机验收管线完成，Windows 上检出可运行 exe。产品代码未开工（等你点头）。MIT。
