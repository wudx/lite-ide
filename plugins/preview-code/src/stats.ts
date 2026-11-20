import { createServiceKey } from '@lite-ide/kernel'
import { createSignal, type Accessor, type Setter } from 'solid-js'

export interface CodePreviewStats {
  language: string
  lineCount: number
  line: number
  column: number
  dirty: boolean
  readOnly: boolean
  encoding: string
  size: number
}

export interface CodeStatsService {
  readonly stats: Accessor<CodePreviewStats | null>
  readonly setStats: Setter<CodePreviewStats | null>
}

export const CodeStatsKey = createServiceKey<CodeStatsService>('plugin.previewCode.stats')

export function createCodeStatsService(): CodeStatsService {
  const [stats, setStats] = createSignal<CodePreviewStats | null>(null)
  return { stats, setStats }
}
