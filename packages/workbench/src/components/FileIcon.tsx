import File from 'lucide-solid/icons/file'
import FileJson from 'lucide-solid/icons/file-braces'
import FileCode2 from 'lucide-solid/icons/file-code-corner'
import FileText from 'lucide-solid/icons/file-text'
import Folder from 'lucide-solid/icons/folder'
import FolderOpen from 'lucide-solid/icons/folder-open'
import Image from 'lucide-solid/icons/image'
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
const CODE_EXTS = new Set(['rs', 'go', 'py', 'c', 'cpp', 'h', 'java', 'rb', 'css', 'scss', 'html'])
const JSON_EXTS = new Set(['json', 'jsonc', 'json5'])
const DOC_EXTS = new Set(['md', 'markdown', 'mdx', 'txt'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'])
const CONFIG_EXTS = new Set(['toml', 'yaml', 'yml', 'lock', 'ini', 'env'])

export function FileIcon(props: FileIconProps) {
  const ext = createMemo(() => getExtension(props.name))
  const dirColorClass = () => (props.ignored ? 'text-slate-500' : 'text-sky-400')

  return (
    <Show
      when={props.isDir}
      fallback={
        <Switch fallback={<File class="w-3.5 h-3.5 shrink-0 text-slate-400" />}>
          <Match when={TS_EXTS.has(ext())}>
            <FileCode2 class="w-3.5 h-3.5 shrink-0 text-blue-400" />
          </Match>
          <Match when={JS_EXTS.has(ext())}>
            <FileCode2 class="w-3.5 h-3.5 shrink-0 text-amber-400" />
          </Match>
          <Match when={CODE_EXTS.has(ext())}>
            <FileCode2 class="w-3.5 h-3.5 shrink-0 text-orange-400" />
          </Match>
          <Match when={JSON_EXTS.has(ext())}>
            <FileJson class="w-3.5 h-3.5 shrink-0 text-yellow-300" />
          </Match>
          <Match when={DOC_EXTS.has(ext())}>
            <FileText class="w-3.5 h-3.5 shrink-0 text-emerald-400" />
          </Match>
          <Match when={IMAGE_EXTS.has(ext())}>
            <Image class="w-3.5 h-3.5 shrink-0 text-purple-400" />
          </Match>
          <Match when={CONFIG_EXTS.has(ext()) || props.name.startsWith('.')}>
            <Settings class="w-3.5 h-3.5 shrink-0 text-slate-400" />
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
