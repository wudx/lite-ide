import gruvboxManifest from '../../../samples/plugins/theme-gruvbox/plugin.json?raw'
import gruvboxMain from '../../../samples/plugins/theme-gruvbox/main.js?raw'
import helloManifest from '../../../samples/plugins/hello-status/plugin.json?raw'
import helloMain from '../../../samples/plugins/hello-status/main.js?raw'
import type { CatalogPlugin, PluginManifest } from './types'

/** A built-in sample plugin: manifest plus its classic entry script source. */
export interface PluginSample {
  manifest: PluginManifest
  mainJs: string
}

/**
 * Built-in installable samples. Content lives in the repo-root
 * `samples/plugins/` folders so desktop users can also install them via
 * "install from folder"; the Rust backend embeds the very same files with
 * `include_str!` for its catalog. Keep the folder as the source of truth.
 */
export const BUILTIN_PLUGIN_SAMPLES: readonly PluginSample[] = [
  { manifest: JSON.parse(helloManifest), mainJs: helloMain },
  { manifest: JSON.parse(gruvboxManifest), mainJs: gruvboxMain },
]

export function builtinPluginCatalog(): CatalogPlugin[] {
  return BUILTIN_PLUGIN_SAMPLES.map((sample) => ({ manifest: sample.manifest }))
}
