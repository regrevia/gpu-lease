# 第三方代码与素材

gpulease 自己写的代码是 MIT。下面这些项目**读过、参考过设计**，按各自许可证处理。

## 参考了视觉与信息组织（未复制代码）

| 项目 | 许可证 | 参考了什么 | 复制了什么 |
|---|---|---|---|
| [XuehaiPan/nvitop](https://github.com/XuehaiPan/nvitop) | Apache-2.0 | TUI 的信息密度、每卡一块 + 进程行缩进的排布、8 色调色纪律 | 无。行格式在本项目 `src/render.ts` 自己写 |
| [wookayin/gpustat-web](https://github.com/wookayin/gpustat-web) | MIT | 单页看板的骨架：一块显卡区、一块进程区、无前端框架 | 无。本项目页面是内嵌 HTML + SSE，见 `src/server.ts` |

Apache-2.0 的 NOTICE 要求：若以后真的拷入 nvitop 的代码，必须在仓库根放 `NOTICE` 并保留其版权声明。目前没有任何拷贝，所以本文件就是记录。

## 只看过、明确不复制

| 项目 | 许可证 | 为什么不能用 |
|---|---|---|
| [Syllo/nvtop](https://github.com/Syllo/nvtop) | GPL-3.0 | 强 copyleft。任何代码、注释、函数结构都不抄，只读它的交互结论 |
| [mountassir/gmonitor](https://github.com/mountassir/gmonitor) | GPL-3.0 | 同上，且 2019 年后停更 |
| [evilsocket/gptop](https://github.com/evilsocket/gptop) | NOASSERTION | 许可证不明，不能用 |
| [Asimok/GPU-Monitor](https://github.com/Asimok/GPU-Monitor) | 无许可证 | 无许可证等于保留所有权利，不能用 |

## 运行时依赖

无。构建期只有 Bun（`bun:sqlite` 是运行时内置模块），发布物是单文件 exe。

## 数据来源

- `nvidia-smi`（NVIDIA 驱动自带，随驱动分发）
- Windows `Win32_Process`（WMI/CIM）
- Windows 事件日志（`System`，`Display` / `nvlddmkm`）

以上都只读，不上传任何数据。gpulease 不发网络请求。
