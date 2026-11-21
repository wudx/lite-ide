/**
 * Vitest 测试桩：`liteide` 是宿主在插件求值期注入的虚拟模块（见
 * packages/workbench/src/plugin-host.ts 的宿主 require 表），bundle 外不可
 * 解析。单测直接引用插件源码（如 git 的 xlsx-diff / gitPlugin）时经此别名
 * 提供同形状 API——loadChunk 按需返回真实依赖，保持解析管线用例的真实性。
 * 仅被 vitest.config.ts 的 resolve.alias 引用，不参与任何构建产物。
 */
import { createRequire } from 'node:module'
import path from 'node:path'

export const apiVersion = 2

export function plugin(_definition: unknown): void {
  // 源码级测试通过 evaluateExternalPlugin 的捕获层注册，此桩不需要捕获。
}

export async function loadChunk(name: string): Promise<Record<string, unknown>> {
  if (name === 'xlsx') {
    // xlsx 是 plugins/git 的依赖（pnpm 严格布局），从该包目录解析（vitest
    // cwd = 仓库根；vite 会重写 import.meta.url，不能用）。真实 SheetJS，
    // xlsx-diff.test 的解析断言依赖它。
    const req = createRequire(path.join(process.cwd(), 'plugins/git/package.json'))
    const XLSX = req('xlsx') as Record<string, unknown>
    return { default: XLSX }
  }
  return {}
}
