export const TERMINAL_ZH_CN: Record<string, string> = {
  'terminal.panel.title': '终端',
  'terminal.tabTitle': '终端 {index}',
  'terminal.tabsAria': '终端页签',
  'terminal.newTab': '新建终端',
  'terminal.closeTab': '关闭终端',
  'terminal.hidePanel': '隐藏面板',
  'terminal.exitedBadge': '已退出',
  'terminal.command.toggle': '切换终端面板',
  'terminal.command.new': '新建终端',
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
  'terminal.tabTitle': 'Terminal {index}',
  'terminal.tabsAria': 'Terminal Tabs',
  'terminal.newTab': 'New Terminal',
  'terminal.closeTab': 'Close Terminal',
  'terminal.hidePanel': 'Hide Panel',
  'terminal.exitedBadge': 'Exited',
  'terminal.command.toggle': 'Toggle Terminal Panel',
  'terminal.command.new': 'New Terminal',
  'terminal.statusbar.toggle': 'Toggle Terminal (Ctrl+`)',
  'terminal.starting': 'Starting shell…',
  'terminal.restart': 'Restart',
  'terminal.restartHint': 'Process exited with code {code}',
  'terminal.unsupported':
    'This backend does not provide a terminal: the desktop (Tauri) build ships a real PTY shell, and the browser demo mode includes a fake shell.',
  'terminal.error': 'Failed to start terminal: {message}',
}
