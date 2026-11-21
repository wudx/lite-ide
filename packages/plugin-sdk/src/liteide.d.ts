/**
 * Host API injected into every external plugin evaluation. Classic-script
 * plugins call `plugin()` during evaluation; bundle plugins import this
 * module wherever they need host services (currently `loadChunk`).
 *
 * NOTE: no top-level imports — this file must stay a script so the
 * `declare module` block is a true ambient declaration.
 */
declare module 'liteide' {
  import type { Plugin } from '@lite-ide/kernel'
  /** Host plugin API version implemented by the running LiteIDE. */
  export const apiVersion: number
  /** Classic-script registration hook; bundle plugins export the Plugin instead. */
  export function plugin(definition: Plugin): void
  /**
   * Evaluates a chunk declared in the manifest's `chunks` map and resolves to
   * its CommonJS module exports. Results are cached per plugin + chunk name.
   */
  export function loadChunk(name: string): Promise<Record<string, unknown>>
}
