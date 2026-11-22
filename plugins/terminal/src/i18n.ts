export const TERMINAL_ZH_CN: Record<string, string> = {
  'terminal.panel.title': '终端',
  'terminal.command.toggle': '切换终端面板',
  'terminal.statusbar.toggle': '切换终端 (Ctrl+`)',
  'terminal.starting': '正在启动 shell…',
  'terminal.restart': '重新启动',
  'terminal.restartHint': '进程已退出，退出码 {code}',
  'terminal.unsupported':
    '当前后端不提供终端能力：桌面端（Tauri）提供真实 PTY shell，浏览器演示模式内置伪 shell。',
  'terminal.error': '终端启动失败：{message}',
}

export const TERMINAL_EN_US: Record<string, string> = {
  'terminal.panel.title': 'Terminal',
  'terminal.command.toggle': 'Toggle Terminal Panel',
  'terminal.statusbar.toggle': 'Toggle Terminal (Ctrl+`)',
  'terminal.starting': 'Starting shell…',
  'terminal.restart': 'Restart',
  'terminal.restartHint': 'Process exited with code {code}',
  'terminal.unsupported':
    'This backend does not provide a terminal: the desktop (Tauri) build ships a real PTY shell, and the browser demo mode includes a fake shell.',
  'terminal.error': 'Failed to start terminal: {message}',
}
