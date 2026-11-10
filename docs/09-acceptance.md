# v1.0 验收矩阵：每句「支持」对应哪条证据

发布前逐行过这张表。一条结论只能有三种状态：

| 状态 | 含义 |
|---|---|
| **节点** | 自托管 Windows 节点上真跑过（门禁步骤名写在证据列） |
| **夹具** | 纯函数 / 假 GPU provider / 假时钟喂进去的真逻辑，`bun test` 里可重跑 |
| **待真机** | 只在有 NVIDIA 卡、有交互桌面的机器上成立；节点没有卡、没有 TTY，不假装验过 |

规则：**「待真机」行只允许出现在显卡读数、eGPU 热拔、TDR、交互式 TUI 这四类**。出现别的就说明有东西没验，不许发 v1.0。

## 1. 交付形态

| # | 结论 | 证据 | 状态 |
|---|---|---|---|
| 1.1 | 单个 exe，不依赖本机 Node | 门禁 `smoke test the exe`：冒烟前把 `nodejs / nvm / npm` 从 PATH 摘掉再跑 `--version` / `doctor --json` / `run` / `ls --json` | 节点 |
| 1.2 | 体积与哈希可复现 | 门禁 `pack zip` 打印 `exe_bytes` / `zip_bytes`，`checksum` 写 `SHA256SUMS.txt`（exe 与 zip 各一行）；tag 触发 `publish release` | 节点 |
| 1.3 | 未签名也能用，拦一次就说清 | `docs/07-install-and-troubleshooting.md`；release 说明里的 SmartScreen 段 | 节点（说明命中即可，不验 UI） |
| 1.4 | 装进用户 PATH、开始菜单，卸干净 | 门禁 `install / uninstall on real Windows`：装 → 再装一次不重复 → 从装好的位置跑 → 卸完断言注册表与用户 PATH 复原 | 节点 |

## 2. 看得见

| # | 结论 | 证据 | 状态 |
|---|---|---|---|
| 2.1 | 每张卡的型号、显存、占用率、温度、功耗读得回 | `src/collect/smi.ts` + 门禁 `gpu scenarios` 用假 SMI 喂双卡异型号 / 单卡 / 断联 / 无卡四组 | 夹具 |
| 2.2 | 真卡上的数值与 `nvidia-smi` 一致 | `gpulease doctor --bundle` 输出与本机 `nvidia-smi` 对照 | 待真机 |
| 2.3 | 没卡的机器诚实降级 | 门禁 `gpu scenarios`：`gpus: []`、`nvidia_smi: "absent"`、`notes` 说明，不是异常栈 | 节点 |
| 2.4 | 进程级显存：能读就读，读不到说读不到 | `src/collect/winproc.ts`（CIM → `Get-Process` → `tasklist` → `none`，失败退避）；门禁 `diagnose subprocess layer` 逐条量退出码与耗时 | 夹具 + 节点（路径耗时） |
| 2.5 | WDDM 下 `used_memory` 恒 `[N/A]` 时的表现 | 面板显示 `—` 并降级为「按进程占用看不到」，不猜数字 | 待真机 |
| 2.6 | 跨用户进程的 `CommandLine` 读不到时降级 | `winproc.ts` 三层回退；读不到时归属写 `unknown` 不编名字 | 夹具 |

## 3. 任务归属与判定

| # | 结论 | 证据 | 状态 |
|---|---|---|---|
| 3.1 | 托管启动：真子进程、退出码透传、stdout 落日志 | 门禁 `smoke test the exe`：`exit 7` 必须透传 7，`hello-from-child` 必须被 tee | 节点 |
| 3.2 | 哪张卡、哪个进程、哪个任务，一一对上 | `src/__tests__/attribute.test.ts` + `gpu scenarios` 的 `ls --json` 断言 | 夹具 |
| 3.3 | 七档判定（ok / slow / suspect / stalled / failed / lost / unknown） | `src/__tests__/rules.test.ts`；阈值 180 / 600 / 30 秒 | 夹具 |
| 3.4 | 真负载下判定不误报 | 用户机器上跑真训练，看 `gpulease ls` 判定与日志是否一致 | 待真机 |
| 3.5 | eGPU 热拔识别为 `lost` | 拔线时的 `NVML_ERROR_GPU_IS_LOST` / `DXGI_ERROR_DEVICE_REMOVED` 分支 | 待真机 |
| 3.6 | TDR 事件（4101 / `nvlddmkm` 13/14/153）进诊断 | `doctor --bundle` 收集 `System` 日志；分支有代码，事件真实形状未验 | 待真机 |

## 4. 进度

| # | 结论 | 证据 | 状态 |
|---|---|---|---|
| 4.1 | tqdm / 下载 / `epoch N/M` / `step|iter N/M` 认得 | `src/__tests__/progress.test.ts`；门禁 `progress from a live run` 用真子进程打 tqdm 行 | 节点 |
| 4.2 | 读不到百分比就不给数字 | 同上；`progress: null` + `with_progress` 披露 | 夹具 |
| 4.3 | ComfyUI 出图进度 | 适配器存在，仅按日志格式匹配 | 夹具 |
| 4.4 | 真 ComfyUI / 真训练的进度准确度 | 用户在机器上跑一次出图与一次训练，看面板 | 待真机 |

## 5. 调度与值班

| # | 结论 | 证据 | 状态 |
|---|---|---|---|
| 5.1 | 按余量选卡、占满换卡、准入 `free - headroom >= need` | `src/__tests__/queue*.test.ts`；门禁 `queue dispatch` 真起 daemon 把活放上卡 | 节点 |
| 5.2 | 跑挂 / 断联让位，卡位不泄漏 | `crash.test.ts` + `daemon.test.ts`；`occupiesSlot` 只认非 failed / 非 lost | 夹具 |
| 5.3 | 卡住检测：`starting` 超 120 秒判 stuck | `stuckJobs()` + 门禁 `queue dispatch` 的超时分支 | 夹具 |
| 5.4 | 两张卡不会同时上同一个任务 | 单写守护进程 + 租约；`daemon` 门禁两步 | 节点 |
| 5.5 | 真机多任务并发时调度正确 | 用户机器上同时提交两个训练任务，看是否各上一张卡 | 待真机 |

## 6. 多会话

| # | 结论 | 证据 | 状态 |
|---|---|---|---|
| 6.1 | `--session` / `GPULEASE_SESSION` / `DSH_SESSION_ID` 三条来源，优先级 flag > 任务行 > 环境 | `src/__tests__/session.test.ts`；门禁 `smoke test the exe` 断言 `run.session` 原样与无会话 `null` | 节点 |
| 6.2 | 队列任务认入队时的会话 | 端到端「队列里起的活：认入队时的会话，不认 daemon 的环境变量」 | 节点 |
| 6.3 | `sessions` 按会话汇总在跑 / 排队 / 最差 / 整体进度 | `src/__tests__/sessions.test.ts` 5 条 + 端到端汇总 1 条；门禁 `sessions --json` 排队行断言 | 节点 |
| 6.4 | 整体进度只平均真报了百分比的任务并披露覆盖数 | `summarizeSessions` 单测；无百分比时 `progress: null` | 夹具 |
| 6.5 | 多会话同时起活不撞库 | 端到端并发 4 会话回归；`store.ts` 先设 `busy_timeout` 再切 WAL，切不动退让重试 | 夹具 |

## 7. 稳

| # | 结论 | 证据 | 状态 |
|---|---|---|---|
| 7.1 | 占用率历史：15 秒一行、留 24 小时 | `history.test.ts`；门禁 `history across daemon restarts` 跨重启读到 ≥2 tick | 节点 |
| 7.2 | 值班自身开销在预算内 | 门禁 `perf budget`：20 秒浸泡 CPU / RSS 断言 < 40% / 250 MB，实测见 release 说明 | 节点 |
| 7.3 | 长时浸泡不掉内存 | 手动 `soak.yml` 30 分钟；0.4.0 实测 CPU 0.8% / RSS 40.6 MB / 涨 8.8 MB | 节点 |
| 7.4 | 值班崩溃留现场 | `logs/daemon-crash-*.log` + `doctor --bundle` 打包 | 夹具 |
| 7.5 | 交互式 `watch` 面板（TTY、`q` 退出、`--fast`） | runner 无 TTY，`setRawMode` 不在这里验 | 待真机 |

## 8. 契约与文档

| # | 结论 | 证据 | 状态 |
|---|---|---|---|
| 8.1 | `--json` 形状与 `docs/08-contract.md` 一致 | 门禁每一步都 `ConvertFrom-Json` 后按字段断言；契约里的样例由门禁同一版 exe 产出 | 节点 |
| 8.2 | 状态字面量集合不变（`verdict` / `kind` / `state`） | 契约 8 节 + `types.ts` / `alerts.ts`；新增字面量属 major | 夹具 |
| 8.3 | 装 / 卸 / 排障文档能照着走通 | `docs/07-install-and-troubleshooting.md` + 门禁装卸步骤 | 节点 |
| 8.4 | 退出码约定（cron / 脚本能判断） | `cancel` 未知 id = 1；`submit` 缺命令 = 2；非 Windows `install` = 1 | 夹具 |

## 9. 发布前最后一次真机验收（用户机器，约 10 分钟）

拿到有卡的机器后，按顺序跑，把输出贴回来即可（不需要给它开 runner）。第一条命令会自动判掉能机器判的条目，剩下的只有要动手的那几条：

```powershell
gpulease doctor --acceptance        # 按本表当场自检，写出 acceptance.json / acceptance.md
gpulease doctor --bundle            # 存下 diagnostic 包，含显卡与进程层实况
gpulease ls                         # 面板：卡、占用、任务归属
gpulease run --name 训练 -- python train.py
gpulease sessions --no-color        # 会话汇总
gpulease submit --name 出图 --need-vram 8 -- python comfy.py
gpulease daemon                     # 另开一个窗口，看排队活什么时候上卡
gpulease watch                      # 再开一个窗口，看 TUI 与 q 退出
```

对应要看的行：2.2、2.5、3.4、3.5、3.6、4.4、5.5、7.5。这八条从「待真机」变「节点/真机」之后，矩阵里就只剩形式，可以打 `v1.0.0`。

## 10. 这张表怎么维护

- 加功能 → 加行，写清证据落在哪个门禁步骤或哪个测试文件；没有证据的行只能是「待真机」，并且必须属于第 2 节那四类。
- 门禁步骤改名 → 同步这张表，`docs/05-windows-verification.md` 里的步骤清单也要改。
- 每次发布把 tag run 号写进 `CHANGELOG.md`，本表只记「证据在哪」，不记运行号。
