import type { Plugin } from '@lite-ide/kernel'
import { definePlugin } from '@lite-ide/plugin-sdk'
import { getI18n } from '@lite-ide/workbench'
import StickyNote from 'lucide-solid/icons/sticky-note'
import type { Component } from 'solid-js'
import { loadChunk } from 'liteide'
import './plugin.css'
import { NotesView } from './NotesView'
import { createNotesState, NotesStateKey } from './notes-state'

const LOG_EXTS = new Set(['log'])

/**
 * Bundle-format sample plugin. Demonstrates every v2 capability:
 * sidebar.view with a Solid component, own per-scope service key, i18n,
 * CSS asset, and a previewer whose component lives in a lazily-evaluated
 * chunk (`chunks.logView` → log-view.js).
 */
export const bundleNotesPlugin: Plugin = {
  id: 'bundle-notes',
  name: 'Bundle Notes',
  activate(ctx) {
    const i18n = getI18n(ctx)
    ctx.contribute('i18n', {
      locale: 'zh-CN',
      messages: {
        'bundleNotes.view.title': '笔记',
        'bundleNotes.view.placeholder': '记录一条笔记…',
        'bundleNotes.view.add': '添加',
        'bundleNotes.view.empty': '暂无笔记',
        'bundleNotes.view.remove': '删除',
        'bundleNotes.log.label': '日志',
        'bundleNotes.log.failed': '读取日志失败：{message}',
      },
    })
    ctx.contribute('i18n', {
      locale: 'en-US',
      messages: {
        'bundleNotes.view.title': 'Notes',
        'bundleNotes.view.placeholder': 'Write a note…',
        'bundleNotes.view.add': 'Add',
        'bundleNotes.view.empty': 'No notes yet',
        'bundleNotes.view.remove': 'Remove',
        'bundleNotes.log.label': 'Log',
        'bundleNotes.log.failed': 'Failed to read log: {message}',
      },
    })

    // Per-scope service provisioning (same lifecycle contract as built-ins).
    ctx.onProjectOpen((scope) => {
      scope.provide(NotesStateKey, createNotesState(scope.id))
    })

    ctx.contribute('sidebar.view', {
      id: 'bundle-notes',
      title: 'Notes',
      titleKey: 'bundleNotes.view.title',
      order: 30,
      icon: StickyNote,
      component: NotesView,
    })

    // The previewer component lives in the log-view.js chunk; PreviewHost
    // invokes `load()` once per provider, so the chunk evaluates on demand.
    ctx.contribute('previewer.provider', {
      id: 'bundle-notes-log',
      label: 'Log',
      labelKey: 'bundleNotes.log.label',
      priority: 80,
      canHandle: (file) => !file.isBinary && LOG_EXTS.has(file.ext),
      load: async () => {
        const chunk = await loadChunk('logView')
        return { default: chunk.default as Component }
      },
    })
  },
}

export default definePlugin(bundleNotesPlugin)
