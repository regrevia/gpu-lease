# 变更记录

## 0.5.0

### 新增

- `gpulease install [--autostart] [--no-start-menu] [--dir DIR] [--json]`：把 exe 放到 `%LOCALAPPDATA%\gpulease\bin`、加进用户级 PATH、建开始菜单快捷方式（指向 `watch`）；`--autostart` 再写一条 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\gpulease` = `"...\gpulease.exe" daemon --quiet`，登录后值班自己起来。`--dir` 换落点（便携目录），`--json` 给机器读。
- `gpulease uninstall [--purge] [--dir DIR] [--json]`：删自启项、快捷方式、PATH 里这一段；`--purge` 连程序文件和状态目录（任务账本 / 历史 / 日志）一起删。正在运行的 exe 删不掉，会改名成 `.old`，不装作删成功。
- 升级就是再跑一次新版 `install`：正在跑的旧 exe 先改名 `.old`，新文件写进去，下次启动清掉。重装不会重复往 PATH 里加（大小写不敏感、容忍尾分号）。
- Windows 门禁新增一步 `install / uninstall on real Windows`：真机装 → 再装一次断言 PATH 不重复 → 从装好的位置跑 `ls --json` → 卸干净，并断言用户 PATH 回到原样、`Run` 项消失、exe 与快捷方式都没了；失败也走 `finally` 把注册表和 PATH 复原。门禁从 19 步变 20 步。
- `docs/07-install-and-troubleshooting.md`：装 / 升级 / 卸载三条路径，和"PATH 没生效""自启没起来""门禁节点为什么没有显卡数字"这些实际会卡住人的地方。

### 修

- 进程层三层探针（CIM → Get-Process → tasklist）全超时之后退避 60 秒再试，不再每个 tick 都花 17–20 秒撞同一堵墙；`doctor` 里会看到"…s 后再试"。任何一层拿到结果就立刻恢复。
- `starting` 状态但 `started_at` 为空的活，改用 `created_at` 判断是否卡住——否则它会永远不被认出来，槽位一直被占。

### 诚实边界

- `install` / `uninstall` 只在 Windows 上工作，其它平台直接拒绝（不是"静默跳过"）。
- 必须用编译出来的 `gpulease.exe` 跑 `install`；用 `bun` 直接跑源码时会拒绝，否则装进去的是 bun。
- 开始菜单快捷方式用 `WScript.Shell` COM 建；没有开始菜单的 Windows Server Core 上会明确报错，不会假装建好。

## 0.4.0

### 新增

- `gpulease history [--minutes 30] [--gpu N] [--json]`：每张卡的占用率与显存占比画成 24 格方块曲线，给平均 / 峰值 / 现在。数据来自值班进程每 15 秒写一行的 `samples` 表，只留 24 小时；没有采样的时段留白，不显示成 0。
- 值班进程跨重启累积历史：曲线在库里，不在内存里。
- 值班进程自己出事时留现场：`logs/daemon-crash-<时间>.log`（时间 / 位置 / 版本 / 堆栈），`gpulease doctor --bundle` 会把它一起打包；一轮采集炸了不会让值班停摆，连续 5 轮才退出并留现场。
- `gpulease doctor --soak [--seconds 30] [--json]`：连续跑若干轮采集（2 秒到 1 小时），量出每轮耗时、CPU 占比、RSS / 峰值 RSS / 堆。至少跑两轮——慢机器上一轮采集就可能吃掉整个窗口，只跑一轮的数字什么都说明不了。
- Windows 门禁加两步：`history across daemon restarts`（两次 `daemon --once` 间隔超过采样下限，断言跨重启累积、24 格、峰值来自占用率而不是显存）与 `perf budget`（20 秒浸泡，断言实际跑够 18 秒、轮数 ≥ 3、RSS < 250 MB、峰值 < 350 MB、2 秒间隔下 CPU < 40%）。上限故意留宽：这台节点上进程层三个探针全超时，一轮采集要 7 秒、最慢一轮 19.6 秒，卡死数字等于要求机器别降级。
- `.github/workflows/soak.yml`：手动触发、45 分钟超时的长浸泡（默认 30 分钟），断言行数、CPU 与内存增长，数字写进运行摘要。

### 验证

- tag 前最后一次全绿：Windows 门禁 run `42696447220`（`123097d2`）→ `conclusion=success`，17 步全过。
- 发出去的这一份：tag run `42713747045`（`c7befecf`）→ `conclusion=success`，`exe_bytes=115328000`（110 MB）、`zip_bytes=54743587`（52.2 MB）、`SHA256SUMS.txt` 172 字节；下载回来核对过：zip `sha256=cdced042…1603`、exe `sha256=01937ef9…418f`，与 `SHA256SUMS.txt` 一致。
- 新两步的实跑输出：`history: ticks=2, card0_points=2, spark=                      ██, peak=97`、`perf: ticks=4, tick_avg=7127.8ms, tick_max=19631ms, cpu=0.5%, rss=27.9MB, peak=32.5MB`。
- 这台节点这次进程层是 `unavailable`（CIM / Get-Process / tasklist 三条全超时），所以每轮采集 7–20 秒、任务归因只剩"自己起的子进程"。CPU 0.5%、常驻 28 MB 是监控自己的开销。有卡、进程层正常的机器上没验过具体刷新间隔。
- 本机 macOS `bun test` 92 条绿 / 242 断言（0.3 的 77 条 + 历史 12 条 + 崩溃 2 条 + 浸泡 1 条）。
- 30 分钟长浸泡（`soak.yml`）：run `42700621031`（`5c6667b4`）：`seconds=1803.2`、`ticks=295`、`tick_avg=4868.2ms`、`tick_max=27822ms`、`cpu=0.8%`、`rss=40.6MB`（首轮 31.8 MB，涨 8.8 MB，峰值 48.9 MB）。门槛是"跑够时长 + 至少 20 轮 + CPU < 40% + RSS < 200 MB + 峰值 < 350 MB + 30 分钟内增长 < 30 MB"，都过。

## 0.3.0

### 新增

- `gpulease daemon`：常驻值班。每轮看一遍状态，只在**变坏**或**从坏恢复**时说话；单实例（`daemon.lock`），心跳写 `daemon.json`。
- `gpulease alerts`：本地事件表，看历史告警与推送是否成功。
- 推送：`--webhook` 或 `GPULEASE_WEBHOOK`，认 ntfy、飞书、钉钉、通用 JSON；推不出去也留在本地，不会因为网络问题丢掉告警。
- 告警冷却：同一条任务同一种毛病 10 分钟内只吵一次，冷却落盘（`alert-cooldown.json`），重启也不重播；`recovered` 永远照发。
- 卡位回收：跑挂（`failed`）或断联（`lost`）的任务不再占着卡，队列马上能用那张卡起下一件活。
- 起了没跑起来（`starting` 超过 2 分钟）的活会被标成失败并写明看哪份日志，队列不再无声地卡住。
- 值班起的每个 run 都把输出落到 `logs/wrapper-<任务>-<队列号>.log`，起不来的原因留得住现场。
- 告警判据（`src/alerts.ts`，纯函数）：`failed` / `lost` / `stalled` / `suspect` 才打扰；`slow` 只是趋势不算事件；首次见到就不对劲也报；重启不会把"正常"重播一遍。

### 发布

- tag `v0.3.0` 的 tag 运行 `42682120449`：`publish release` 成功，`gpulease-windows-x64.zip` 54,741,095 字节（52.2 MB），`gpulease.exe` 115,320,320 字节（110 MB），`SHA256SUMS.txt` 172 字节。

### 验证

- 门禁 run `42679530072`（`3bb22289`）`conclusion=success`，第 1–16 步全过（15 只在 tag 上跑、17 是空仓库兜底）：队列放卡、`q-wait` 带理由等待、`q-fit` 真跑完并回写 `run_id`，进度仍读到 `42%`。细节见 `docs/05-windows-verification.md`。

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
