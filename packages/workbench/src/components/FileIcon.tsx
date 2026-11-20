import File from 'lucide-solid/icons/file'
import FileJson from 'lucide-solid/icons/file-braces'
import FileCode2 from 'lucide-solid/icons/file-code-corner'
import FileTerminal from 'lucide-solid/icons/file-terminal'
import FileText from 'lucide-solid/icons/file-text'
import Folder from 'lucide-solid/icons/folder'
import FolderOpen from 'lucide-solid/icons/folder-open'
import Globe from 'lucide-solid/icons/globe'
import Image from 'lucide-solid/icons/image'
import Palette from 'lucide-solid/icons/palette'
import Settings from 'lucide-solid/icons/settings'
import { createMemo, Match, Show, Switch } from 'solid-js'

export interface FileIconProps {
  name: string
  isDir: boolean
  expanded?: boolean
  ignored?: boolean
}

function getExtension(name: string): string {
  const lower = name.toLowerCase()
  const idx = lower.lastIndexOf('.')
  return idx > 0 ? lower.slice(idx + 1) : ''
}

const TS_EXTS = new Set(['ts', 'tsx', 'mts', 'cts'])
const JS_EXTS = new Set(['js', 'jsx', 'mjs', 'cjs'])
const STYLE_EXTS = new Set(['css', 'scss', 'sass', 'less'])
const WEB_EXTS = new Set(['html', 'htm', 'xml', 'vue', 'svelte'])
const SHELL_EXTS = new Set(['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'])
const CODE_EXTS = new Set(['rs', 'go', 'py', 'c', 'cpp', 'h', 'hpp', 'java', 'rb'])
const JSON_EXTS = new Set(['json', 'jsonc', 'json5'])
const DOC_EXTS = new Set(['md', 'markdown', 'mdx', 'txt'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'])
const CONFIG_EXTS = new Set(['toml', 'yaml', 'yml', 'lock', 'ini', 'env'])

export function FileIcon(props: FileIconProps) {
  const ext = createMemo(() => getExtension(props.name))
  const dirColorClass = () => (props.ignored ? 'text-[#5b6273]' : 'text-[#7aa2ff]/90')

  return (
    <Show
      when={props.isDir}
      fallback={
        <Switch fallback={<File class="w-3.5 h-3.5 shrink-0 text-[#7d8597]" />}>
          <Match when={TS_EXTS.has(ext())}>
            <FileCode2 class="w-3.5 h-3.5 shrink-0 text-[#689dff]" />
          </Match>
          <Match when={JS_EXTS.has(ext())}>
            <FileCode2 class="w-3.5 h-3.5 shrink-0 text-[#e8b86d]" />
          </Match>
          <Match when={STYLE_EXTS.has(ext())}>
            <Palette class="w-3.5 h-3.5 shrink-0 text-[#7dd3fc]" />
          </Match>
          <Match when={WEB_EXTS.has(ext())}>
            <Globe class="w-3.5 h-3.5 shrink-0 text-[#f29e74]" />
          </Match>
          <Match when={SHELL_EXTS.has(ext())}>
            <FileTerminal class="w-3.5 h-3.5 shrink-0 text-[#86efac]" />
          </Match>
          <Match when={CODE_EXTS.has(ext())}>
            <FileCode2 class="w-3.5 h-3.5 shrink-0 text-[#f09b78]" />
          </Match>
          <Match when={JSON_EXTS.has(ext())}>
            <FileJson class="w-3.5 h-3.5 shrink-0 text-[#e9cb74]" />
          </Match>
          <Match when={DOC_EXTS.has(ext())}>
            <FileText class="w-3.5 h-3.5 shrink-0 text-[#78d9a6]" />
          </Match>
          <Match when={IMAGE_EXTS.has(ext())}>
            <Image class="w-3.5 h-3.5 shrink-0 text-[#c49bff]" />
          </Match>
          <Match when={CONFIG_EXTS.has(ext()) || props.name.startsWith('.')}>
            <Settings class="w-3.5 h-3.5 shrink-0 text-[#8a93a6]" />
          </Match>
        </Switch>
      }
    >
      <Show
        when={props.expanded}
        fallback={<Folder class={`w-3.5 h-3.5 shrink-0 ${dirColorClass()}`} />}
      >
        <FolderOpen class={`w-3.5 h-3.5 shrink-0 ${dirColorClass()}`} />
      </Show>
    </Show>
  )
}
