// Ambient `liteide` module declaration must be referenced before any statement.
/// <reference path="./liteide.d.ts" />
import type { Plugin } from '@lite-ide/kernel'

export type {
  AppKernel,
  ContributionMap,
  ContributionPoint,
  Disposable,
  KernelEvents,
  Plugin,
  PluginContext,
  PreviewProps,
  ProjectScope,
  ServiceKey,
} from '@lite-ide/kernel'

export { createServiceKey, DisposableStore } from '@lite-ide/kernel'

/** Identity helper giving external plugin authors full typing for their definition. */
export function definePlugin(plugin: Plugin): Plugin {
  return plugin
}
