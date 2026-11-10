# CLI 与 JSON 契约（v1.0 冻结）

这份文档冻结 gpulease 已经发出去的那层表面：子命令、参数、退出码、`--json` 的字段名与类型、`serve` 的 HTTP 路由。
内部实现不在冻结范围：SQLite 表结构、判定阈值、采样间隔、文案措辞都可以改。

下面每条 JSON 样本都是在这台机器上真跑出来的，跑之前把显卡命令换成仓库里的替身（造双卡：RTX 4090 24 GB + RTX 4060 8 GB）：

```bash
export PATH="/Users/apple/.local/opt/node-current/bin:$PATH"
export GPULEASE_HOME=$(mktemp -d)
export GPULEASE_SMI="$(command -v bun) test/fixture/smi.ts"
export GPULEASE_SMI_SCENARIO=two-gpu
bun src/main.ts <子命令> --json
```

样本里的 `platform: "darwin"`、`wmi: "unavailable"`、`非 Windows 平台，进程层不可用` 是这台机器的结果；Windows 上是 `windows`、`ok`、没有这条 degraded。字段本身一样。

## 冻结了什么

| 是契约 | 不是契约 |
|---|---|
| 子命令名、参数名、参数是否必填 | 帮助文本的排版与措辞 |
| 退出码 0 / 1 / 2 的含义 | 程序内部返回 1 的具体原因 |
| `--json` 输出的字段名与类型 | 字段在 JSON 里的先后顺序 |
| `serve` 的路由路径、响应类型、状态码 | 页面 HTML 的样式与结构 |
| `verdict` / `kind` / `state` 的字面量取值 | 判定阈值（180 / 600 / 30 秒） |
| 状态目录与日志文件的位置 | SQLite 表结构 |

改动的时机：删字段、改字段名、改类型、改路由、改退出码含义，都要等下一个大版本，并且写进 CHANGELOG。加字段、加可选参数、加路由不算破坏。

## CLI

一条命令一件事，参数都按 `--名字 值` 给。

| 命令 | 参数 | 做什么 | 退出码 |
|---|---|---|---|
| `run` | `--name` / `-n`（必填）、`--gpu` / `-g` N、`--log` FILE、`--session` ID、`--` 之后是被执行的命令（必填） | 托管起一个任务，注入 `GPULEASE_RUN_ID` / `GPULEASE_TASK_ID` / `GPULEASE_RUN_NAME` / `CUDA_VISIBLE_DEVICES` | 子进程的退出码；起不来 1；用法错 2 |
| `ls` | `--json`、`--no-color` | 一行一个任务 + 每张卡的占用 | 0 |
| `watch` | `--fast`（1 秒刷新）、`--no-color` | 终端面板，`q` / `Ctrl+C` 退出 | 0 |
| `serve` | `--port`（默认 7788）、`--host`（默认 127.0.0.1） | 本地面板 + JSON/SSE 接口 | 收到 SIGINT / SIGTERM 后 0 |
| `daemon` | `--interval` 毫秒（默认 5000）、`--webhook` URL、`--once`、`--quiet` | 常驻值班：记采样、判健康、发告警、给队列派卡 | 0 |
| `submit` | `--name`（必填）、`--need-vram` / `--need-mb` MB、`--priority` / `-p` N、`--session` ID、`--` 之后是命令（必填） | 入队，等 daemon 派卡 | 0；用法错 2 |
| `queue` | `--json` | 队列，含每个任务为什么在等 | 0 |
| `sessions` | `--json` | 按会话汇总在跑 / 排队 / 最差判定 / 整体进度 | 0 |
| `cancel` | `<队列号>` | 取消一个还在排队的任务 | 0；没有这个号 1；已经不在排队 1；不给号 2 |
| `alerts` | `--json`、`--limit`（默认 30） | 最近的告警事件 | 0 |
| `history` | `--minutes`（默认 30，最小 1）、`--gpu` N、`--json` | 每张卡最近一段时间的采样曲线 | 0 |
| `doctor` | `--json`、`--bundle`、`--soak`、`--seconds`（默认 30）、`--probe` | 自检；`--bundle` 生成诊断包，`--soak` 量值班开销 | 0 |
| `install` | `--autostart`、`--no-start-menu`、`--dir` DIR、`--json` | 装进 Windows 用户目录 | 0；非 Windows 1 |
| `uninstall` | `--purge`、`--dir` DIR、`--json` | 卸载 | 0；有删不掉的 1；非 Windows 1 |
| `--version` / `-v` / `version` | — | 打印版本号（当前 `0.7.0`） | 0 |
| 不带参数 / `--help` / `-h` / `help` | — | 打印用法 | 0 |

退出码只有三个数：

- `0`：做完了。`watch` / `serve` / `daemon` 是收到退出信号后返回 0。
- `1`：做不到。`run` 把它透传给调用方——子进程退出码是 7，`gpulease run` 就退 7。
- `2`：参数不对，什么也没做。例如缺 `--name`、缺 `--` 后面的命令、未知子命令。

错误信息分两路：参数错误打到 stderr 并以 2 退出；`run` 的子进程起不来（可执行文件不存在）时把 `出错了：<原因>` 写进该任务的日志，stderr 只有一行，以 1 退出。

未知子命令会原样回显：

```
$ gpulease nope
未知命令：nope
```

后面跟整段用法，退出码 2。

`--need-mb` 是 `--need-vram` 的别名，两个都收，单位都是 MB。`--gpu` 只接受纯数字（`/^\d+$/`），写 `--gpu 0,1` 会被忽略成"没指定卡"。`doctor --probe` 存在但没写进用法文本：它把几条枚举进程的命令各跑一遍，结果进 `probe` 字段。

## JSON 字段

约定：时间戳一律是 epoch 毫秒（`number`）；`null` 与"空"是两件事，`null` 表示这一项没拿到，不是 0。

### `ls --json`

输出整个面板状态。下面是真跑出来的，`tasks` 只留两条（一条在跑、一条断联），字段与完整输出一致：

```json
{
  "at": 1794273315293,
  "gpus": [
    {
      "index": 0,
      "uuid": "GPU-0f2c1a44-1111-2222-3333-444455556666",
      "name": "NVIDIA GeForce RTX 4090",
      "driver": "566.14",
      "vram_total_mb": 24564,
      "vram_used_mb": 18234,
      "util": 97,
      "temp_c": 71,
      "power_w": 402.31,
      "per_process_vram_available": false
    },
    {
      "index": 1,
      "uuid": "GPU-77aa88bb-9999-8888-7777-666655554444",
      "name": "NVIDIA GeForce RTX 4060",
      "driver": "566.14",
      "vram_total_mb": 8188,
      "vram_used_mb": 3201,
      "util": 12,
      "temp_c": 54,
      "power_w": 38.9,
      "per_process_vram_available": false
    }
  ],
  "procs": [
    {
      "pid": 4242,
      "name": "C:\\Program Files\\Python311\\python",
      "run_id": null,
      "vram_mb": null
    },
    {
      "pid": 5252,
      "name": "C:\\Windows\\System32\\dwm",
      "run_id": null,
      "vram_mb": null
    }
  ],
  "tasks": [
    {
      "run": {
        "id": "rmwa004cuuxix",
        "name": "进度样本",
        "command": "sh -c printf \"  45%|####      | 45/100 [00:10<00:12, 4.5it/s]\\n\"; sleep 6",
        "cwd": "/Users/apple/Desktop/DSH/gpu-lease",
        "root_pid": 17998,
        "started_at": 1794273312270,
        "ended_at": null,
        "exit_code": null,
        "pids": [17998],
        "gpu_hint": null,
        "log_path": "/tmp/gpulease-doc/logs/rmwa004cuuxix.log",
        "last_output_at": 1794273312280,
        "session": "session-7acba1c0-4898-41a1-9f36-27c6f780a59f"
      },
      "verdict": "ok",
      "sentence": "「进度样本」在跑，正常",
      "alive": true,
      "since": 1794273312280,
      "gpus": [],
      "progress": {
        "percent": 45,
        "label": "45/100",
        "eta_sec": 12
      }
    },
    {
      "run": {
        "id": "rmw9zro5h2s2q",
        "name": "下载 FLUX 模型",
        "command": "sleep 300",
        "cwd": "/Users/apple/Desktop/DSH/gpu-lease",
        "root_pid": 15334,
        "started_at": 1794272918021,
        "ended_at": null,
        "exit_code": null,
        "pids": [15334],
        "gpu_hint": null,
        "log_path": "/tmp/gpulease-doc/logs/rmw9zro5h2s2q.log",
        "last_output_at": 1794272918021,
        "session": null
      },
      "verdict": "lost",
      "sentence": "「下载 FLUX 模型」的进程已经不在了（不是正常退出）",
      "alive": false,
      "since": 1794272918021,
      "gpus": [],
      "progress": null
    }
  ],
  "degraded": ["非 Windows 平台，进程层不可用"],
  "external": 2,
  "nvidia": "present"
}
```

顶层字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `at` | number | 这次采集的时间 |
| `gpus` | array | 每张卡一项，见 `Gpu` |
| `procs` | array | 占了卡的进程，见 `GpuProc`；Windows 上按进程显存常拿不到，`vram_mb` 为 null |
| `tasks` | array | 任务，最近结束的在前，见 `TaskView` |
| `degraded` | string[] | 这一轮缺了什么。空数组表示没缺 |
| `external` | number | 占了卡但不是 gpulease 起的进程数 |
| `nvidia` | `"present"` \| `"absent"` \| `"error"` | 显卡数据源的状态 |

`Gpu`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `index` | number | 卡号，0 起 |
| `uuid` | string | 驱动给的 UUID |
| `name` | string | 卡名 |
| `driver` | string \| null | 驱动版本；读不到为 null |
| `vram_total_mb` | number \| null | 总显存；读不到为 null |
| `vram_used_mb` | number \| null | 已用显存；读不到为 null |
| `util` | number \| null | 利用率百分比；读不到为 null |
| `temp_c` | number \| null | 温度；读不到为 null |
| `power_w` | number \| null | 功耗；读不到为 null |
| `per_process_vram_available` | boolean | 能不能拿到按进程的显存。Windows（WDDM）上是 false，这是驱动限制 |

`GpuProc`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `pid` | number | 进程号 |
| `name` | string | 可执行文件路径 |
| `run_id` | string \| null | 归属到哪个 gpulease 任务；不是我们起的是 null，不猜 |
| `vram_mb` | number \| null | 该进程显存；驱动不给就是 null |

`TaskView`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `run` | object | 任务本身，见 `Run` |
| `verdict` | `"ok"` \| `"slow"` \| `"suspect"` \| `"stalled"` \| `"failed"` \| `"lost"` \| `"unknown"` | 健康判定。`unknown` 是没有足够信息，不是正常 |
| `sentence` | string | 一句话结论，直接给人看 |
| `alive` | boolean | 进程还在不在 |
| `since` | number | 进入当前判定的时间 |
| `gpus` | number[] | 这个任务在哪几张卡上。Windows 上拿不到按进程归属，实际是空数组 |
| `progress` | object \| null | 从日志尾巴读到的进度；读不到是 null，不编数字 |

`Run`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 任务号，`r` 开头 |
| `name` | string | 名字 |
| `command` | string | 命令原文（空格拼接，不保留引号） |
| `cwd` | string | 工作目录 |
| `root_pid` | number \| null | 根进程号；没起来是 null |
| `started_at` | number | 开始时间 |
| `ended_at` | number \| null | 结束时间；还在跑是 null |
| `exit_code` | number \| null | 退出码；还在跑是 null |
| `pids` | number[] | 记下的进程号 |
| `gpu_hint` | number \| null | `--gpu` 给的值；没给是 null |
| `log_path` | string \| null | 日志文件；没落到盘是 null |
| `last_output_at` | number \| null | 最后一次有新输出的时间；从没输出是 null |
| `session` | string \| null | 起这个任务时用的会话号：`--session` 显式给的、环境变量 `GPULEASE_SESSION` / `DSH_SESSION_ID` 带的，或队列任务入队时记下的。都没有就是 null。最长 80 字符，展示时截 8 个 |

`progress`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `percent` | number \| null | 0–100；日志里读不到百分比就是 null |
| `label` | string | 人话，例如 `45/100`、`420/1000 步` |
| `eta_sec` | number \| null | 预计剩余秒数；读不到是 null |

`degraded` 里出现过的原句（字面量，可以直接匹配）：`这台机器上没有 nvidia-smi：显卡数据不可用`、`非 Windows 平台，进程层不可用`、`nv.detail ?? 显卡读取失败`、以及进程层的降级原因。

### `queue --json`

```json
[
  {
    "id": "qmw9zumzacty",
    "name": "队列验证",
    "command": "[\"sh\",\"-c\",\"echo queued-run-ok\"]",
    "cwd": "/Users/apple/Desktop/DSH/gpu-lease",
    "need_mb": 4096,
    "priority": 0,
    "state": "running",
    "run_id": "rmw9zun0nrfnu",
    "gpu": 0,
    "created_at": 1794273056470,
    "started_at": 1794273056519,
    "ended_at": null,
    "reason": null,
    "session": "session-7acba1c0-4898-41a1-9f36-27c6f780a59f"
  },
  {
    "id": "qmw9zp94pwah",
    "name": "ComfyUI 批量",
    "command": "[\"python\",\"main.py\"]",
    "cwd": "/Users/apple/Desktop/DSH/gpu-lease",
    "need_mb": 8192,
    "priority": 0,
    "state": "cancelled",
    "run_id": null,
    "gpu": null,
    "created_at": 1794272805241,
    "started_at": null,
    "ended_at": 1794272805378,
    "reason": "手动取消",
    "session": null
  },
  {
    "id": "qmw9zp94bqkd",
    "name": "训练 SDXL LoRA",
    "command": "[\"python\",\"train.py\"]",
    "cwd": "/Users/apple/Desktop/DSH/gpu-lease",
    "need_mb": 12288,
    "priority": 5,
    "state": "queued",
    "run_id": null,
    "gpu": null,
    "created_at": 1794272805227,
    "started_at": null,
    "ended_at": null,
    "reason": "没有卡余量够 12 GB，等一个结束",
    "session": "session-7acba1c0-4898-41a1-9f36-27c6f780a59f"
  }
]
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 队列号，`q` 开头 |
| `name` | string | 名字 |
| `command` | string | **JSON 编码过的数组字符串**，要再 `JSON.parse` 一次才是 `["python","main.py"]` |
| `cwd` | string | 入队时的工作目录 |
| `need_mb` | number | 需要的显存 MB；没写 `--need-vram` 是 0（不挑卡） |
| `priority` | number | 越大越先派；默认 0 |
| `state` | `"queued"` \| `"starting"` \| `"running"` \| `"done"` \| `"failed"` \| `"cancelled"` | 队列状态 |
| `run_id` | string \| null | 派出去后对应的任务号；没派出是 null |
| `gpu` | number \| null | 派到哪张卡；没派出是 null |
| `created_at` | number | 入队时间 |
| `started_at` | number \| null | 起跑时间；没起是 null |
| `ended_at` | number \| null | 结束时间；没结束是 null |
| `reason` | string \| null | 为什么在等、为什么取消。可能的值：`还没看到可用的卡`、`卡上都已有任务，等一个结束`、`没有卡余量够 X，等一个结束`、`卡 N 上没有我们的任务（余量看不到，先占上）`、`卡 N 还有 X 空闲`、`手动取消` |
| `session` | string \| null | 入队时的会话号（`--session` 或 `GPULEASE_SESSION` / `DSH_SESSION_ID`）；派出去时写进对应任务的 `run.session`，daemon 自己的环境变量不会盖掉它 |

排序：`created_at` 倒序，最新入队的在前，最多 50 条。这只决定列表顺序，不决定派卡顺序——派卡是 `priority` 高的先上，同优先级按入队时间。

### `sessions --json`

```json
[
  {
    "session": null,
    "label": "未标会话",
    "running": 0,
    "queued": 1,
    "worst": "ok",
    "progress": null,
    "with_progress": 0
  },
  {
    "session": "dsh-aaa",
    "label": "dsh-aaa",
    "running": 0,
    "queued": 1,
    "worst": "ok",
    "progress": null,
    "with_progress": 0
  }
]
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `session` | string \| null | 会话号全量；没有会话号的归到 `null` 这一桶 |
| `label` | string | 展示名：`session` 去掉 `session-` 前缀后的前 8 位；`null` 桶固定是 `未标会话` |
| `running` | number | 这个会话当前在跑（`ended_at` 为 null）的任务数 |
| `queued` | number | 这个会话还在排队（`queued` / `starting`）的队列条目数 |
| `worst` | `"lost"` \| `"failed"` \| `"stalled"` \| `"suspect"` \| `"slow"` \| `"ok"` \| `"unknown"` | 在跑任务里最差的那一档判定；一个都没在跑时是 `ok`，人读输出改说「还没上卡」 |
| `progress` | number \| null | 在跑任务里真报了百分比的那些取平均（四舍五入到整数）；一个都没报是 `null`，不造数字 |
| `with_progress` | number | 上面那个平均覆盖了几个任务；和 `running` 一比就知道覆盖率 |

排序：`running` 倒序 → `queued` 倒序 → `worst` 从坏到好 → `label`。只收还没结束的任务和还在排队的条目，历史任务不进这个列表（要看历史用 `ls --json`）。

人读输出一行一个会话，例如：

```text
未标会话  1 个排队  还没上卡
dsh-aaa  2 个在跑 · 1 个排队 · 最差 偏慢  整体 40%（1/2 个报进度）
```

`ls`、`watch`、`serve` 面板底部也会带同样的小结，但只在有两个以上会话时出现，单个会话不占地方。

### `alerts --json`

```json
[
  {
    "id": 1,
    "at": 1794273056323,
    "run_id": "rmw9zro5h2s2q",
    "name": "下载 FLUX 模型",
    "kind": "lost",
    "message": "「下载 FLUX 模型」的进程已经不在了（不是正常退出）",
    "delivered": 0,
    "detail": null
  }
]
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 自增号 |
| `at` | number | 记下这条的时间 |
| `run_id` | string | 对应任务号 |
| `name` | string | 任务名 |
| `kind` | `"failed"` \| `"lost"` \| `"stalled"` \| `"suspect"` \| `"recovered"` | 告警类型。`slow` 不告警，只在面板上标 |
| `message` | string | 人话，和 `ls` 里的 `sentence` 同源 |
| `delivered` | number | 0 = 没推出去（没配 webhook），1 = 推出去了 |
| `detail` | string \| null | 附加说明；没有是 null |

只记"变坏"和"从坏恢复"。同一个任务同一个 `kind` 十分钟内只记一条（`recovered` 不受这条限制）。`--limit` 只影响条数，不影响排序（`at` 倒序）。

### `history --json`

有采样时：

```json
{
  "minutes": 30,
  "from": 1794271256400,
  "to": 1794273056400,
  "samples": 4,
  "ticks": 2,
  "gpus": [
    {
      "index": 0,
      "label": "NVIDIA GeForce RTX 4090",
      "util": {
        "spark": "                      ██",
        "avg": 97,
        "peak": 97,
        "last": 97,
        "points": 2
      },
      "vram_pct": {
        "spark": "                      ▆▆",
        "avg": 74.2,
        "peak": 74.2,
        "last": 74.2,
        "points": 2
      },
      "vram_used_gb": 17.8,
      "vram_total_gb": 24
    }
  ]
}
```

`gpus` 里每张卡一项；上面只留第一张，第二张结构相同。

| 字段 | 类型 | 说明 |
|---|---|---|
| `minutes` | number | 这次看的窗口 |
| `from` / `to` | number | 窗口起止时间 |
| `samples` | number | 窗口内的采样行数（每张卡每轮一行） |
| `ticks` | number | 窗口内有几个采样时刻 |
| `gpus` | array | 每张卡一项，见下 |

每张卡：

| 字段 | 类型 | 说明 |
|---|---|---|
| `index` | number | 卡号 |
| `label` | string | 卡名 |
| `util` | object | 利用率曲线，见 `Series` |
| `vram_pct` | object | 显存百分比曲线，见 `Series` |
| `vram_used_gb` | number \| null | 最近一次的已用显存；没有采样是 null |
| `vram_total_gb` | number \| null | 总显存；没有采样是 null |

`Series`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `spark` | string | 24 格方块，右对齐；没有采样时全是空格 |
| `avg` | number \| null | 窗口内平均；没有采样是 null |
| `peak` | number \| null | 窗口内峰值；没有采样是 null |
| `last` | number \| null | 最近一次；没有采样是 null |
| `points` | number | 参与计算的采样点数；0 表示这个窗口里没有采样 |

没有采样时的真实输出（`samples: 0`、`ticks: 0`，每张卡的 `avg` / `peak` / `last` 全为 null、`points: 0`、`spark` 是 24 个空格）不是错误，是"还没有数据"。文本模式会直说：`还没有采样：值班进程（gpulease daemon）每 15 秒记一次，先让它跑一会儿。`

### `doctor --json`

```json
{
  "version": "0.5.0",
  "platform": "darwin",
  "arch": "arm64",
  "nvidia_smi": "present",
  "nvidia_smi_detail": null,
  "gpus": [
    {
      "index": 0,
      "uuid": "GPU-0f2c1a44-1111-2222-3333-444455556666",
      "name": "NVIDIA GeForce RTX 4090",
      "driver": "566.14",
      "vram_total_mb": 24564,
      "vram_used_mb": 18234,
      "util": 97,
      "temp_c": 71,
      "power_w": 402.31,
      "per_process_vram_available": false
    }
  ],
  "wmi": "unavailable",
  "wmi_detail": "非 Windows 平台，进程层不可用",
  "event_log": null,
  "store_path": "/tmp/gpulease-doc/gpulease.db",
  "notes": [
    "显卡数据来自替身命令（GPULEASE_SMI），不是真驱动",
    "非 Windows 平台，进程层不可用"
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | string | 程序版本 |
| `platform` | string | `process.platform` 原文（`win32` / `darwin` / `linux`） |
| `arch` | string | `process.arch`，Windows 上是 `x64` |
| `nvidia_smi` | `"present"` \| `"absent"` \| `"error"` | 显卡命令的状态 |
| `nvidia_smi_detail` | string \| null | 失败原因；正常是 null |
| `gpus` | array | 和 `ls --json` 的 `gpus` 同结构 |
| `wmi` | `"ok"` \| `"partial"` \| `"unavailable"` \| `"timeout"` | 进程枚举通道的状态。`partial` 表示能枚举但有降级 |
| `wmi_detail` | string \| null | 降级原因 |
| `event_log` | object \| null | 见下；非 Windows 是 null |
| `store_path` | string | 状态库的绝对路径 |
| `notes` | string[] | 给人看的补充，可能为空数组 |
| `probe` | array（可选） | 只有加了 `--probe` 才有，见下 |

`event_log` 只出现在 Windows 上，读的是系统事件日志里的显卡痕迹：

| 字段 | 类型 | 说明 |
|---|---|---|
| `tdr_4101` | number \| null | 显卡驱动超时重置的次数；读不到是 null |
| `nvlddmkm` | number \| null | NVIDIA 驱动报错的次数；读不到是 null |

`probe` 每项：

| 字段 | 类型 | 说明 |
|---|---|---|
| `label` | string | 这条探针叫什么 |
| `cmd` | string | 真跑的命令行 |
| `code` | number | 退出码；跑不起来是 -1 |
| `timedOut` | boolean | 是不是超时被杀 |
| `ms` | number | 耗时毫秒 |
| `out_bytes` | number | 标准输出字节数 |
| `err_head` | string \| null | 错误开头 |

`notes` 里出现过的原句：`显卡数据来自替身命令（GPULEASE_SMI），不是真驱动`、`Windows(WDDM) 不提供按进程显存，只报整卡占用；这是驱动限制，不是采集缺陷`、`非 Windows 平台，进程层不可用`。

### `doctor --soak --json`

```json
{
  "seconds": 2.1,
  "interval_ms": 2000,
  "ticks": 2,
  "avg_tick_ms": 54.5,
  "max_tick_ms": 74,
  "cpu_pct": 0.9,
  "rss_mb": 10.7,
  "rss_start_mb": 12.8,
  "rss_growth_mb": -2.2,
  "peak_rss_mb": 12.8,
  "heap_mb": 1.6
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `seconds` | number | 实际跑了多久 |
| `interval_ms` | number | 两轮之间的间隔（2000） |
| `ticks` | number | 跑了几轮 |
| `avg_tick_ms` / `max_tick_ms` | number | 单轮平均 / 最慢耗时 |
| `cpu_pct` | number | 这段时间的 CPU 占用百分比 |
| `rss_mb` | number | 结束时常驻内存 |
| `rss_start_mb` | number | 开始时常驻内存 |
| `rss_growth_mb` | number | 增长量，负数表示降了 |
| `peak_rss_mb` | number | 峰值常驻内存 |
| `heap_mb` | number | JS 堆 |

`--soak` 加 `--json` 只输出这一个对象，不输出 `DoctorReport`。

### `install --json` / `uninstall --json`

这两个只在 Windows 上有输出。这台机器不是 Windows，两个命令都在入口就返回 1：

```
$ gpulease install --json
install 只支持 Windows：这台机器上的 gpulease 请直接用 `gpulease run`。   # stderr，退出码 1
$ gpulease uninstall --json
uninstall 只支持 Windows。                                               # stderr，退出码 1
```

所以下面两段是代码里实际写出的对象，**不是跑出来的样本，未在真机验证**。

`install --json`：

```json
{
  "bin_dir": "C:\\Users\\me\\AppData\\Local\\gpulease\\bin",
  "exe": "C:\\Users\\me\\AppData\\Local\\gpulease\\bin\\gpulease.exe",
  "shortcut": "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\gpu-lease\\gpulease.lnk",
  "autostart": true,
  "replaced": false,
  "done": ["exe → …", "PATH（用户级）加入 …", "开始菜单快捷方式 → …", "开机自启已开（…）"]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `bin_dir` | string | 程序目录 |
| `exe` | string | exe 的绝对路径 |
| `shortcut` | string \| null | 快捷方式路径；加了 `--no-start-menu` 是 null |
| `autostart` | boolean | 有没有开开机自启；没加 `--autostart` 是 false |
| `replaced` | boolean | 这次有没有覆盖一个正在跑的旧 exe |
| `done` | string[] | 每一步做了什么，和文本模式那几行同源 |

`uninstall --json`：

```json
{
  "done": ["开机自启已关（删掉 Run\\gpulease）", "开始菜单快捷方式已删", "PATH 里去掉 …"],
  "problems": [],
  "purged": false
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `done` | string[] | 做了什么 |
| `problems` | string[] | 删不掉的项；非空时退出码是 1 |
| `purged` | boolean | 有没有连程序文件和状态目录一起删 |

### 没有 JSON 的子命令

`run`、`watch`、`serve`、`daemon`、`submit`、`cancel` 不认 `--json`，加了也只会被当成普通参数忽略，输出还是人读的那几行。`submit` 的输出是两行，机器要用队列号就从 `queue --json` 拿：

```
已入队 qmw9zumzacty：「队列验证」要 4096 MB 显存
前面还有 1 个 · 用 gpulease queue 看进度
```

`run` 结束时最后两行固定是结论和日志位置：

```
「坏任务」失败（退出码 7） · 用时 0 秒
日志：/tmp/gpulease-doc/logs/rmw9zvr2k34au.log
```

## HTTP

`gpulease serve` 起一个只读面板。默认 `127.0.0.1:7788`，`--port` 换端口，`--host` 换绑定地址。

| 路径 | 响应 | 实测状态码 |
|---|---|---|
| `/` | 单页 HTML（`text/html; charset=utf-8`），一屏看完，自己连 SSE 刷新 | 200 |
| `/api/state` | `ls --json` 那个结构（`PanelState`） | 200 |
| `/api/doctor` | `doctor --json` 那个结构（`DoctorReport`） | 200 |
| `/api/events` | SSE 流，见下 | 200 |
| 其他任何路径 | 纯文本 `not found` | 404 |

实测（`curl` 打真起的服务）：

```
GET / -> 200
GET /api/state -> 200
GET /api/doctor -> 200
GET /nope -> 404
404 的响应体：not found
```

方法和鉴权：

- 路由只按路径分发，不检查方法。`POST /`、`PUT /api/state` 实测同样返回 200，`HEAD /` 也是 200。别把这当成写接口——它不写任何东西，所有路由都只读。
- 没有鉴权、没有 token、没有 CORS 头。默认绑回环地址，只有本机能访问；`--host 0.0.0.0` 会把这个只读面板暴露到局域网，看过的人都知道你哪张卡在跑什么。
- 收到 SIGINT / SIGTERM 后进程退出，退出码 0（实测）。

`/api/events` 是 `text/event-stream`：

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

: connected

data: {"at":1794272958407,"gpus":[…],"procs":[…],"tasks":[…],"degraded":[…],"external":2,"nvidia":"present"}
```

- 连上先发一行注释 `: connected`，再开始推数据。
- 之后每 2000 毫秒推一条 `data: <JSON>`，内容与 `/api/state` 同结构。
- 浏览器断开就停止推送；最后一个客户端断开后定时器停掉，不空转。
- `/api/state` 读失败时返回 `{"error": "…"}`，状态码 500。

## 稳定性承诺

按 semver 说话：

- **补丁版本**：只能修 bug、改文案、改内部实现。字段、路由、退出码一律不动。
- **小版本可以加**：`--json` 里加字段（调用方必须忽略不认识的字段）、加可选参数、加新子命令、加新 HTTP 路由。这些都不算破坏，现有调用不会因此失败。
- **大版本才能删**：删字段、改字段名、改字段类型（`string` ↔ `number`、`null` 变成必有值也算类型收紧）、改路由路径、改退出码含义、改 `verdict` / `kind` / `state` 的字面量取值。
- 人读的那部分（`sentence`、`message`、`done` 里的句子、帮助文本）**不冻结**，随时会为了说清楚而改。要稳定就只看 `--json` 里的字段和退出码。
- 状态目录里东西（SQLite 表、`daemon.json`、告警冷却状态、日志文件）属于内部实现，不承诺跨版本可读；要长期保存的数据自己从 `--json` 导出。
