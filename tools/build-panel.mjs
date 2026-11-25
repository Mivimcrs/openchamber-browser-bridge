// 用 esbuild 把 panel/main.js 连同 @openchamber/sdk 打成单文件 panel/built.js。
import path from 'node:path'
import { loadEsbuild, sdkPath, ROOT } from './_deps.mjs'

const { build } = await loadEsbuild()

await build({
  entryPoints: [path.join(ROOT, 'panel/main.js')],
  outfile: path.join(ROOT, 'panel/built.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  alias: { '@openchamber/sdk': sdkPath() },
  logLevel: 'info',
})
console.log('built panel/built.js')
