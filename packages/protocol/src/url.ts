import type { WorkspaceBackend } from './types'

export function isWindowsRuntime(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const platform = navigator.platform || ''
  return /Win/i.test(platform) || /Windows/i.test(ua)
}

export function encodeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export function getWorkspaceFileUrl(
  projectId: string,
  relPath: string,
  backend?: WorkspaceBackend,
  forceWindows?: boolean,
): string {
  if (backend?.resolveFileUrl) {
    return backend.resolveFileUrl(projectId, relPath)
  }

  const encodedId = encodeURIComponent(projectId)
  const encodedPath = encodeRelPath(relPath)
  const useWindows = forceWindows ?? isWindowsRuntime()

  if (useWindows) {
    return `http://workspace.localhost/${encodedId}/${encodedPath}`
  }
  return `workspace://localhost/${encodedId}/${encodedPath}`
}
