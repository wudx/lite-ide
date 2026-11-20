import type { AppKernel, ProjectScope } from '@lite-ide/kernel'
import { ConfirmDialogKey } from './dialogs'
import { EditorBufferKey } from './editor-buffers'
import { ProjectSelectionKey } from './services'

const MAX_DETAIL_ITEMS = 5

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
        const ok = await buffers.saveBuffer(path)
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
  if (!buf || !buffers || !buf.dirty) {
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
      const ok = await buffers.saveBuffer(relPath)
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
      const ok = await buffers.saveAllDirty()
      if (!ok) return false
    }
  }

  return true
}
