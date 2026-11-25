# Changelog

## 0.2.2 — 2026-11-25

- 修复 setup 离线包遗漏 `skills/`：解压安装后 agent 拿不到授权流程与动作口径的 skill。
- 离线包整棵包含 panel / plugin / service / skills / 文档 与 install 脚本。

## 0.2.1 — 2026-11-25

- 新增 Windows 一键安装：`install/install.ps1` 复制扩展、登记路径、把浏览器提供者
  指向本扩展，并打印后续步骤；`-Grant` 可跳过首次权限批准。
- Release 同时提供两个资产：
  - `openchamber-browser-bridge-<version>.zip`：只含扩展包（在 OpenChamber UI 里添加）；
  - `openchamber-browser-bridge-<version>-setup.zip`：扩展包 + 安装脚本，
    解压后双击 `install/offline-install.cmd` 即可，无需 git / npm / 浏览器侧扩展。
- 安装脚本只改本扩展相关条目（`extensions.json` 的 paths、`settings.json` 的
  browserProvider），不触碰其它扩展与其设置。

## 0.2.0 — 2026-11-25

首个公开版本：由「驱动日常浏览器」的旧桥改为**拉起式**浏览器桥。

- 扩展以 `service.provides: ["browser"]` 接管 OpenChamber 的 `openchamber_web`，实现
  宿主转发的 12 个 `browser.*` 动作（open/snapshot/click/type/select/scroll/back/
  forward/inspect/capture/resize/close）。
- 服务按需 spawn 本机 Chromium：独立持久 profile、`--remote-debugging-port=0` 自选端口、
  读 `DevToolsActivePort` 建 CDP WebSocket。
- 复连：服务重启后先试记录端口、再试 profile 里的 `DevToolsActivePort`，复用同一窗口。
- 每会话一次授权（12 小时 TTL）：`browser_bridge_authorize` 工具 + 授权文件；
  未授权时动作返回可执行的提示。
- 浏览器路径可配置（任意 Chromium 内核），缺失时返回安装引导；默认按
  ungoogled-chromium → Chrome → Edge → Vivaldi 顺序探测。
- 侧边栏面板：浏览器路径、持久 profile、授权状态、桥运行状态与受控页面。
- 附带 agent skill（授权流程与 12 动作口径）。

### 修复

- `browser.type` 对非输入元素抛 `Illegal invocation`（先判元素类型）。
- 端口记录过期导致「调试端口没有就绪」：launch 前清理遗留
  `DevToolsActivePort`，并以 `/json/version` 真正可应答为准。
- `browser.resize` 回报未实测尺寸。
