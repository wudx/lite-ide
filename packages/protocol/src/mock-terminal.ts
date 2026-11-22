import type { TerminalEvent } from './types'

/**
 * Browser demo fake shell backing the mock backend's optional terminal
 * capability. Mirrors the desktop PTY contract (`TerminalEvent` with base64
 * data frames) so the terminal plugin runs unchanged in `pnpm dev` mode:
 * a small line-oriented shell over the mock virtual FS with echo, cwd
 * tracking and ANSI output — enough to demo and e2e-test the panel without a
 * real process.
 */

/** Structural subset of the mock repo the shell operates on. */
export interface MockShellFs {
  files: Record<string, { content: string }>
  dirs: Set<string>
}

export interface MockShellSession {
  handle: { sessionId: string; shellLabel: string }
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Kills the session and emits the exit event; idempotent. */
  kill(): void
}

const BACKSPACE = '\x7f'

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function shellOut(onEvent: (event: TerminalEvent) => void, text: string): void {
  onEvent({ type: 'data', base64: bytesToBase64(new TextEncoder().encode(text)) })
}

/** Resolves a shell path argument against the cwd; `..` stays inside the root. */
export function resolveShellPath(cwd: string, arg: string): string {
  const base = arg.startsWith('/') ? '' : cwd
  const parts = [...(base ? base.split('/') : []), ...arg.split('/')]
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

function listChildEntries(
  repo: MockShellFs,
  cwd: string,
): Array<{ name: string; isDir: boolean }> {
  const prefix = cwd ? `${cwd}/` : ''
  const entries = new Map<string, boolean>()
  for (const dir of repo.dirs) {
    if (!dir.startsWith(prefix)) continue
    const rest = dir.slice(prefix.length)
    if (!rest) continue
    entries.set(rest.split('/')[0], true)
  }
  for (const filePath of Object.keys(repo.files)) {
    if (!filePath.startsWith(prefix)) continue
    const rest = filePath.slice(prefix.length)
    const seg = rest.split('/')[0]
    if (!seg) continue
    if (!entries.has(seg)) {
      entries.set(seg, rest.includes('/'))
    }
  }
  return [...entries.entries()]
    .map(([name, isDir]) => ({ name, isDir }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

export function createMockShellSession(
  repo: MockShellFs,
  projectLabel: string,
  onEvent: (event: TerminalEvent) => void,
): MockShellSession {
  let cwd = ''
  let line = ''
  let exited = false

  const prompt = () => `${projectLabel}:${cwd ? `/${cwd}` : '/'}$ `

  function emit(text: string): void {
    if (exited) return
    shellOut(onEvent, text)
  }

  function runCommand(input: string): void {
    const trimmed = input.trim()
    const [command, ...args] = trimmed.split(/\s+/)
    switch (command) {
      case '':
        break
      case 'help':
        emit(
          [
            'Commands:',
            '  help            show this help',
            '  ls [path]       list directory entries',
            '  cd [path]       change directory',
            '  pwd             print working directory',
            '  cat <file>      print a file',
            '  echo <text...>  print text',
            '  clear           clear the screen',
            '  exit            close the shell',
            '',
          ].join('\r\n'),
        )
        break
      case 'pwd':
        emit(`/${cwd}\r\n`)
        break
      case 'ls': {
        const target = args.length > 0 ? resolveShellPath(cwd, args[0]) : cwd
        const dirExists =
          target === '' || repo.dirs.has(target) || Object.keys(repo.files).some((f) => f.startsWith(`${target}/`))
        if (!dirExists) {
          emit(`ls: no such directory: ${args[0]}\r\n`)
          break
        }
        const childEntries = listChildEntries(repo, target)
        if (childEntries.length === 0) {
          emit('\r\n')
          break
        }
        emit(
          childEntries
            .map((e) => (e.isDir ? `${e.name}/` : e.name))
            .join('  ') + '\r\n',
        )
        break
      }
      case 'cd': {
        const target = args.length > 0 ? resolveShellPath(cwd, args[0]) : ''
        const dirExists =
          target === '' || repo.dirs.has(target) || Object.keys(repo.files).some((f) => f.startsWith(`${target}/`))
        if (!dirExists) {
          emit(`cd: no such directory: ${args[0]}\r\n`)
          break
        }
        cwd = target
        break
      }
      case 'cat': {
        if (args.length === 0) {
          emit('cat: missing file operand\r\n')
          break
        }
        const target = resolveShellPath(cwd, args[0])
        const file = repo.files[target]
        if (!file) {
          emit(`cat: no such file: ${args[0]}\r\n`)
          break
        }
        emit(`${file.content.replace(/\n/g, '\r\n').replace(/\r\n$/, '')}\r\n`)
        break
      }
      case 'echo':
        emit(`${args.join(' ')}\r\n`)
        break
      case 'clear':
        emit('\x1b[2J\x1b[H')
        break
      case 'exit':
        exited = true
        onEvent({ type: 'exit', code: 0 })
        return
      default:
        emit(`${command}: command not found\r\n`)
        break
    }
    emit(prompt())
  }

  // Banner + first prompt.
  emit('LiteIDE demo shell (browser mock mode).\r\n')
  emit("Type 'help' for available commands.\r\n\r\n")
  emit(prompt())

  return {
    handle: { sessionId: '', shellLabel: 'LiteIDE Shell' },

    write(data: string): void {
      if (exited) return
      for (const ch of data) {
        if (ch === '\r') {
          emit('\r\n')
          const input = line
          line = ''
          runCommand(input)
          if (exited) return
          continue
        }
        if (ch === BACKSPACE) {
          if (line.length > 0) {
            line = line.slice(0, -1)
            emit('\b \b')
          }
          continue
        }
        if (ch === '\n' || (ch < ' ' && ch !== '\t')) {
          // Ignore line feeds and stray control characters.
          continue
        }
        line += ch
        emit(ch)
      }
    },

    resize(): void {
      // The fake shell has no size-dependent rendering.
    },

    kill(): void {
      if (exited) return
      exited = true
      onEvent({ type: 'exit', code: 0 })
    },
  }
}
