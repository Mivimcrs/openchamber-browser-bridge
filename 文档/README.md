# OpenChamber-Browser-bridge（拉起式浏览器桥）

让 OpenChamber 的 `openchamber_web` 工具在**对话需要浏览器自动化**时，经授权
**自动拉起本机 Chromium**（独立持久 profile，CDP 驱动），agent 逐步下发原子指令。

## 它和旧桥的区别

| | 旧桥（`OpenChamber浏览器桥`） | 本扩展 |
| --- | --- | --- |
| 浏览器 | 驱动你**日常**浏览器里装的 Chrome MV3 扩展 | **拉起**独立 Chromium 实例 |
| 前提 | 手动在浏览器「加载已解压」并在浏览器里常连 | 无需浏览器扩展；对话授权即自动拉起 |
| 登录态 | 你日常浏览器的真实登录态 | 独立持久 profile，登录一次长期保留 |
| 动作通道 | 扩展 WS 协议 | CDP（Chrome DevTools Protocol） |

与旧桥共用 `browser-bridge` 面板 id / 浏览器提供者槽位，装本版即替换（旧目录保留，
随时可装回）。

## 组成

| 路径 | 说明 |
| --- | --- |
| `package.json` | OpenChamber 扩展清单（panel + service:provides browser + opencodePlugin + skills） |
| `service/main.js` | 本机回环服务：`POST /browser-control`（12 个 browser.* 动作）、面板 `/ui/*` |
| `service/browser.mjs` | 浏览器管理器：spawn Chromium、读 `DevToolsActivePort`、CDP WebSocket |
| `service/provider.mjs` | 动作用页面脚本 + CDP 翻译（快照/点击/输入/选择/滚动/截图/视口） |
| `service/state.mjs` | 设置（浏览器路径、profile 目录）与每会话授权（12h TTL） |
| `service/bundle.js` | 服务入口单文件打包（manifest 指向它） |
| `plugin/index.js` | OpenCode 插件：`browser_bridge.authorize` / `browser_bridge.status` 工具 |
| `panel/` | 面板：浏览器路径、持久 profile、授权状态、桥运行状态 |
| `skills/browser-bridge/SKILL.md` | 给 agent 的操作口径（授权流程、只支持 12 动作、寻址用 selector/text） |
| `tools/` | 构建、同步、清单校验、冒烟测试 |

## 使用流程

1. 装扩展（OpenChamber → 设置 → 扩展），批准 `service` 权限。
2. 设置 → 通用 → OpenChamber 工具 → **浏览器提供者** 选「OpenChamber-Browser-bridge」
   （或跑 `tools/set-provider.mjs`）。
3. 对话里让 agent 做浏览器操作。首次 `browser.open` 会被授权门拦下，
   agent 用选择题问你；你同意后 agent 调 `browser_bridge.authorize`，
   然后浏览器自动拉起并继续执行。12 小时内同一会话不再问。
4. 面板里可改浏览器路径（默认按候选顺序找 ungoogled-chromium / Chrome / Edge / Vivaldi）、
   持久 profile 目录，或撤销授权。

## 口径与边界

- Chromium 136+ 不允许 `--remote-debugging-port` 配默认 profile：本桥强制独立
  `--user-data-dir`，端口用 `--remote-debugging-port=0` 自选（避开 9333 与 43290–43299）。
- 窗口是用户的：服务停止/重启不杀浏览器，重启用 `DevToolsActivePort` 复连。
- `browser.capture` 走 CDP `Page.captureScreenshot`，不要求窗口在前台、不抢焦点。
- 视口切换是 CDP `Emulation.setDeviceMetricsOverride`，不是改真实窗口尺寸。
- 一个浏览器实例同一时刻只有一个受控页集合；`browser.snapshot` 的 `tabs` 列出全部。
- 宿主只转发 12 个动作；`hover/press/drag/upload/dialog/wait` 会被宿主 400，
  快照元素没有 `e12` ref，寻址只用 selector / text。

## 构建与验证

```powershell
node tools/build-service.mjs    # service/main.js -> service/bundle.js
node tools/build-panel.mjs      # panel/main.js -> panel/built.js
node 本地工具/sync-installed.mjs   # 同步到本机已安装的扩展目录
node tools/check-manifest.mjs   # 用 SDK 的 zod schema 校验清单
node tools/smoke.mjs skip-browser   # 授权门 + 缺浏览器引导（不拉浏览器）
node tools/smoke.mjs                # 真拉起 Chromium，跑动作
node tools/smoke-bundle.mjs         # 用打包后的 service/bundle.js 跑同一套
```

冒烟通过后再在会话里用 `openchamber_web` 走一遍宿主链路。
