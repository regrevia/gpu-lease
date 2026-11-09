# 变更记录

## 0.1.0

第一个能用的 Windows 版本：托管启动、归属、判定、三个看板入口。没有调度、没有托盘、没有告警推送。

### 新增

- `gpulease run --name <名字> [--gpu N] [--log FILE] -- <命令>`：代为启动任务，注入 `GPULEASE_RUN_ID` / `GPULEASE_TASK_ID` / `GPULEASE_RUN_NAME`，有 `--gpu` 时注入 `CUDA_VISIBLE_DEVICES`；子进程 stdout/stderr 同时进日志与终端；退出码原样传回。
- 归属：用 NSI 拿到的 pid，加上 `Win32_Process` 的父子关系与 `CommandLine`，把显卡上的进程对回我们起过的任务；对不上的标成外部进程，不猜。
- 判定：`正常 / 偏慢 / 卡住 / 可疑 / 失败 / 丢失 / 未知`，规则带优先级（丢最重）；每句都是人话，附"多久没新输出"。
- `gpulease ls [--json]`：一行一个任务，带脏话没有的自然语言结论。
- `gpulease watch [--fast] [--no-color]`：终端面板，2 秒刷新，一卡一块，进程行缩进，`q` 退出。
- `gpulease serve [--port 7788] [--host 127.0.0.1]`：浏览器单页 + SSE，只读，无框架。
- `gpulease doctor [--json] [--probe] [--bundle]`：显卡/进程层/驱动事件（TDR 4101、nvlddmkm）自检；`--bundle` 把诊断与最近日志打成一个文件。
- SQLite（`bun:sqlite`）状态库，WAL；日志按 run id 落在 `<状态目录>/logs/`。

### 已知边界

- Windows(WDDM) 不提供按进程显存：只报整卡占用。这是驱动限制，不编数字。
- 别的用户/受保护进程的 `CommandLine` 读不到：这类进程只能给名字和 pid。
- 分不出"这张卡断了"和"驱动没响应"时给 `可疑`，不给 `失败`。
- 面板没有历史曲线、没有进度百分比（进度适配器在 0.2）。
- exe 110 MB（Bun 运行时占绝大部分），发布走 zip。

### 已知边界（真机实测补充）

自托管节点（Windows 11 25H2、服务账号 `NetworkService`）上量到的三件事，直接改了三处实现：

- **`tasklist` 会一直不返回**：4.5 s 与 12.5 s 两个超时都被杀掉，输出 0 字节。所以它从"第一回退"降到"最后回退"。
- **`Get-CimInstance Win32_Process` 在这台机器上 6 s 也回不来**（更早观测到接近 100 s）。进程层因此改成三级：CIM（命令行+父子）→ `Get-Process`（.NET 自己枚举，不碰 WMI）→ `tasklist`。
- **只拿到进程名时**，`doctor` 报 `wmi: "partial"`，面板注明"命令行为空"，不把"看得见 pid"说成"认得这个任务"。
- 顺带查清一个假线索：早先怀疑 `new Response(stream).text()` 读子进程管道会挂。改增量读之后现象不变，**问题不在管道**，在命令本身。增量读保留（更早拿到首字节，超时行为更可预期）。

### 验证

- `bun test`：27 条，覆盖 nvidia-smi 解析（含 `[N/A]`、带引号卡名、空输出）、CIM/Get-Process/tasklist 解析、进程树、归属、七档判定、run 参数。
- Windows 门禁（`windows-gate.yml`，run `42625154944` 绿）：编译单文件 exe → 摘掉 PATH 里的 Node 运行 → `doctor --json` 必须诚实报告无卡 → `run` 真起子进程 → `ls --json` 能查到且判定为正常 → 子进程退出码 7 原样传回 → `doctor --probe` 逐条量子进程路径耗时（信息性，不变红）。
