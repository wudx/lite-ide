import type { AppKernel, ProjectScope } from '@lite-ide/kernel'
import { ConfirmDialogKey } from './dialogs'
import {
  EditorBufferKey,
  isUntitledPath,
  untitledDisplayNameOf,
} from './editor-buffers'
import { getI18n, type TranslateFn } from './i18n'
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
export function parseSaveTarget(
  rawName: string,
  t: TranslateFn = getI18n().t,
): { dir: string; name: string } | string {
  const cleaned = rawName.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (!cleaned || cleaned === '/') {
    return t('saveAs.error.emptyName')
  }
  if (cleaned.startsWith('/')) {
    return t('saveAs.error.relativePath')
  }

  const idx = cleaned.lastIndexOf('/')
  const dir = idx === -1 ? '' : cleaned.slice(0, idx)
  const name = cleaned.slice(idx + 1)

  for (const seg of [...(dir ? dir.split('/') : []), name]) {
    if (!seg || seg === '.' || seg === '..') {
      return t('saveAs.error.invalidSegments')
    }
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) {
      return t('saveAs.error.invalidChars')
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
  const i18n = getI18n(kernel)
  const buffers = scope.tryGet(EditorBufferKey)
  if (!buffers || !isUntitledPath(untitledRelPath)) {
    return { ok: false, error: i18n.t('saveAs.error.notUntitled') }
  }
  if (!buffers.getBuffer(untitledRelPath)) {
    return { ok: false, error: i18n.t('saveAs.error.missingUntitled') }
  }

  const parsed = parseSaveTarget(rawName, i18n.t)
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
  const i18n = getI18n(kernel)
  const buffers = scope.tryGet(EditorBufferKey)
  const selection = scope.get(ProjectSelectionKey)
  if (!buffers || !isUntitledPath(untitledRelPath)) {
    return { ok: false, error: i18n.t('saveAs.error.notUntitled') }
  }
  if (!buffers.getBuffer(untitledRelPath)) {
    return { ok: false, error: i18n.t('saveAs.error.missingUntitled') }
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
    return { ok: false, error: saveError ?? i18n.t('saveAs.error.saveFailed') }
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
    const i18n = getI18n(kernel)
    const picked = await backend.pickSavePath(scope.id, untitledDisplayNameOf(untitledRelPath), {
      title: i18n.t('dialog.saveUntitledTitle'),
      outsideProjectMessage: i18n.t('dialog.saveOutsideProject'),
    })
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

function formatDetails(paths: string[], t: TranslateFn): string[] {
  if (paths.length <= MAX_DETAIL_ITEMS) return paths
  const head = paths.slice(0, MAX_DETAIL_ITEMS)
  head.push(t('confirm.andMore', { count: paths.length - MAX_DETAIL_ITEMS }))
  return head
}

async function confirmAndCloseTabs(
  kernel: AppKernel,
  scope: ProjectScope,
  targetPaths: string[],
  keepRelPath?: string,
): Promise<boolean> {
  if (targetPaths.length === 0) return true

  const i18n = getI18n(kernel)
  const selection = scope.get(ProjectSelectionKey)
  const buffers = scope.tryGet(EditorBufferKey)
  const dialogs = kernel.tryGet(ConfirmDialogKey)
  const dirtyTargets = buffers ? targetPaths.filter((p) => buffers.isDirty(p)) : []

  if (dirtyTargets.length > 0) {
    if (!dialogs) return false
    const single = dirtyTargets.length === 1
    const choice = await dialogs.confirm({
      title: i18n.t('confirm.unsavedTitle'),
      message: single
        ? i18n.t('confirm.closeTabs.messageOne', { name: baseNameOf(dirtyTargets[0]) })
        : i18n.t('confirm.closeTabs.messageMany', { count: dirtyTargets.length }),
      details: formatDetails(dirtyTargets, i18n.t),
      actions: [
        {
          id: 'save',
          label: single ? i18n.t('confirm.closeTabs.saveOne') : i18n.t('confirm.closeTabs.saveMany'),
          variant: 'primary',
        },
        {
          id: 'discard',
          label: single
            ? i18n.t('confirm.closeTabs.dontSave')
            : i18n.t('confirm.closeTabs.discardClose'),
          variant: 'danger',
        },
        { id: 'cancel', label: i18n.t('common.cancel'), variant: 'secondary' },
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
  const i18n = getI18n(kernel)
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
      title:
        buf.conflict === 'deleted'
          ? i18n.t('confirm.conflict.deletedTitle')
          : i18n.t('confirm.conflict.modifiedTitle'),
      message:
        buf.conflict === 'deleted'
          ? i18n.t('confirm.conflict.deletedMessage', { path: buf.relPath })
          : i18n.t('confirm.conflict.modifiedMessage', { path: buf.relPath }),
      actions: [
        {
          id: 'overwrite',
          label:
            buf.conflict === 'deleted'
              ? i18n.t('confirm.conflict.recreateSave')
              : i18n.t('confirm.conflict.overwriteDisk'),
          variant: 'primary',
        },
        { id: 'cancel', label: i18n.t('common.cancel'), variant: 'secondary' },
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
  const i18n = getI18n(kernel)
  const buffers = scope.tryGet(EditorBufferKey)
  const dialogs = kernel.tryGet(ConfirmDialogKey)
  const buf = buffers?.getBuffer(relPath)
  if (!buf || !buffers || !buf.dirty || isUntitledPath(relPath)) {
    return false
  }

  if (dialogs) {
    const choice = await dialogs.confirm({
      title: i18n.t('confirm.revert.title'),
      message: i18n.t('confirm.revert.message', { path: buf.relPath }),
      actions: [
        { id: 'revert', label: i18n.t('confirm.revert.action'), variant: 'danger' },
        { id: 'cancel', label: i18n.t('common.cancel'), variant: 'secondary' },
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
  const i18n = getI18n(kernel)
  const selection = scope.get(ProjectSelectionKey)
  const buffers = scope.tryGet(EditorBufferKey)
  const dialogs = kernel.tryGet(ConfirmDialogKey)

  if (buffers?.isDirty(relPath)) {
    if (!dialogs) return false
    const choice = await dialogs.confirm({
      title: i18n.t('confirm.unsavedTitle'),
      message: i18n.t('confirm.closeTab.message', { name: baseNameOf(relPath) }),
      details: [relPath],
      actions: [
        { id: 'save', label: i18n.t('confirm.closeTab.save'), variant: 'primary' },
        { id: 'discard', label: i18n.t('confirm.closeTab.dontSave'), variant: 'danger' },
        { id: 'cancel', label: i18n.t('common.cancel'), variant: 'secondary' },
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
  const i18n = getI18n(kernel)
  const buffers = scope.tryGet(EditorBufferKey)
  const dialogs = kernel.tryGet(ConfirmDialogKey)
  const dirtyPaths = buffers ? [...buffers.dirtyPaths()] : []

  if (dirtyPaths.length > 0) {
    if (!dialogs) return false
    const choice = await dialogs.confirm({
      title: i18n.t('confirm.closeProject.title', { name: scope.name }),
      message:
        dirtyPaths.length === 1
          ? i18n.t('confirm.closeProject.messageOne')
          : i18n.t('confirm.closeProject.messageMany', { count: dirtyPaths.length }),
      details: formatDetails(dirtyPaths, i18n.t),
      actions: [
        { id: 'save', label: i18n.t('confirm.closeProject.saveAll'), variant: 'primary' },
        { id: 'discard', label: i18n.t('confirm.closeProject.discardClose'), variant: 'danger' },
        { id: 'cancel', label: i18n.t('common.cancel'), variant: 'secondary' },
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
  const i18n = getI18n(kernel)
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
    title: i18n.t('confirm.closeWindow.title'),
    message:
      dirtyEntries.length === 1
        ? i18n.t('confirm.closeWindow.messageOne')
        : i18n.t('confirm.closeWindow.messageMany', { count: dirtyEntries.length }),
    details: formatDetails(
      dirtyEntries.map((d) => d.label),
      i18n.t,
    ),
    actions: [
      { id: 'save', label: i18n.t('confirm.closeWindow.saveAllExit'), variant: 'primary' },
      { id: 'discard', label: i18n.t('confirm.closeWindow.discardExit'), variant: 'danger' },
      { id: 'cancel', label: i18n.t('common.cancel'), variant: 'secondary' },
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
