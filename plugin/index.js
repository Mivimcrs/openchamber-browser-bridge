// OpenCode 插件：注册 browser_bridge_* 工具。
// - browser_bridge.authorize：用户在对话里同意后，agent 调它写授权（每会话一次的门）
// - browser_bridge.status：查浏览器路径/授权/桥状态
// 授权文件由本插件与 service 共用同一个实现（plugin/state.mjs 与 service/state.mjs 同源，
// 都落在扩展包根 .state/authorization.json），因此不依赖任何服务端口。
import { readAuthorization, isAuthorized, authorizeSession, browserExecutableStatus, readSettings, resolveProfileDir, AUTH_TTL_MS } from './state.mjs'

const plugin = {
  id: 'openchamber-browser-bridge',
  async setup(ctx) {
    const registration = await ctx.tool.transform((editor) => {
      editor.namespace({
        name: 'browser_bridge',
        description: 'OpenChamber-Browser-bridge：对话授权拉起本机 Chromium 并由 openchamber_web 驱动',
      })

      editor.add({
        name: 'authorize',
        description:
          '用户在对话里明确同意使用浏览器后，调用本工具写入授权（每个会话只需一次，12 小时有效）。' +
          '写入后重试 openchamber_web 的 browser.* 操作即可自动拉起浏览器。' +
          '没有用户同意不要调用。',
        input: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: 'browser_bridge', codemode: false },
        execute: async (_input, context) => {
          const sid = (context && context.sessionID) || ''
          const record = authorizeSession(sid)
          const exe = browserExecutableStatus(readSettings())
          const lines = [
            '已授权本会话使用浏览器（12 小时内免再问）。',
            `浏览器：${exe.path}${exe.exists ? '' : '（未找到！拉起会失败，请先在面板里核对路径）'}`,
            '现在可以重试 browser.open 等操作，浏览器会自动拉起。',
          ]
          return { content: lines.join('\n') }
        },
      })

      editor.add({
        name: 'status',
        description:
          '查浏览器桥状态：浏览器路径与安装情况、授权状态。只读。',
        input: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        options: { namespace: 'browser_bridge', codemode: false },
        execute: async () => {
          const settings = readSettings()
          const auth = readAuthorization()
          const authorized = auth ? Date.now() - auth.at <= AUTH_TTL_MS : false
          const exe = browserExecutableStatus(settings)
          const lines = [
            `浏览器：${exe.path}${exe.exists ? '（已安装）' : '（未找到！）'}`,
            `辅助目录：${resolveProfileDir(settings)}（浏览器 profile 由服务在服务数据目录下管理）`,
            `授权：${authorized ? `已授权（会话 ${auth.sessionId || '(空)'}，${new Date(auth.at).toLocaleString()}）` : '未授权'}`,
          ]
          return { content: lines.join('\n') }
        },
      })
    })
    return () => registration.dispose().catch(() => {})
  },
}

export default plugin
