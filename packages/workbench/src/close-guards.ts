import type { AppKernel, ProjectScope } from '@lite-ide/kernel'
import { ConfirmDialogKey } from './dialogs'
import {
  EditorBufferKey,
  isUntitledPath,
  untitledDisplayNameOf,
} from './editor-buffers'
import { ProjectSelectionKey, WorkspaceBackendKey } from './services'

const MAX_DETAIL_ITEMS = 5

export interface SaveAsResult {
  ok: boolean
  error: string | null
}

/**
 * Parses a user-typed save target relative to the project root. Accepts a
 * plain file name ("notes.md") or a nested path ("src/components/notes.md");
 * backslashes and duplicated separators are normalized to "/". Returns the
 * { dir, name } split, or an error message when any segment is invalid.
 */
export function parseSaveTarget(rawName: string): { dir: string; name: string } | string {
  const cleaned = rawName.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (!cleaned || cleaned === '/') {
    return 'Name cannot be empty.'
  }
  if (cleaned.startsWith('/')) {
    return 'Use a path relative to the project root.'
  }

  const idx = cleaned.lastIndexOf('/')
  const dir = idx === -1 ? '' : cleaned.slice(0, idx)
  const name = cleaned.slice(idx + 1)

  for (const seg of [...(dir ? dir.split('/') : []), name]) {
    if (!seg || seg === '.' || seg === '..') {
      return 'Path cannot contain empty, "." or ".." segments.'
    }
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) {
      return 'Contains invalid characters: < > : " | ? *'
    }
  }
  return { dir, name }
}

/**
 * Saves an untitled buffer under a user-chosen path inside the project.
 * Missing parent directories are created best-effort; the backend createFile
 * remains the source of truth and surfaces real failures. On save failure the
 * buffer and tab roll back to the untitled path so the popover stays usable.
 */
export async function saveUntitledAs(
  kernel: AppKernel,
  scope: ProjectScope,
  untitledRelPath: string,
  rawName: string,
): Promise<SaveAsResult> {
  const buffers = scope.tryGet(EditorBufferKey)
  if (!buffers || !isUntitledPath(untitledRelPath)) {
    return { ok: false, error: 'Not an untitled buffer.' }
  }
  if (!buffers.getBuffer(untitledRelPath)) {
    return { ok: false, error: 'Untitled buffer no longer exists.' }
  }

  const parsed = parseSaveTarget(rawName)
  if (typeof parsed === 'string') {
    return { ok: false, error: parsed }
  }
  const targetRel = parsed.dir ? `${parsed.dir}/${parsed.name}` : parsed.name
  return saveUntitledToRelPath(kernel, scope, untitledRelPath, targetRel)
}

/** Core save routine for an already-validated project-relative target path. */
async function saveUntitledToRelPath(
  kernel: AppKernel,
  scope: ProjectScope,
  untitledRelPath: string,
  targetRel: string,
): Promise<SaveAsResult> {
  const buffers = scope.tryGet(EditorBufferKey)
  const selection = scope.get(ProjectSelectionKey)
  if (!buffers || !isUntitledPath(untitledRelPath)) {
    return { ok: false, error: 'Not an untitled buffer.' }
  }
  if (!buffers.getBuffer(untitledRelPath)) {
    return { ok: false, error: 'Untitled buffer no longer exists.' }
  }

  const backend = kernel.get(WorkspaceBackendKey)
  try {
    const dir = targetRel.includes('/') ? targetRel.slice(0, targetRel.lastIndexOf('/')) : ''
    if (dir) {
      // Create missing parents one level at a time; both backends only
      // create a single level. AlreadyExists-style failures are fine here —
      // createFile below is the authoritative check.
      let cursor = ''
      for (const seg of dir.split('/')) {
        cursor = cursor ? `${cursor}/${seg}` : seg
        await backend.createDir(scope.id, cursor).catch(() => {})
      }
    }
    await backend.createFile(scope.id, targetRel)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  buffers.renamePaths(untitledRelPath, targetRel, false)
  await selection.renamePaths(untitledRelPath, targetRel, false)

  const ok = await buffers.saveBuffer(targetRel)
  if (!ok) {
    buffers.renamePaths(targetRel, untitledRelPath, false)
    await selection.renamePaths(targetRel, untitledRelPath, false)
    const saveError = buffers.getBuffer(untitledRelPath)?.saveError
    return { ok: false, error: saveError ?? 'Failed to save the file.' }
  }
  return { ok: true, error: null }
}

/**
 * Entry point for saving an untitled buffer. On desktop (where the backend
 * offers a native save dialog) this behaves like VSCode: the OS file picker
 * opens rooted at the project folder and the chosen location is saved to.
 * In the browser (mock backend) it falls back to the inline save-as popover.
 * Returns whether the buffer was actually saved.
 */
export async function requestUntitledSave(
  kernel: AppKernel,
  scope: ProjectScope,
  untitledRelPath: string,
): Promise<boolean> {
  const backend = kernel.get(WorkspaceBackendKey)
  const selection = scope.get(ProjectSelectionKey)

  if (backend.pickSavePath) {
    const picked = await backend.pickSavePath(scope.id, untitledDisplayNameOf(untitledRelPath))
    if (!picked) return false
    const result = await saveUntitledToRelPath(kernel, scope, untitledRelPath, picked)
    if (result.ok) return true
    // Surface the failure in the inline popover so the user can retry.
    selection.requestSaveAs(untitledRelPath, result.error)
    return false
  }

  selection.requestSaveAs(untitledRelPath)
  return false
}

function baseNameOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

function formatDetails(paths: string[]): string[] {
  if (paths.length <= MAX_DETAIL_ITEMS) return paths
  const head = paths.slice(0, MAX_DETAIL_ITEMS)
  head.push(`...and ${paths.length - MAX_DETAIL_ITEMS} more`)
  return head
}

async function confirmAndCloseTabs(
  kernel: AppKernel,
  scope: ProjectScope,
  targetPaths: string[],
  keepRelPath?: string,
): Promise<boolean> {
  if (targetPaths.length === 0) return true

  const selection = scope.get(ProjectSelectionKey)
  const buffers = scope.tryGet(EditorBufferKey)
  const dialogs = kernel.tryGet(ConfirmDialogKey)
  const dirtyTargets = buffers ? targetPaths.filter((p) => buffers.isDirty(p)) : []

  if (dirtyTargets.length > 0) {
    if (!dialogs) return false
    const single = dirtyTargets.length === 1
    const choice = await dialogs.confirm({
      title: 'Unsaved Changes',
      message: single
        ? `Do you want to save changes to "${baseNameOf(dirtyTargets[0])}" before closing?`
        : `${dirtyTargets.length} files have unsaved changes. Save before closing?`,
      details: formatDetails(dirtyTargets),
      actions: [
        {
          id: 'save',
          label: single ? 'Save & Close' : 'Save All & Close',
          variant: 'primary',
        },
        {
          id: 'discard',
          label: single ? "Don't Save" : 'Discard & Close',
          variant: 'danger',
        },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ],
      cancelId: 'cancel',
    })

    if (choice === 'cancel') return false
    if (choice === 'save' && buffers) {
      for (const path of dirtyTargets) {
        const ok = await requestSaveFile(kernel, scope, path)
        if (!ok) {
          await selection.selectFile(path)
          return false
        }
      }
    }
  }

  if (keepRelPath !== undefined) {
    await selection.closeOtherTabs(keepRelPath)
  } else {
    selection.closeAllTabs()
  }

  for (const path of targetPaths) {
    buffers?.discardBuffer(path)
  }
  return true
}

export async function requestSaveFile(
  kernel: AppKernel,
  scope: ProjectScope,
  relPath: string,
): Promise<boolean> {
  const buffers = scope.tryGet(EditorBufferKey)
  const dialogs = kernel.tryGet(ConfirmDialogKey)
  const buf = buffers?.getBuffer(relPath)
  if (!buf || !buffers || buf.readOnly || buf.saving) {
    return false
  }

  // Untitled buffers need a file name before anything can be written; open
  // the native save dialog (desktop) or the save-as popover and report "not
  // saved" so close flows abort cleanly.
  if (isUntitledPath(relPath)) {
    return requestUntitledSave(kernel, scope, relPath)
  }

  if (buf.conflict === 'none') {
    return buffers.saveBuffer(relPath)
  }

  if (dialogs) {
    const choice = await dialogs.confirm({
      title: buf.conflict === 'deleted' ? 'File Deleted on Disk' : 'External Disk Change',
      message:
        buf.conflict === 'deleted'
          ? `"${buf.relPath}" was deleted on disk. Recreate the file and save your buffer?`
          : `"${buf.relPath}" changed on disk. Overwrite the disk version with your current edits?`,
      actions: [
        {
          id: 'overwrite',
          label: buf.conflict === 'deleted' ? 'Recreate & Save' : 'Overwrite Disk',
          variant: 'primary',
        },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (choice !== 'overwrite') return false
  }

  return buffers.overwriteConflict(relPath)
}

export async function requestRevertFile(
  kernel: AppKernel,
  scope: ProjectScope,
  relPath: string,
): Promise<boolean> {
  const buffers = scope.tryGet(EditorBufferKey)
  const dialogs = kernel.tryGet(ConfirmDialogKey)
  const buf = buffers?.getBuffer(relPath)
  if (!buf || !buffers || !buf.dirty || isUntitledPath(relPath)) {
    return false
  }

  if (dialogs) {
    const choice = await dialogs.confirm({
      title: 'Revert Unsaved Changes',
      message: `Discard all unsaved edits in "${buf.relPath}" and reload from disk?`,
      actions: [
        { id: 'revert', label: 'Revert Changes', variant: 'danger' },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ],
      cancelId: 'cancel',
    })
    if (choice !== 'revert') return false
  }

  await buffers.reloadBuffer(relPath)
  return true
}

export async function requestCloseTab(
  kernel: AppKernel,
  scope: ProjectScope,
  relPath: string,
): Promise<boolean> {
  const selection = scope.get(ProjectSelectionKey)
  const buffers = scope.tryGet(EditorBufferKey)
  const dialogs = kernel.tryGet(ConfirmDialogKey)

  if (buffers?.isDirty(relPath)) {
    if (!dialogs) return false
    const choice = await dialogs.confirm({
      title: 'Unsaved Changes',
      message: `Do you want to save the changes you made to "${baseNameOf(relPath)}"?`,
      details: [relPath],
      actions: [
        { id: 'save', label: 'Save', variant: 'primary' },
        { id: 'discard', label: "Don't Save", variant: 'danger' },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ],
      cancelId: 'cancel',
    })

    if (choice === 'cancel') return false
    if (choice === 'save') {
      const ok = await requestSaveFile(kernel, scope, relPath)
      if (!ok) return false
    }
  }

  await selection.closeTab(relPath)
  buffers?.discardBuffer(relPath)
  return true
}

export async function requestCloseOtherTabs(
  kernel: AppKernel,
  scope: ProjectScope,
  keepRelPath: string,
): Promise<boolean> {
  const selection = scope.get(ProjectSelectionKey)
  const targets = selection
    .openTabs()
    .map((t) => t.relPath)
    .filter((p) => p !== keepRelPath)
  return confirmAndCloseTabs(kernel, scope, targets, keepRelPath)
}

export async function requestCloseAllTabs(
  kernel: AppKernel,
  scope: ProjectScope,
): Promise<boolean> {
  const selection = scope.get(ProjectSelectionKey)
  const targets = selection.openTabs().map((t) => t.relPath)
  return confirmAndCloseTabs(kernel, scope, targets)
}

export async function requestCloseProject(
  kernel: AppKernel,
  scope: ProjectScope,
): Promise<boolean> {
  const buffers = scope.tryGet(EditorBufferKey)
  const dialogs = kernel.tryGet(ConfirmDialogKey)
  const dirtyPaths = buffers ? [...buffers.dirtyPaths()] : []

  if (dirtyPaths.length > 0) {
    if (!dialogs) return false
    const choice = await dialogs.confirm({
      title: `Unsaved Changes in ${scope.name}`,
      message: `${dirtyPaths.length} unsaved file${dirtyPaths.length > 1 ? 's' : ''} will lose changes if you close this project.`,
      details: formatDetails(dirtyPaths),
      actions: [
        { id: 'save', label: 'Save All & Close', variant: 'primary' },
        { id: 'discard', label: 'Discard & Close', variant: 'danger' },
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
      ],
      cancelId: 'cancel',
    })

    if (choice === 'cancel') return false
    if (choice === 'save' && buffers) {
      // Untitled buffers need a user-chosen name; open the native save dialog
      // (or popover) for each and abort the close instead of dropping changes.
      for (;;) {
        const untitledDirty = [...buffers.dirtyPaths()].find((p) => isUntitledPath(p))
        if (!untitledDirty) break
        const saved = await requestUntitledSave(kernel, scope, untitledDirty)
        if (!saved) return false
      }
      const ok = await buffers.saveAllDirty()
      if (!ok) return false
    }
  }

  await kernel.closeProject(scope.id)
  return true
}

export async function requestCloseWindow(kernel: AppKernel): Promise<boolean> {
  const dialogs = kernel.tryGet(ConfirmDialogKey)
  const dirtyEntries: Array<{ scope: ProjectScope; label: string }> = []

  for (const scope of kernel.projects()) {
    const buffers = scope.tryGet(EditorBufferKey)
    if (!buffers) continue
    for (const relPath of buffers.dirtyPaths()) {
      dirtyEntries.push({ scope, label: `${scope.name}/${relPath}` })
    }
  }

  if (dirtyEntries.length === 0) return true
  if (!dialogs) return false

  const choice = await dialogs.confirm({
    title: 'Unsaved Changes Before Closing',
    message: `${dirtyEntries.length} unsaved file${dirtyEntries.length > 1 ? 's' : ''} across open projects. Save before exiting?`,
    details: formatDetails(dirtyEntries.map((d) => d.label)),
    actions: [
      { id: 'save', label: 'Save All & Exit', variant: 'primary' },
      { id: 'discard', label: 'Discard & Exit', variant: 'danger' },
      { id: 'cancel', label: 'Cancel', variant: 'secondary' },
    ],
    cancelId: 'cancel',
  })

  if (choice === 'cancel') return false
  if (choice === 'save') {
    for (const scope of kernel.projects()) {
      const buffers = scope.tryGet(EditorBufferKey)
      if (!buffers || !buffers.hasDirtyFiles()) continue
      for (;;) {
        const untitledDirty = [...buffers.dirtyPaths()].find((p) => isUntitledPath(p))
        if (!untitledDirty) break
        const saved = await requestUntitledSave(kernel, scope, untitledDirty)
        if (!saved) return false
      }
      const ok = await buffers.saveAllDirty()
      if (!ok) return false
    }
  }

  return true
}
