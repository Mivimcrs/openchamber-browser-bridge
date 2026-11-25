// 构建依赖定位：优先本仓库 node_modules，其次本机共享构建环境。
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const LOCAL = path.join(ROOT, 'node_modules')
const SHARED = 'D:/AppData/OpenChamber/IDE/生图扩展构建环境/node_modules'

/** 加载 esbuild */
export async function loadEsbuild() {
  const candidates = [
    path.join(LOCAL, 'esbuild/lib/main.js'),
    path.join(SHARED, 'esbuild/lib/main.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href)
  }
  throw new Error('找不到 esbuild：请先 npm install')
}

/** @openchamber/sdk 的包目录 */
export function sdkPath() {
  for (const base of [LOCAL, SHARED]) {
    const dir = path.join(base, '@openchamber/sdk')
    if (existsSync(dir)) return dir
  }
  throw new Error('找不到 @openchamber/sdk：请先 npm install')
}
