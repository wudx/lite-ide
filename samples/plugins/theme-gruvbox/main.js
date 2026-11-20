// LiteIDE 外部插件入口：贡献 Gruvbox Dark 配色主题。
// variables 以行内样式覆盖 app.css 的 :root 默认值，未列出的变量回退
// 到默认值；切换到其他主题时由 ThemeState 统一清除注入。
const GRUVBOX_VARIABLES = {
  'color-scheme': 'dark',

  /* Layered surfaces (bg0–bg2) */
  '--bg-app': '#282828',
  '--bg-titlebar': 'transparent',
  '--bg-sidebar': '#282828',
  '--bg-editor': '#32302f',
  '--bg-editor-chrome': '#2c2a29',
  '--bg-surface': '#3c3836',
  '--bg-subtle': 'rgba(235, 219, 178, 0.05)',
  '--bg-inset': 'rgba(0, 0, 0, 0.28)',
  '--bg-inset-focus': 'rgba(0, 0, 0, 0.40)',
  '--bg-popover': '#32302f',
  '--bg-pill': '#3c3836',
  '--bg-backdrop': 'rgba(20, 18, 15, 0.55)',
  '--bg-dialog-footer': 'rgba(0, 0, 0, 0.24)',

  /* Interactive fills & borders */
  '--bg-hover': 'rgba(235, 219, 178, 0.06)',
  '--bg-hover-strong': 'rgba(235, 219, 178, 0.10)',
  '--bg-active': 'rgba(142, 192, 124, 0.16)',
  '--bg-active-strong': 'rgba(142, 192, 124, 0.24)',
  '--border-subtle': 'rgba(235, 219, 178, 0.08)',
  '--border-panel': 'rgba(235, 219, 178, 0.10)',
  '--border-strong': 'rgba(235, 219, 178, 0.16)',
  '--divider': 'rgba(235, 219, 178, 0.16)',
  '--guide-line': 'rgba(235, 219, 178, 0.06)',
  '--ring-focus': 'rgba(142, 192, 124, 0.45)',

  /* Text & accent (fg / aqua) */
  '--text-primary': '#ebdbb2',
  '--text-secondary': '#d5c4a1',
  '--text-muted': '#a89984',
  '--accent': '#8ec07c',
  '--accent-hover': '#9ccb8a',
  '--accent-soft': 'rgba(142, 192, 124, 0.14)',
  '--accent-border': 'rgba(142, 192, 124, 0.32)',
  '--accent-foreground': '#282828',
  '--accent-glow': 'rgba(142, 192, 124, 0.30)',
  '--welcome-glow': 'rgba(142, 192, 124, 0.09)',

  /* Elevation */
  '--shadow-panel': '0 8px 30px rgba(0, 0, 0, 0.30), inset 0 1px 0 rgba(235, 219, 178, 0.04)',
  '--shadow-tab': '0 2px 10px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(235, 219, 178, 0.06)',
  '--shadow-tab-doc': 'inset 0 1px 0 rgba(235, 219, 178, 0.05)',
  '--shadow-popover':
    '0 18px 48px rgba(0, 0, 0, 0.48), 0 2px 8px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(235, 219, 178, 0.07)',
  '--shadow-pill': '0 6px 20px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(235, 219, 178, 0.07)',
  '--shadow-kbd': 'inset 0 -1px 0 rgba(0, 0, 0, 0.38)',
  '--shadow-image': '0 14px 44px rgba(0, 0, 0, 0.42)',

  /* Semantic status tones (red / yellow / green) */
  '--danger-bg': 'rgba(251, 73, 52, 0.14)',
  '--danger-border': 'rgba(251, 73, 52, 0.32)',
  '--danger-text': '#f0a79e',
  '--danger-icon': '#fb4934',
  '--danger-btn-bg': 'rgba(251, 73, 52, 0.24)',
  '--danger-btn-hover': 'rgba(251, 73, 52, 0.34)',
  '--warning-bg': 'rgba(250, 189, 47, 0.12)',
  '--warning-border': 'rgba(250, 189, 47, 0.28)',
  '--warning-text': '#f5d491',
  '--warning-icon': '#fabd2f',
  '--warning-btn-bg': 'rgba(250, 189, 47, 0.20)',
  '--warning-btn-hover': 'rgba(250, 189, 47, 0.30)',
  '--success-text': '#b8bb26',

  /* Diff preview tones (green / red) */
  '--diff-add-bg': 'rgba(184, 187, 38, 0.12)',
  '--diff-add-text': '#b8bb26',
  '--diff-del-bg': 'rgba(251, 73, 52, 0.12)',
  '--diff-del-text': '#fb4934',
}

liteide.plugin({
  activate(ctx) {
    return ctx.contribute('theme', {
      id: 'gruvbox-dark',
      label: 'Gruvbox Dark',
      appearance: 'dark',
      variables: GRUVBOX_VARIABLES,
    })
  },
})
