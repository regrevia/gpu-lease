# 安装与排障

这份文档只讲一件事：怎么让 `gpulease` 在这台 Windows 上稳定地待着，以及它不动的时候先看哪里。

## 装

```powershell
.\gpulease.exe install --autostart
```

做四件事，每件都会在输出里说清楚：

| 步骤 | 落到哪 |
|---|---|
| 放程序文件 | `%LOCALAPPDATA%\gpulease\bin\gpulease.exe` |
| 加 PATH | 用户级 PATH（不是系统级，不需要管理员） |
| 开始菜单 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\gpu-lease\gpulease.lnk`，指向 `watch` |
| 开机自启 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\gpulease` = `"…\gpulease.exe" daemon --quiet` |

`--autostart` 可以不加。想装在别的盘（便携目录）用 `--dir D:\tools\gpulease`；这时候开始菜单和自启仍然指向那个目录。
想要机器可读的输出加 `--json`（`bin_dir` / `exe` / `shortcut` / `autostart` / `replaced` / `done`）。

装完**当前这个终端不会自动拿到新 PATH**——新开一个终端再敲 `gpulease ls`。这是 Windows 的行为，不是装失败。

## 升级

下载新版 zip、解压、跑一次 `install` 就行：

```powershell
.\gpulease.exe install
```

- 装的位置不变，PATH 不会重复加（大小写不敏感，尾部分号也认）。
- 如果旧的 `gpulease.exe` 正被值班进程占着，Windows 不允许覆盖：先把它改名成 `gpulease.exe.old`，再把新文件写进去，下次 `install` 时清掉那个 `.old`。输出里会直说。
- 升级不改状态目录：任务账本、24 小时历史、日志都还在 `%LOCALAPPDATA%\gpulease`。

## 卸

```powershell
gpulease uninstall            # 关自启、删快捷方式、从 PATH 里去掉
gpulease uninstall --purge    # 再删程序文件和状态目录（任务账本、历史、日志一起没）
```

`--purge` 如果是在装好的那个 exe 上跑的，它自己删不掉自己——会改名成 `.old` 并说明，这个进程退出后就能删。不装作删成功。

## 排障

先跑这两个，把结果贴出来基本就能定位：

```powershell
gpulease doctor            # 没卡也会说清"没有 NVIDIA 卡"，不会装作有一张闲卡
gpulease doctor --bundle   # 出诊断包：版本、采集结果、最近事件、崩溃现场
```

| 现象 | 先看什么 | 常见原因 |
|---|---|---|
| `gpulease` 不是内部或外部命令 | 新开终端；`[Environment]::GetEnvironmentVariable('PATH','User')` 里有没有 `…\gpulease\bin` | 装完没重开终端；PATH 被别的安装器整段覆盖 |
| 开机后没有值班进程 | `gpulease daemon` 手动跑一次看报什么；`doctor --json` 里 `daemon` 段 | 自启项被安全软件拦；`--autostart` 没加 |
| 面板里所有任务都显示 `external` | 任务是不是用 `gpulease run` / `submit` 起的 | 外部进程不猜归属，只给 pid——这是设计，不是 bug |
| 显存 `[N/A]` | 驱动版本 | Windows WDDM 下按进程的显存常拿不到，面板会直说看不到，不填假数字 |
| `nvidia-smi 超时` | 单独跑一次 `nvidia-smi` | 驱动卡住或被杀软拦；gpulease 等 3 秒就放弃并报"断联"，不会挂住一轮采集 |
| 值班进程崩过 | `%LOCALAPPDATA%\gpulease\logs\daemon-crash-*.log` | 里面有版本、位置、堆栈；`doctor --bundle` 会带走 |
| SmartScreen 拦住 exe | 更多信息 → 仍要运行 | 没签名。哈希在 release 的 `SHA256SUMS.txt` 里，先核对 |

## 关于测试节点

自托管 Windows 节点 `regrevia-win` 上**没有 NVIDIA 显卡**，所以门禁验的是：编译、CLI/JSON 契约、托管启动与进程归属、无卡降级、排队调度、进度解析、历史落库、值班开销，以及安装/卸载在真注册表和真 PATH 上的效果。显卡数字与多卡行为要靠真机 `doctor --bundle` 的输出补。门禁不假装验过显卡。
