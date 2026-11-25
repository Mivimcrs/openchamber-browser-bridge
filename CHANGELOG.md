# Changelog

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
