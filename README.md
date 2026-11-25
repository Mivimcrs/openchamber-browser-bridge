# OpenChamber-Browser-bridge

让 OpenChamber 的 `openchamber_web` 工具在**对话需要浏览器自动化**时，经用户授权
**自动拉起本机 Chromium**（独立持久 profile，CDP 驱动），agent 逐步下发原子指令。

这是 OpenChamber 扩展，不是浏览器扩展：不需要在浏览器里「加载已解压」，装一次扩展、
批准权限，之后每个对话按需授权即可。

## 它解决什么

- 对话里需要真实浏览器（登录、点选、填表、抓取、截图验证）时，agent 直接用
  OpenChamber 自带的 `openchamber_web`，动作转给本扩展拉起的 Chromium 执行。
- 浏览器窗口真实可见、可手动接管；profile 独立且持久，登录一次长期保留，
  不碰你日常浏览器的 Cookie 与登录态。
- 第一个动作前会先征得你同意（每会话一次，12 小时有效），不会静默开浏览器。

## 安装

1. OpenChamber → 设置 → 扩展 → 添加扩展（本仓库根目录，或 Release 里的 zip）。
2. 批准 `service`、`opencodePlugin`、`skills` 权限。
3. 设置 → 通用 → OpenChamber 工具 → **浏览器提供者** → 选「OpenChamber-Browser-bridge」。
4. （可选）打开侧边栏「OpenChamber-Browser-bridge」面板核对浏览器路径。

## 使用

对话里让 agent 做浏览器操作：

1. agent 先问「是否允许本次对话拉起并操作浏览器」；
2. 你同意 → agent 调 `browser_bridge_authorize` 写授权；
3. 浏览器自动出现，agent 开始操作。

面板里可以改浏览器路径（任意 Chromium 内核：ungoogled-chromium / Chrome / Edge /
Vivaldi）、撤销授权、查看桥状态。

## 支持的浏览器

推荐安装 `https://github.com/ungoogled-software/ungoogled-chromium` 并写入用户环境中使用，和日常浏览器隔离。

找不到时 `browser.open` 会返回安装引导，agent 会转述给用户。面板里可指定任意路径。

## 动作支持

宿主只把 12 个动作转发给扩展 provider：

`browser.open` / `snapshot` / `click` / `type` / `select` / `scroll` / `back` /
`forward` / `inspect` / `capture` / `resize` / `close`

`hover` / `press` / `drag` / `upload` / `dialog` / `wait` 宿主会直接拒绝（400）。
快照元素没有 `e12` 这类 ref，寻址用元素返回的 `selector` 或可见 `text`。

## 结构

| 路径 | 说明 |
| --- | --- |
| `package.json` | OpenChamber 扩展清单 |
| `service/main.js` | 本机回环服务：`POST /browser-control`、面板 `/ui/*` |
| `service/browser.mjs` | 浏览器管理器：spawn Chromium、读 `DevToolsActivePort`、CDP WebSocket、复连 |
| `service/provider.mjs` | 12 个动作 → CDP / 页面脚本翻译 |
| `service/state.mjs` | 设置、每会话授权（12h TTL）、浏览器存在性 |
| `service/bundle.js` | 服务入口单文件打包（清单指向它） |
| `plugin/index.js` | OpenCode 插件：`browser_bridge_authorize` / `browser_bridge_status` |
| `panel/` | 侧边栏面板（浏览器路径 / 授权 / 桥状态） |
| `skills/browser-bridge/SKILL.md` | 给 agent 的使用口径 |
| `tests/` | 协议与 HTTP 单测 |
| `tools/` | 构建、自检、打包、冒烟测试 |

## 开发

```bash
npm install
npm run build          # service/main.js -> service/bundle.js；panel/main.js -> panel/built.js
npm run check          # 清单 / 入口 / 语法 / 本机路径泄漏
npm test               # 单元测试
npm run smoke          # 起服务，授权门 + 真拉起 Chromium 跑动作
npm run smoke:bundle   # 用打包后的 bundle.js 再跑一遍
npm run package        # 出 dist/openchamber-browser-bridge-<version>.zip
```

`service/bundle.js` 与 `panel/built.js` 是**提交进仓库的构建产物**：宿主按 URL/zip 安装
时读仓库根目录的 `package.json` 与入口文件，所以不能只留源码。

## 设计要点

- Chromium 136+ 禁止 `--remote-debugging-port` 配默认 profile，强制独立 `--user-data-dir`；
  端口用 `--remote-debugging-port=0` 自选，避开 9333 与 43290–43299。
- 复连：先试上次记录的端口，再试 profile 里的 `DevToolsActivePort`，能应答
  `/json/version` 就复用同一窗口；失败才重新拉起。
- 服务停止不杀浏览器：窗口是用户的，重启用同一 profile 复连。
- 授权文件放扩展包根 `.state/`：service 与 OpenCode 插件进程都能算出同一路径
  （插件进程拿不到服务数据目录）。
- 截图走 CDP `Page.captureScreenshot`，不要求窗口前台、不抢焦点。

## 已知限制

- 一个浏览器实例同一时刻只有一组受控标签；`browser.snapshot` 的 `tabs` 列出全部。
- 视口切换是 CDP `Emulation.setDeviceMetricsOverride`，不改真实窗口尺寸。
- 宿主只转发 12 个动作（见上）。
- 只支持 Windows（路径与启动方式按 Windows Chromium 写；其他平台需改候选路径）。

## License

MIT
