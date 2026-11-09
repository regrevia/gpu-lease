# Windows 真机验收：这台节点能证明什么

第一版只有一条硬要求：**开发完成后，Windows 上双击就能用**。所以产物不能只在我们自己的机器上编译过，必须在一台真的 Windows 上跑过。

节点：`regrevia-win-runner`（自托管，Windows 11，build 26200 / 23.5 GB RAM）。runner 以**服务账号 `NetworkService`** 身份运行（不是交互式管理员桌面），项目实例注册名 `regrevia-gpu-lease`，标签 `self-hosted, windows, x64, regrevia-win`。

## 1. 它能证明的

| 事项 | 怎么证明 |
|---|---|
| 单文件 exe 真的能生成 | 在 Windows 上跑 `bun build --compile --minify --target=bun-windows-x64`，打印 `exe_bytes` / `size_mb` |
| exe 不依赖本机 Node | 冒烟测试前把 `nodejs / nvm / npm` 从 PATH 里摘掉，再执行 `--version`、`doctor --json`、`run`、`ls --json` |
| 没有 GPU 时不崩 | 这台节点**没有 NVIDIA 驱动**，正好验"诚实地降级"：`doctor` 输出 `nvidia_smi: "absent"` 与 `notes`，不是异常栈 |
| 包装器语义对 | `run --name smoke -- powershell -Command "Write-Output hello-from-child"` 退出 0 且日志落盘；`run -- powershell -Command "exit 7"` 必须把 7 透传给调用方 |
| JSON 契约稳定 | `doctor --json` / `ls --json` 逐条 `ConvertFrom-Json`；空库的 `tasks` 是 `[]`，不是 `null` |
| 解析器与规则可测 | `bun test` 24 例：nvidia-smi CSV、CIM/tasklist、归因、7 种结论、参数解析——全部是喂字符串给纯函数，不需要显卡 |
| 子进程路径可用 | `doctor --probe` 逐条量 `cmd` / `tasklist`（PATH 与绝对路径）/ `WindowsPowerShell` / `wmic` 的退出码与耗时 |
| 发布可复现 | 同一 job 里算 SHA256 写 `SHA256SUMS.txt`，tag 触发 `gh release create` |
| 服务账号下的可写性 | 状态库落在 `C:\Windows\ServiceProfiles\NetworkService\AppData\Local\gpulease\gpulease.db`，日志同目录 `logs\`——已实测可写 |

## 2. 它不能证明的

**这台节点没有 NVIDIA 显卡**（`nvidia-smi=MISSING`，`gpus: []`）。以下事实只在有卡的机器上成立，不能在这里"验过"：

- WDDM 下 `--query-compute-apps=used_memory` 是否恒为 `N/A`
- `pid → 进程归属` 的实际可见性（跨用户/提权进程的 `CommandLine` 是否为空）
- eGPU 热拔时的 `NVML_ERROR_GPU_IS_LOST` / `DXGI_ERROR_DEVICE_REMOVED`
- TDR 事件 4101、`nvlddmkm` 13/14/153 能不能读到
- 各条健康规则在真负载下的误报率
- `watch` 的交互式 TUI（runner 没有 TTY，`process.stdin.setRawMode` 不在这里验）

这些要用有卡的机器验。两条路：① 用户在自己的 GPU 机器上跑 `gpulease doctor --bundle`，把生成的 JSON 贴回来；② 把那台机器也注册成 runner（同一条 `onboard-repo` 流程），以后每次发布自动验。

**在拿到真机输出之前，任何 GPU 相关结论都只能写成"按文档推断"。**

## 3. 验收流程（`.github/workflows/windows-gate.yml`）

触发：`workflow_dispatch`、`push` 到 `main`、`v*` tag。**绝不接 `pull_request`**——公开仓库的自托管 runner 会让 fork 代码直接在那台机器上执行。

步骤：`node facts`（OS / 内存 / 有无 NVIDIA）→ 解析 bun（不依赖 `setup-bun`，服务账号没有建符号链接的权限）→ `install` → `test` → `compile`（打印 `exe_bytes`）→ `smoke test the exe`（摘 PATH + 四条断言）→ `gpu scenarios`（假 provider 喂双卡 / 单卡 / 断联 / 无卡）→ `queue dispatch`（提交→自己上卡→跑完回写 `run_id`）→ `progress from a live run`（真子进程打 tqdm 行）→ `history across daemon restarts`（两次 `daemon --once` 跨过 15 秒采样下限）→ `perf budget`（`doctor --soak` 跑 20 秒报 CPU / RSS）→ `diagnose subprocess layer`（`doctor --probe`，信息性）→ `pack zip`（量 exe/zip 体积）→ `checksum`（exe 与 zip 各一行 SHA256）→ `publish release`（仅 tag）→ `artifact`（仅供人查，失败不弄红）→ 分支结束。任一硬步骤失败即不发布。

另有一条手动工作流 `soak.yml`：30 分钟长浸泡（`doctor --soak --seconds 1800`），断言轮数、RSS、增长与 CPU，数字写进运行摘要。不跟 push 跑——机器上只有一个 runner，长任务会把门禁堵住。

发布不是一个独立作业，而是 build 作业里的 `publish release` 一步（只在 tag 上跑）：用 `GITHUB_TOKEN` 上传 `gpulease-windows-x64.zip` 与 `SHA256SUMS.txt`，发布说明取自 `.github/release-notes/<tag>.md`（没有就报错，不做"无说明发布"）。**不再跨作业 `download-artifact`**——这台节点访问 GitHub blob 存储会挂，实测卡满 15 分钟作业超时被取消；本机产物直接发，少一次网络往返。**未签名**，首次运行会被 SmartScreen 拦（这是 v1 的已知取舍，见 `research/windows-and-packaging.md` §6）。

## 4. 给这台机器加一个仓库（实测版）

官方文档写在 `win-runner/docs/USING-THE-MACHINE.md`，下面是这次实际踩到的坑：

1. `scripts/repos.txt` 加一行 `owner/repo`，提交。
2. 用管理员 PowerShell 跑 `.\scripts\register-repos.ps1`。它给 `repos.txt` 里每个仓库申请注册 token 并调 `config.cmd`。token 一次性、1 小时过期，脚本要现取现用，不要提前生成放一会儿。
3. 注册完到 GitHub 仓库的 Settings → Actions → Runners 看：应该出现 `regrevia-<仓库名>`，标签 `self-hosted`、`Windows`、`X64`、`regrevia-win`，状态 Idle。
4. **push 之前先确认节点空闲**。机器上只有一个 runner 实例，同一时刻只跑一个作业；两个 push 前后脚进来，后一个会在队列里等，不是并行。
5. 工作流里 `runs-on: [self-hosted, windows, x64, regrevia-win]`，`concurrency` 按 ref 分组（`windows-gate-${{ github.ref }}`）。共用一组时实测会出问题：后到的 tag 运行在**零作业**的情况下被取消，release 直接没机会跑。

### 这次实测修掉的两个坑

- **PowerShell 的退出码会漏**：`smoke=ok` 打出来了，作业还是红，因为上一条原生命令的 `$LASTEXITCODE` 留着非零。每个 PowerShell 步骤末尾显式 `$global:LASTEXITCODE = 0`。
- **不要跨作业传产物**：`download-artifact` 在这台节点上卡满 15 分钟被作业超时取消（更早克隆仓库时也撞过 blob 504）。产物本来就在同一台机器上，`publish release` 并进 build 作业直接发。

### 重新注册或换账号

`config.cmd --unattended --replace` 覆盖旧配置。runner 以 `NetworkService` 身份运行：没有建符号链接的权限（`setup-bun` 因此不可用）、没有按用户安装的能力、也没有交互桌面，所以 `watch` 这类 TUI 不在门禁覆盖范围内。

## 5. 常驻与资源纪律

- 一个仓库一个 runner 实例，别在同一台机器上给同一仓库注册两个。
- runner 空闲时基本不吃 CPU/显存；占资源的是作业本身（编译 bun 单文件约 1 分钟、峰值内存 ~1 GB）。
- 门禁里的子进程探针（`doctor --probe`）是**信息性**的：每个用例 4 秒超时、另加一条 12 秒 `tasklist` 用例，跑完约 35 秒。它测的是"这台机器让不让读进程"，读数进日志即可，**不许变红**——机器降级不是代码 bug。
- 不要把 runner 上编译出来的二进制直接当发布产物——它经过 `checksum` 步骤生成 SHA256 才进 release；人工下载后再自算一遍（本机验证过：zip 的 SHA256 与 `SHA256SUMS.txt` 里一致）。

## 6. 判定标准

一次发布只有同时满足下面四条才算"能用"：

1. 门禁 run 是 `status=completed conclusion=success`（不看 `gh run watch` 的退出码，也不只看 `##[error]` 行）。
2. 日志里有 `exe_bytes=` 与 `zip_bytes=`（体积不是猜的），以及 `smoke=ok`。
3. `smoke test the exe` 四条断言全过：摘掉 PATH 里的 Node 仍能启动、`doctor --json` 在无卡机器上诚实报告、`run` 真起子进程后 `ls --json` 查得到且判为正常、子进程退出码 7 原样传回。
4. 远端能查到 release 与两个资产，且下载后自算 SHA256 与 `SHA256SUMS.txt` 一致。

### v0.1.0 的实际证据（2026-11-09）

- 门禁 run `42633177546`（`v0.1.0` tag）→ `conclusion=success`。
- `exe_bytes=115299840`（110 MB）、`zip_bytes=54735323`（52.2 MB）。
- 远端 release：`gpulease-windows-x64.zip` 54735323 字节 + `SHA256SUMS.txt`（exe 与 zip 两行）。
- 本地重新下载 zip 后算 SHA256 = `a2969f9e…a82851`，与文件里 zip 那行一致。
- `process_layer=partial detail=只有进程名，命令行为空（CIM 超时 6s）`：这台机器读不到命令行，属于**预期降级**，不是失败。

### v0.3.0 的实际证据（2026-11-10）

- tag 前最后一次全绿：门禁 run `42679530072`（`3bb22289`）→ `conclusion=success`，第 1–16 步全过（第 15 步 `publish release` 只在 tag 上跑，第 17 步 `scaffold only` 是空仓库兜底，按设计跳过）。
- 新增第 10 步「queue dispatch against the exe」：用双卡替身（卡 0 剩 6330 MB、卡 1 剩 4987 MB）提交两件活——4 GB 的 `q-fit` 和 20 GB 的 `q-wait`。断言 `q-fit` 被自己放到卡 0、`q-wait` 留在 `queued` 并带等卡理由；再等 `q-fit` 变 `done` 且有 `run_id`，并确认 `logs` 里真的出现子进程的输出。实跑输出：`queue: q-fit placed on card 0, q-wait explains why it waits` / `queue: queued command really ran, run_id=rmw9my8f9oz7e`。
- 第 11 步「progress from a live run」照旧：`percent 42, label 420/1000, eta 47s, visible in human output`。
- 这一版新断言抓出三个真问题（都是 Windows 上才暴露的）：
  1. 队列里的活起不来时永远停在 `starting`：`run` 的 `Bun.spawn` 抛错（Windows 上没有 `echo` 这个可执行文件，它是 cmd 内建）没人写回队列。修法：命令起不动就把 job 记成 `failed` 并写原因，同时看门狗把超过 2 分钟的 `starting` 也标失败。
  2. 门禁断言抢在值班进程前面：`daemon` 是异步的，刚起就去读队列会读到"还没放上卡"。修法：轮询等放置落定再断言。
  3. 放不下的活的理由在同一轮里才写：放置后要重新读一次队列，不能拿放置前的快照断言。
- tag `v0.3.0` 的门禁 run `42682120449` 同样 `conclusion=success`，并且走到 `publish release` 成功：release 资产 `gpulease-windows-x64.zip` 54,741,095 字节 + `SHA256SUMS.txt` 172 字节；`exe_bytes=115320320`（110 MB）、`zip_bytes=54741095`（52.2 MB）。
- 本机 macOS `bun test` 77 条绿 / 184 断言（v0.2 的 62 条 + 队列入队-放置-看门狗 8 条 + 告警冷却 4 条 + 其它 3 条）。

### v0.2.0 的实际证据（2026-11-10）

- 门禁 run `42658107537`（`dc39fc02`）与 `42660390025`（`c472b575`）均为 `conclusion=success`；后者是 tag 前的最后一次全绿。
- 新增第 10 步「progress from a live run」：真起一个打 tqdm 行的子进程（` 42%|####      | 420/1000 [00:31<00:47, 9.8it/s]`），轮询 `ls --json` 直到读到进度，断言 `percent=42`、`label=420/1000`、`eta_sec=47`；在同一次命中点再抓 `ls --no-color`，断言人读那行含 `42%`。
- 这条断言抓出两个真问题，值得记住：
  1. 进度只有 `watch` 面板上屏，`ls` 那行漏了——JSON 断言全过，人读断言才抓到。**新字段必须同时断言人读与 JSON 两条路。**
  2. 不能在子进程退出后再读进度：任务一结束进度按设计变 `null`（历史要结论不要半截数字），取值必须落在轮询命中的那一刻。
- 收尾：`finally` 写 stop 文件让子进程自己退，再 `Stop-Process` wrapper；Windows 上杀 wrapper 不会带走子进程，这个握手是必须的。
- 体积：`exe_bytes=115304960`、`zip_bytes=54736271`；tag `v0.2.0` 的门禁 run `42660878983` 走到 `publish release` 成功，release 资产 `gpulease-windows-x64.zip` 54736271 字节 + `SHA256SUMS.txt` 172 字节；下载后自算 zip SHA256 = `a4f195b7…cadfeb8`，与文件里 zip 那行一致。
- 本机 macOS `bun test` 62 条绿（v0.2 的 55 条 + 告警 7 条）。
