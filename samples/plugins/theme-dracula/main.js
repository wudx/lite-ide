// LiteIDE 外部插件入口：贡献 Dracula 配色主题。
// variables 以行内样式覆盖 app.css 的 :root 默认值，未列出的变量回退
// 到默认值；切换到其他主题时由 ThemeState 统一清除注入。
const DRACULA_VARIABLES = {
  'color-scheme': 'dark',

  /* Layered Dracula surfaces */
  '--bg-app': '#282a36',
  '--bg-titlebar': 'transparent',
  '--bg-sidebar': '#21222c',
  '--bg-editor': '#282a36',
  '--bg-editor-chrome': '#21222c',
  '--bg-surface': '#343746',
  '--bg-subtle': 'rgba(248, 248, 242, 0.05)',
  '--bg-inset': 'rgba(0, 0, 0, 0.28)',
  '--bg-inset-focus': 'rgba(0, 0, 0, 0.40)',
  '--bg-popover': '#21222c',
  '--bg-pill': '#343746',
  '--bg-backdrop': 'rgba(15, 16, 22, 0.56)',
  '--bg-dialog-footer': 'rgba(0, 0, 0, 0.24)',

  /* Interactive fills & borders (Purple accent) */
  '--bg-hover': 'rgba(248, 248, 242, 0.06)',
  '--bg-hover-strong': 'rgba(248, 248, 242, 0.10)',
  '--bg-active': 'rgba(189, 147, 249, 0.18)',
  '--bg-active-strong': 'rgba(189, 147, 249, 0.26)',
  '--border-subtle': 'rgba(248, 248, 242, 0.08)',
  '--border-panel': 'rgba(248, 248, 242, 0.10)',
  '--border-strong': 'rgba(248, 248, 242, 0.16)',
  '--divider': 'rgba(248, 248, 242, 0.16)',
  '--guide-line': 'rgba(248, 248, 242, 0.06)',
  '--ring-focus': 'rgba(189, 147, 249, 0.48)',

  /* Text & accent */
  '--text-primary': '#f8f8f2',
  '--text-secondary': '#c5c8df',
  '--text-muted': '#8a93b8',
  '--accent': '#bd93f9',
  '--accent-hover': '#caa6ff',
  '--accent-soft': 'rgba(189, 147, 249, 0.15)',
  '--accent-border': 'rgba(189, 147, 249, 0.34)',
  '--accent-foreground': '#1e1f29',
  '--accent-glow': 'rgba(189, 147, 249, 0.30)',
  '--welcome-glow': 'rgba(189, 147, 249, 0.09)',

  /* Elevation */
  '--shadow-panel': '0 8px 30px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(248, 248, 242, 0.04)',
  '--shadow-tab': '0 2px 10px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(248, 248, 242, 0.06)',
  '--shadow-tab-doc': 'inset 0 1px 0 rgba(248, 248, 242, 0.05)',
  '--shadow-popover':
    '0 18px 48px rgba(0, 0, 0, 0.50), 0 2px 8px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(248, 248, 242, 0.07)',
  '--shadow-pill': '0 6px 20px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(248, 248, 242, 0.07)',
  '--shadow-kbd': 'inset 0 -1px 0 rgba(0, 0, 0, 0.40)',
  '--shadow-image': '0 14px 44px rgba(0, 0, 0, 0.44)',

  /* Semantic status tones (Dracula Red / Yellow / Green) */
  '--danger-bg': 'rgba(255, 85, 85, 0.14)',
  '--danger-border': 'rgba(255, 85, 85, 0.32)',
  '--danger-text': '#ff9e9e',
  '--danger-icon': '#ff5555',
  '--danger-btn-bg': 'rgba(255, 85, 85, 0.24)',
  '--danger-btn-hover': 'rgba(255, 85, 85, 0.34)',
  '--warning-bg': 'rgba(241, 250, 140, 0.12)',
  '--warning-border': 'rgba(241, 250, 140, 0.28)',
  '--warning-text': '#f5fca8',
  '--warning-icon': '#f1fa8c',
  '--warning-btn-bg': 'rgba(241, 250, 140, 0.20)',
  '--warning-btn-hover': 'rgba(241, 250, 140, 0.30)',
  '--success-text': '#50fa7b',

  /* Diff preview tones */
  '--diff-add-bg': 'rgba(80, 250, 123, 0.12)',
  '--diff-add-text': '#50fa7b',
  '--diff-del-bg': 'rgba(255, 85, 85, 0.12)',
  '--diff-del-text': '#ff5555',
}

liteide.plugin({
  activate(ctx) {
    return ctx.contribute('theme', {
      id: 'dracula',
      label: 'Dracula',
      appearance: 'dark',
      variables: DRACULA_VARIABLES,
    })
  },
})
