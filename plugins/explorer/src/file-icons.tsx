import {
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Settings,
} from 'lucide-solid'

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

export function FileIcon(props: FileIconProps) {
  if (props.isDir) {
    const colorClass = props.ignored ? 'text-slate-500' : 'text-sky-400'
    return props.expanded ? (
      <FolderOpen class={`w-3.5 h-3.5 shrink-0 ${colorClass}`} />
    ) : (
      <Folder class={`w-3.5 h-3.5 shrink-0 ${colorClass}`} />
    )
  }

  const ext = getExtension(props.name)
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) {
    return <FileCode2 class="w-3.5 h-3.5 shrink-0 text-blue-400" />
  }
  if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return <FileCode2 class="w-3.5 h-3.5 shrink-0 text-amber-400" />
  }
  if (['rs', 'go', 'py', 'c', 'cpp', 'h', 'java', 'rb', 'css', 'scss', 'html'].includes(ext)) {
    return <FileCode2 class="w-3.5 h-3.5 shrink-0 text-orange-400" />
  }
  if (['json', 'jsonc', 'json5'].includes(ext)) {
    return <FileJson class="w-3.5 h-3.5 shrink-0 text-yellow-300" />
  }
  if (['md', 'markdown', 'mdx', 'txt'].includes(ext)) {
    return <FileText class="w-3.5 h-3.5 shrink-0 text-emerald-400" />
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'].includes(ext)) {
    return <Image class="w-3.5 h-3.5 shrink-0 text-purple-400" />
  }
  if (['toml', 'yaml', 'yml', 'lock', 'ini', 'env'].includes(ext) || props.name.startsWith('.')) {
    return <Settings class="w-3.5 h-3.5 shrink-0 text-slate-400" />
  }

  return <File class="w-3.5 h-3.5 shrink-0 text-slate-400" />
}
