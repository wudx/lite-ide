import * as kernelApi from '@lite-ide/kernel'
import type { Plugin } from '@lite-ide/kernel'
import * as protocolApi from '@lite-ide/protocol'
import { definePlugin } from '@lite-ide/plugin-sdk'
import * as solid from 'solid-js'
import * as solidStore from 'solid-js/store'
import * as solidWeb from 'solid-js/web'
import { AiModelKey } from './ai-model'
import { copyTextToClipboard } from './clipboard'
import { ConfirmDialogKey, SettingsDialogKey } from './dialogs'
import { EditorBufferKey } from './editor-buffers'
import { FileIcon } from './components/FileIcon'
import { formatBytes } from './format'
import { getI18n, I18nStateKey } from './i18n'
import { isAudioExtension } from './media'
import { CodeNavigationKey } from './navigation'
import { joinNativePath } from './paths'
import { QuickOpenKey } from './quick-open'
import {
  LayoutStateKey,
  ProjectFsEventsKey,
  ProjectSelectionKey,
  ThemeStateKey,
  WorkspaceBackendKey,
} from './services'
import { SymbolIndexKey } from './symbol-index'

/**
 * Host plugin API version implemented by this LiteIDE build. Plugins whose
 * manifest demands a newer `api` are refused with a clear error instead of
 * failing somewhere inside their bundle.
 */
export const HOST_API_VERSION = 2

/**
 * Host API injected into every external plugin evaluation: reachable as the
 * `liteide` module from bundle plugins (require table) and as the
 * `globalThis.liteide` capture shim for classic scripts.
 */
export interface LiteideHostApi {
  readonly apiVersion: number
  /** Classic-script registration hook (bundle plugins export the Plugin). */
  plugin(definition: Plugin): void
  /** Evaluates a manifest-declared chunk; implemented by the registry. */
  loadChunk(name: string): Promise<Record<string, unknown>>
}

export type HostRequire = (specifier: string) => unknown

/**
 * Builds the require table handed to bundle plugins. Called per evaluation
 * (never at module init) so bindings from circularly-imported feature
 * modules — services.ts ↔ plugin-registry.ts — are already initialized.
 *
 * Shared singletons matter: `solid-js` / `solid-js/web` MUST resolve to the
 * host's own copies, otherwise plugin reactivity splits from the app.
 */
export function buildHostRequire(liteide: LiteideHostApi): HostRequire {
  const modules: Record<string, unknown> = {
    'solid-js': solid,
    'solid-js/store': solidStore,
    'solid-js/web': solidWeb,
    '@lite-ide/kernel': kernelApi,
    '@lite-ide/protocol': protocolApi,
    '@lite-ide/plugin-sdk': { definePlugin },
    liteide,
    '@lite-ide/workbench': {
      // Service keys (deferred reads — see note above).
      WorkspaceBackendKey,
      ProjectSelectionKey,
      ProjectFsEventsKey,
      LayoutStateKey,
      ThemeStateKey,
      I18nStateKey,
      EditorBufferKey,
      SymbolIndexKey,
      CodeNavigationKey,
      QuickOpenKey,
      AiModelKey,
      ConfirmDialogKey,
      SettingsDialogKey,
      // Helpers & shared components.
      getI18n,
      formatBytes,
      joinNativePath,
      copyTextToClipboard,
      isAudioExtension,
      FileIcon,
    },
  }
  return (specifier: string) => {
    const mod = modules[specifier]
    if (mod === undefined) {
      throw new Error(
        `external plugin requires module "${specifier}", which the host does not provide`,
      )
    }
    return mod
  }
}

/** Runs a CommonJS bundle and returns its module exports. */
export function evaluateCjsModule(
  source: string,
  hostRequire: HostRequire,
  liteideArg?: unknown,
): Record<string, unknown> {
  const moduleObj = { exports: {} as Record<string, unknown> }
  // CSP 未启用（tauri.conf.json csp: null），`new Function` 可用。
  // `__liteideHost` 参数让 bundle 也能走经典捕获约定注册；命名刻意避开
  // rollup cjs 输出常见的 `const liteide = require('liteide')` 局部变量。
  new Function('module', 'exports', 'require', '__liteideHost', source)(
    moduleObj,
    moduleObj.exports,
    hostRequire,
    liteideArg,
  )
  return moduleObj.exports
}

export interface NormalizedPlugin {
  name: string
  activate: Plugin['activate']
}

/**
 * Normalizes a bundle plugin's registration shape: `module.exports.activate`
 * and `module.exports.default.activate` are both accepted, falling back to
 * the definition captured through `liteide.plugin()` during evaluation.
 */
export function normalizePluginDefinition(
  pluginId: string,
  exports: Record<string, unknown>,
  captured: unknown,
): NormalizedPlugin {
  const mod = exports as { activate?: unknown; default?: unknown; name?: unknown }
  const direct = typeof mod.activate === 'function' ? exports : mod.default
  const def = (direct ?? captured) as { name?: unknown; activate?: unknown } | undefined
  if (def === null || typeof def !== 'object' || typeof def.activate !== 'function') {
    throw new Error(`Bundle plugin "${pluginId}" exports no activate() function`)
  }
  return {
    name: typeof def.name === 'string' && def.name.trim() ? def.name : pluginId,
    activate: def.activate as Plugin['activate'],
  }
}

/** Injects (idempotently) the plugin's stylesheet as a managed `<style>` tag. */
export function injectPluginStyles(pluginId: string, css: string): void {
  if (typeof document === 'undefined') return
  removePluginStyles(pluginId)
  const style = document.createElement('style')
  style.setAttribute('data-liteide-plugin', pluginId)
  style.textContent = css
  document.head.appendChild(style)
}

/** Removes the plugin's managed `<style>` tag (deactivate / uninstall). */
export function removePluginStyles(pluginId: string): void {
  if (typeof document === 'undefined') return
  // 不用属性选择器插值：插件 id 来自外部清单，逐个比对属性更稳。
  document.head
    .querySelectorAll('style[data-liteide-plugin]')
    .forEach((el) => {
      if (el.getAttribute('data-liteide-plugin') === pluginId) el.remove()
    })
}
