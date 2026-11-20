/** Joins a native project root path ("\"-separated on Windows) with a "/"-separated
 *  relPath, producing a native-style absolute path for clipboard use. */
export function joinNativePath(rootPath: string, relPath: string): string {
  const sep = rootPath.includes('\\') ? '\\' : '/'
  const normalizedRel = relPath.replace(/\//g, sep)
  const endsWithSep = rootPath.endsWith('/') || rootPath.endsWith('\\')
  return endsWithSep ? `${rootPath}${normalizedRel}` : `${rootPath}${sep}${normalizedRel}`
}
