import draculaManifest from '../../../samples/plugins/theme-dracula/plugin.json?raw'
import draculaMain from '../../../samples/plugins/theme-dracula/main.js?raw'
import bundleNotesManifest from '../../../samples/plugins/bundle-notes/plugin.json?raw'
import bundleNotesMain from '../../../samples/plugins/bundle-notes/dist/plugin.js?raw'
import bundleNotesCss from '../../../samples/plugins/bundle-notes/dist/plugin.css?raw'
import bundleNotesChunk from '../../../samples/plugins/bundle-notes/dist/log-view.js?raw'
import helloManifest from '../../../samples/plugins/hello-status/plugin.json?raw'
import helloMain from '../../../samples/plugins/hello-status/main.js?raw'
import type { CatalogPlugin, PluginManifest } from './types'

/**
 * A built-in sample plugin: manifest, its entry source and any extra text
 * assets (stylesheet / lazy chunks) declared by the manifest.
 */
export interface PluginSample {
  manifest: PluginManifest
  mainJs: string
  /** Bare filename → asset text, covering manifest css/chunks entries. */
  assets: Record<string, string>
}

/**
 * Built-in installable samples. Content lives in the repo-root
 * `samples/plugins/` folders so desktop users can also install them via
 * "install from folder"; the Rust backend embeds the very same files with
 * `include_str!` for its catalog. Keep the folder as the source of truth.
 */
export const BUILTIN_PLUGIN_SAMPLES: readonly PluginSample[] = [
  { manifest: JSON.parse(helloManifest), mainJs: helloMain, assets: {} },
  { manifest: JSON.parse(draculaManifest), mainJs: draculaMain, assets: {} },
  {
    manifest: JSON.parse(bundleNotesManifest),
    mainJs: bundleNotesMain,
    assets: {
      'plugin.css': bundleNotesCss,
      'log-view.js': bundleNotesChunk,
    },
  },
]

export function builtinPluginCatalog(): CatalogPlugin[] {
  return BUILTIN_PLUGIN_SAMPLES.map((sample) => ({ manifest: sample.manifest }))
}
