# 五分钟上手

`gpulease` 是一个 exe，替你看住显卡上的任务：谁在跑、还正常吗、出事了要不要你动手。
下面按顺序敲，五分钟能走完。命令都是 PowerShell，直接复制。

除显卡数字以外的步骤，都在 Windows 测试节点 `regrevia-win` 上跑过——那台机器没有 NVIDIA 卡。
显卡读数、多卡行为、按进程显存这三块**未在真机验证**；本文里贴出的显卡输出来自仓库里的测试替身，不是真机截图。

## 装（Windows）

从 [releases](https://github.com/regrevia/gpu-lease/releases) 取 `gpulease-windows-x64.zip` 和 `SHA256SUMS.txt`，解压，先对哈希：

```powershell
Get-FileHash .\gpulease-windows-x64.zip -Algorithm SHA256
```

和 `SHA256SUMS.txt` 里 zip 那行一致，再往下走。exe 没签名，首次运行 SmartScreen 会拦一次：更多信息 → 仍要运行。

```powershell
Expand-Archive .\gpulease-windows-x64.zip -DestinationPath .
.\gpulease.exe install --autostart
```

`install --autostart` 做四件事：exe 放进 `%LOCALAPPDATA%\gpulease\bin`、加进用户级 PATH、建开始菜单快捷方式、登录后自动起值班进程。
不想要自启就写 `.\gpulease.exe install`。想装在别的盘用 `--dir D:\tools\gpulease\bin`（这个参数指的就是放 exe 的目录）。

装完**当前这个窗口拿不到新 PATH**，新开一个终端再敲：

```powershell
gpulease --version
```

版本号能打出来就装好了。装细节和升级、卸载在 [安装与排障](07-install-and-troubleshooting.md)。

## 看一眼现在的卡

```powershell
gpulease ls
```

每张卡一行，每个任务一行：

```
#0  NVIDIA GeForce RTX 4090  ███████░░░  17.8/24.0 GB  GPU 97% · 71°C · 402W
#1  NVIDIA GeForce RTX 4060  ████░░░░░░  3.1/8.0 GB  GPU 12% · 54°C · 39W

正常  2026/11/10 09:07:14  「ComfyUI 批量」已完成
```

读法：`已用/总显存`、利用率、温度、功耗。任务那几行开头就是结论——`正常` / `变慢` / `疑似` / `卡住` / `失败` / `丢失`。
下面没有任务行，说明现在还没有用 gpulease 起的活。别人手动开的 python 不算进来：不是我们起的，我们不说归属。

机器上没有 NVIDIA 卡也不会假装：卡那两行不出现，`gpulease doctor` 直说没有卡。

## 托管起一个任务

```powershell
gpulease run --name "训练 SDXL LoRA" --gpu 0 -- python train.py
```

- `--name` 必填，之后所有地方都用这个名字叫你。
- `--gpu 0` 只是指定卡并写进环境变量 `CUDA_VISIBLE_DEVICES`；不给就不动这个变量。
- `--` 后面是原样执行的命令，参数怎么写都行。
- 输出同时进日志：`%LOCALAPPDATA%\gpulease\logs\<任务号>.log`。任务自己写的进度条、`Epoch 3/10`、下载大小，都从这份日志里读。

开另一个窗口看它：

```powershell
gpulease ls
```

任务结束时 `run` 自己打印两行，退出码跟着子进程走：

```
「坏任务」失败（退出码 7） · 用时 0 秒
日志：C:\Users\me\AppData\Local\gpulease\logs\rmw9zvr2k34au.log
```

所以 `gpulease run ... ; echo $LASTEXITCODE` 能拿到训练脚本的真实退出码，脚本里就可以直接判。

## 看进度和队列

```powershell
gpulease submit --name "ComfyUI 批量" --need-vram 8192 -- python main.py
```

```
已入队 qmw9zumzacty：「ComfyUI 批量」要 8192 MB 显存
排队等卡 · 起 gpulease daemon 就会自动上卡
```

`submit` 只入队，不立刻跑。要它自己上卡，得有一个值班进程：

```powershell
gpulease daemon
```

常驻窗口开着就行（装了 `--autostart` 的话登录后已经有一个了）。它每 5 秒看一遍：哪张卡腾出来了、队列里谁最急、谁该被判定为卡住。

```powershell
gpulease queue
```

```
完成  qmw9zumzacty  队列验证 · 要 4 GB · 卡 0 · 完成 · rmw9zun0nrfnu
取消  qmw9zp94pwah  ComfyUI 批量 · 要 8 GB · 手动取消
排队  qmw9zp94bqkd  训练 SDXL LoRA · 要 12 GB · 没有卡余量够 12 GB，等一个结束
```

每行都告诉你它为什么在等，不给"排队中"这种空话。取消一个还在排队的：

```powershell
gpulease cancel qmw9zp94bqkd
```

已经在跑的任务不会被这条命令杀掉——它只说「现在是「在跑」，只有排队中的能取消」并以 1 退出。

## 排队与自动换卡

排队不是先来先跑，是按 `--priority` 和卡的余量挑：

```powershell
gpulease submit --name "训练 SDXL LoRA" --need-vram 12288 --priority 5 -- python train.py
gpulease submit --name "小推理" --need-vram 1024 -- python infer.py
```

- `--need-vram` 单位 MB，`--need-mb` 是同义词。
- `--priority` 越大越先派，默认 0。
- 不写 `--need-vram` 就是不挑卡，哪张卡空就用哪张。
- 在 dsh 会话里跑时，任务会自动记下会话号（`DSH_SESSION_ID`）；想手动指定就加 `--session 名字`，`ls` 和 `queue` 里能看到它的前 8 位。
- 一张卡同时只放一个我们的任务；`--need-vram` 比卡的剩余显存大，就等下一个任务结束。
- 值夜进程看得到任务结束（正常退出、崩了、进程被外面杀掉），卡位随之让出来，下一个自动起。

想知道它现在盯出来什么结论：

```powershell
gpulease alerts
```

```
2026/11/10 09:10:56  「下载 FLUX 模型」的进程已经不在了（不是正常退出）（未推送）
```

只在变坏和从坏恢复时记一条，同一个问题十分钟内不重复刷。后面那个 `（未推送）` 表示没配推送通道——要推手机给 `gpulease daemon --webhook <你的 ntfy 地址>`，或者设环境变量 `GPULEASE_WEBHOOK`。

## 网页面板

```powershell
gpulease serve
```

```
面板：http://127.0.0.1:7788  （Ctrl+C 退出）
```

浏览器打开这个地址：一屏看完每张卡、每个任务、最近的告警，每 2 秒自己刷。只读，只能在页面上看，不能在页面上杀任务。
换端口 `--port 8080`。默认绑 `127.0.0.1`，只有本机能看；`--host 0.0.0.0` 会给局域网看，没鉴权，别在公共网络这么开。

只想在终端里看，用 `gpulease watch`：2 秒刷一次，`q` 退出，`--fast` 变 1 秒。

## 排障三招

**一、先看自检。**

```powershell
gpulease doctor
```

它把三件容易被误判的事直接说清楚：显卡命令在不在、进程通道能不能用、驱动有没有留下超时重置的痕迹。
Windows 上按进程的显存常是 `N/A`——WDDM 的限制，面板会直说看不到，不填假数字。

**二、出一份诊断包。**

```powershell
gpulease doctor --bundle
```

输出一行路径，里面是版本、采集结果、最近事件、崩溃现场。贴给别人看比自己复述准。

**三、按现象查。**

| 现象 | 先做什么 |
|---|---|
| `gpulease` 不是内部或外部命令 | 新开终端；再不行看用户级 PATH 里有没有 `…\gpulease\bin` |
| 开机后没有值班进程 | 手动跑 `gpulease daemon` 看报什么；自启项可能被杀软拦了 |
| 任务全是"外部进程" | 那些不是 `run` / `submit` 起的；外部进程不猜归属 |
| 显存显示 `[N/A]` | 驱动限制，正常；整卡占用仍然准 |
| 显存/温度这些全是空的 | 单独跑一次 `nvidia-smi`；gpulease 等 3 秒就放弃，不会挂住 |
| 值班进程崩过 | `%LOCALAPPDATA%\gpulease\logs\daemon-crash-*.log` |
| 任务"卡住"但你觉得在跑 | 日志 10 分钟没新行就是判定依据；把进度输出刷新一下，或加 `--log` 指到真正的日志 |

判定阈值是死的：刚启动 30 秒内不下判断，3 分钟没有新输出算变慢，10 分钟没有新输出算卡住。要改就改代码，不改配置。
