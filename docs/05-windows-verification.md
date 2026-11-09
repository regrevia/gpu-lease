# Windows 真机验收：这台节点能证明什么

第一版只有一条硬要求：**开发完成后，Windows 上双击就能用**。所以产物不能只在我们自己的机器上编译过，必须在一台真的 Windows 上跑过。

节点：`regrevia-win-runner`（自托管，Windows 11，build 26200 / 23.5 GB RAM / 管理员身份运行）。项目实例注册名 `regrevia-gpu-lease`，标签 `self-hosted, windows, x64, regrevia-win`。

## 1. 它能证明的

| 事项 | 怎么证明 |
|---|---|
| 单文件 exe 真的能生成 | `bun build --compile --target=bun-windows-x64` 在 Windows 上跑通，并打印体积 |
| exe 不依赖本机 Node | 冒烟测试前把 `nodejs` 从 PATH 里摘掉，再执行 `--version` / `doctor --json` / `ls --json` |
| 没有 GPU 时不崩 | 这台节点**没有 NVIDIA 驱动**，正好用来验"诚实地降级"：应该输出 `无 NVIDIA 设备`，不是异常栈 |
| JSON 契约稳定 | 逐条 `ConvertFrom-Json`，`ls --json` 必须是可解析的数组 |
| 规则与解析器可测 | `--fake-gpu` 注入构造的 `nvidia-smi` 输出，走同一套解析和规则 |
| 发布可复现 | 同一 job 里算 SHA256 写 `SHA256SUMS.txt`，tag 触发 `gh release create` |
| Windows 进程/API 行为 | WMI `Win32_Process`、事件日志、`Get-CimInstance` 都能在真机上验，不用猜 |

## 2. 它不能证明的

**这台节点没有 NVIDIA 显卡**（`nvidia-smi=MISSING`）。以下事实只在有卡的机器上成立，不能在这里"验过"：

- WDDM 下 `--query-compute-apps=used_memory` 是否恒为 `N/A`
- `pid → 进程归属` 的实际可见性（跨用户/提权进程的 `CommandLine` 是否为空）
- eGPU 热拔时的 `NVML_ERROR_GPU_IS_LOST` / `DXGI_ERROR_DEVICE_REMOVED`
- TDR 事件 4101、`nvlddmkm` 13/14/153 能不能读到
- 各条健康规则在真负载下的误报率

这些要用有卡的机器验。两条路：① 用户在自己的 GPU 机器上跑 `gpulease doctor --dump`，把输出贴回来；② 把那台机器也注册成 runner（同一条 `onboard-repo` 流程），以后每次发布自动验。

**在拿到真机输出之前，任何 GPU 相关结论都只能写成"按文档推断"。**

## 3. 验收流程（`.github/workflows/windows-gate.yml`）

触发：`workflow_dispatch`、`push` 到 `main`、`v*` tag。**绝不接 `pull_request`**——公开仓库的自托管 runner 会让 fork 代码直接在那台机器上执行。

步骤：`node facts`（OS/内存/有无 NVIDIA）→ `setup bun` → `install` → `test` → `compile` → `smoke test the exe`（摘 PATH + 三种命令 + fake-gpu）→ `checksum` → `artifact`。任一失败即不发布。

`release` job 只在 tag 上跑，用 `GITHUB_TOKEN` 上传 exe 与校验文件。**未签名**，首次运行会被 SmartScreen 拦（这是 v1 的已知取舍，见 `research/windows-and-packaging.md` §6）。

## 4. 给这台机器加一个仓库（实测版）

官方文档写在 `win-runner/docs/USING-THE-MACHINE.md`，下面是这次实际踩到的坑：

1. `scripts/repos.txt` 加一行 `owner/repo`，提交。
2. 在仓库侧 mint 一次性注册 token：`gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token`。
3. 派发 `onboard-repo`（在 `win-runner` 仓库）：`gh workflow run onboard-repo -R regrevia/win-runner -f repo=<owner/repo> -f token=<token>`。
4. 验证：`gh api repos/<owner>/<repo>/actions/runners` 出现 `regrevia-<slug>`，`Status=online`。

实测遇到并已修掉的两个问题（都在 `scripts/runner-setup.ps1`）：

- **未认证的 `api.github.com` 按 IP 限流**（`API rate limit exceeded`）。现在脚本用 job 的 `GITHUB_TOKEN` 认证。
- **`objects.githubusercontent.com` 对这台机器的网络稳定返回 504**，runner 包下载不下来。现在 4 次重试后回退到「从同机已装实例 robocopy 播种」，不依赖外网。

`config.cmd --unattended --replace` 需要管理员；runner 服务本身即以管理员运行（`elevated=True`），所以注册可全程由 job 完成，不需要人登机器。

## 5. 常驻与资源纪律

- 每个实例一次只跑一个 job；多仓库靠多实例，实例之间可并发。
- 共享的是同一台机器的 PATH、注册表、已装软件、磁盘——**这不是沙箱**。gate 里不写注册表、不改全局 PATH（只在子进程内改 `$env:PATH`）。
- 全局状态变化必须 `concurrency` 串行并恢复现场。

## 6. 判定标准

一次发布只有在**同一次 run 里**同时满足以下条件，才允许说"Windows 上可用"：

1. `windows-gate` 绿；
2. 日志里有 `exe_bytes=` 与 `smoke=ok`；
3. artifact 里有 `gpulease.exe` 和 `SHA256SUMS.txt`；
4. run 的链接贴进 README/release notes（可复查）。
