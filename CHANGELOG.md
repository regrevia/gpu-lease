# 变更记录

## 未发布

### 新增

- `gpulease daemon`：常驻值班。每轮看一遍状态，只在**变坏**或**从坏恢复**时说话；单实例（`daemon.lock`），心跳写 `daemon.json`。
- `gpulease alerts`：本地事件表，看历史告警与推送是否成功。
- 推送：`--webhook` 或 `GPULEASE_WEBHOOK`，认 ntfy、飞书、钉钉、通用 JSON；推不出去也留在本地，不会因为网络问题丢掉告警。
- 告警冷却：同一条任务同一种毛病 10 分钟内只吵一次，冷却落盘（`alert-cooldown.json`），重启也不重播；`recovered` 永远照发。
- 卡位回收：跑挂（`failed`）或断联（`lost`）的任务不再占着卡，队列马上能用那张卡起下一件活。
- 起了没跑起来（`starting` 超过 2 分钟）的活会被标成失败并写明看哪份日志，队列不再无声地卡住。
- 值班起的每个 run 都把输出落到 `logs/wrapper-<任务>-<队列号>.log`，起不来的原因留得住现场。
- 告警判据（`src/alerts.ts`，纯函数）：`failed` / `lost` / `stalled` / `suspect` 才打扰；`slow` 只是趋势不算事件；首次见到就不对劲也报；重启不会把"正常"重播一遍。

## 0.2.0

这一版只做一件事：**进度**。训练脚本、ComfyUI 出图、模型下载都会往外打字，那就读这些字，不猜、不编。

### 新增

- 任务行带进度：`42% · 420/1000 · 还剩 47 秒`；`ls`、`watch`、`serve` 三处一致。
- 进度适配器（`src/progress.ts`，纯函数）：从日志尾巴往前找最后一条命中，认 tqdm / ComfyUI 的进度条（含 `\r` 原地刷新）、`1.2 GiB / 3.4 GiB` 下载、`Epoch 3/10`、`step 420/1000`。
- `ls --json` 每个任务多 `progress: {percent, label, eta_sec}`，读不到是 `null`。
- 只读日志最后 8 KB（`readTail`），几十 MB 的训练日志不吃内存。

### 边界

- 只认日志里出现的数字；没有进度条的任务显示"在跑，正常"，不给假百分比。
- 任务结束后不显示进度（结论比半截进度有用）。
- 进度不参与健康判定：卡住与否仍按最后一次输出时间算。
- 不 hook 框架回调、不读显存里的进度：日志这种证据对任何框架都成立。

### 验证

- `bun test` 55 条：新增进度解析 12 条、上屏 4 条（含 `\r` 刷新、超过 100%、分母为 0、日志不存在）。
- Windows 门禁加了一条活任务断言：真起一个打 tqdm 行的子进程，`ls --json` 里要读到 `percent=42` / `label=420/1000` / `eta_sec=47`，人读那行要出现 `42%`。这条断言第一次跑就抓到两个真问题：进度只在 watch 面板上屏、`ls` 那行漏了；以及人读断言取值的时机（任务一结束进度按设计消失）。
- 门禁 run `42660390025`（`c472b575`）全绿，`v0.2.0` tag 的门禁 run 走到 `publish release` 成功：`exe_bytes=115304960`、`zip_bytes=54736271`；本地重新下载 zip 算 SHA256 = `a4f195b7…cadfeb8`，与 `SHA256SUMS.txt` 一致。

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
