// 把 service/main.js 连同同目录模块打成单文件 service/bundle.js。
// 宿主用 Electron 的 Node 运行时执行服务入口，单文件最稳（不依赖相对 import 解析）。
import path from 'node:path'
import { loadEsbuild, ROOT } from './_deps.mjs'

const { build } = await loadEsbuild()

await build({
  entryPoints: [path.join(ROOT, 'service/main.js')],
  outfile: path.join(ROOT, 'service/bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  logLevel: 'info',
})
console.log('built service/bundle.js')
