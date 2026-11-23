/** Joins a native project root path ("\"-separated on Windows) with a "/"-separated
 *  relPath, producing a native-style absolute path for clipboard use. */
export function joinNativePath(rootPath: string, relPath: string): string {
  const sep = rootPath.includes('\\') ? '\\' : '/'
  const normalizedRel = relPath.replace(/\//g, sep)
  const endsWithSep = rootPath.endsWith('/') || rootPath.endsWith('\\')
  return endsWithSep ? `${rootPath}${normalizedRel}` : `${rootPath}${sep}${normalizedRel}`
}

export function baseNameOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

export function parentDirOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

/**
 * Compile a glob pattern (`** /`, `**`, `*`, `?`) into a full-string RegExp.
 */
export function globToRegExp(pattern: string, flags = ''): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`, flags)
}
