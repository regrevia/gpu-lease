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

步骤：`node facts`（OS / 内存 / 有无 NVIDIA）→ 解析 bun（不依赖 `setup-bun`，服务账号没有建符号链接的权限）→ `install` → `test` → `compile`（打印 `exe_bytes`）→ `smoke test the exe`（摘 PATH + 四条断言）→ `diagnose subprocess layer`（`doctor --probe`，信息性）→ `pack zip`（量 exe/zip 体积）→ `checksum`（exe 与 zip 各一行 SHA256）→ `publish release`（仅 tag）→ `artifact`（仅供人查，失败不弄红）→ 分支结束。任一硬步骤失败即不发布。

发布不是一个独立作业，而是 build 作业里的 `publish release` 一步（只在 tag 上跑）：用 `GITHUB_TOKEN` 上传 `gpulease-windows-x64.zip` 与 `SHA256SUMS.txt`，发布说明取自 `.github/release-notes/<tag>.md`（没有就报错，不做"无说明发布"）。**不再跨作业 `download-artifact`**——这台节点访问 GitHub blob 存储会挂，实测卡满 15 分钟作业超时被取消；本机产物直接发，少一次网络往返。**未签名**，首次运行会被 SmartScreen 拦（这是 v1 的已知取舍，见 `research/windows-and-packaging.md` §6）。

## 4. 给这台机器加一个仓库（实测版）

官方文档写在 `win-runner/docs/USING-THE-MACHINE.md`，下面是这次实际踩到的坑：

1. `scripts/repos.txt` 加一行 `owner/repo`，提交。
