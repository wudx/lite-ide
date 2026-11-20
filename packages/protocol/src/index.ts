import {
  createMockGitBackend,
  createTauriGitBackend,
} from './git-backend'
import { createMockBackend, MOCK_DEMO_PATHS } from './mock-backend'
import { createTauriBackend } from './tauri-backend'
import type { GitBackend, WorkspaceBackend } from './types'

export * from './types'
export * from './url'
export { createMockGitBackend, createTauriGitBackend } from './git-backend'
export { createMockBackend, MOCK_DEMO_PATHS } from './mock-backend'
export { createTauriBackend } from './tauri-backend'

export function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function createDefaultBackend(): WorkspaceBackend {
  return isTauriEnvironment() ? createTauriBackend() : createMockBackend()
}

export function createDefaultGitBackend(): GitBackend {
  return isTauriEnvironment() ? createTauriGitBackend() : createMockGitBackend()
}
