---
name: browser-bridge
description: 对话需要浏览器自动化时，经用户授权拉起本机 Chromium（CDP + 独立持久 profile）并用 openchamber_web 逐步驱动。
---

# 浏览器桥（OpenChamber-Browser-bridge）

## 什么时候用

对话里需要真实浏览器操作（登录、点选、填表、抓取页面、截图验证）时，用 `openchamber_web` 的 `browser.*` 动作。本扩展会把动作转发给一个由它拉起的**独立 Chromium 实例**（真实窗口、独立持久 profile，不碰用户的日常浏览器与登录态）。

## 必须的授权流程

1. **不要先直接调 `browser.open`。** 第一次在某个会话里用浏览器前，先用选择题问用户：
   「是否允许本次对话拉起并操作浏览器？」（选项：允许 / 不允许）。
2. 用户允许后，调用 `browser_bridge.authorize` 工具（每个会话一次，12 小时内免再问）。
3. 再调 `openchamber_web` 的 `browser.open`。浏览器会自动拉起，窗口会出现。
4. 用户拒绝：不要调用任何 browser.* 动作，说明无法执行即可。

如果工具返回「本会话尚未授权使用浏览器」，按第 1 步重新问用户，再 `browser_bridge.authorize`。

## 动作口径（provider 只支持 12 个动作）

- 支持：`browser.open` / `snapshot` / `click` / `type` / `select` / `scroll` / `back` / `forward` / `inspect` / `capture` / `resize` / `close`。
- **不支持**（宿主会报 400）：`browser.hover` / `press` / `drag` / `upload` / `dialog` / `wait`。需要键盘、拖拽、上传时，改用 `browser.type` + `submit`、`browser.click`，或让用户在浏览器窗口里手动完成。
- 元素寻址只用 `selector`（来自 `browser.snapshot` 返回的 elements）或 `text`（链接/按钮可见文字）；**没有 ref 语义**，快照里没有 `e12` 这类编号。
- `browser.capture` 需要浏览器窗口在前台；失败时按错误提示把窗口切到前台再截。

## 浏览器未安装时

`browser.open` 会返回「浏览器未安装：找不到 …」。把这段安装引导原样转述给用户：
- 默认浏览器是 ungoogled-chromium（`C:\UserProgram\ungoogled-chromium\chrome.exe`）。
- 或在扩展面板里把浏览器路径改成本机任意 Chromium 内核浏览器（Edge/Chrome/Vivaldi 的 exe）。

## 其他

- 用 `browser_bridge.status` 查当前浏览器路径、安装状态、授权状态（只读）。
- 同一时刻只有一个受控页集合；`browser.snapshot` 的 `tabs` 列出全部受控标签。
- 关闭标签用 `browser.close`；不要关用户没让你关的标签。
