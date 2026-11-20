import type { Plugin } from '@lite-ide/kernel'

/**
 * Nord 深色主题（官方色板：Polar Night / Snow Storm / Frost / Aurora）。
 *
 * 通过 `theme` 贡献点注册：激活时变量以行内样式覆盖 app.css 的 `:root`
 * 默认值，因此需要携带完整的关键表面与前景色集合（含 color-scheme）；
 * 切走到其他主题时由 ThemeState 统一清除注入的变量。
 */
const NORD_VARIABLES: Record<string, string> = {
  'color-scheme': 'dark',

  /* Layered Polar Night surfaces */
  '--bg-app': '#2e3440',
  '--bg-titlebar': 'transparent',
  '--bg-sidebar': '#2b303b',
  '--bg-editor': '#313744',
  '--bg-editor-chrome': '#2a2f3a',
  '--bg-surface': '#3b4252',
  '--bg-subtle': 'rgba(216, 222, 233, 0.05)',
  '--bg-inset': 'rgba(0, 0, 0, 0.26)',
  '--bg-inset-focus': 'rgba(0, 0, 0, 0.38)',
  '--bg-popover': '#2b303b',
  '--bg-pill': '#3b4252',
  '--bg-backdrop': 'rgba(20, 24, 31, 0.55)',
  '--bg-dialog-footer': 'rgba(0, 0, 0, 0.22)',

  /* Interactive fills & borders */
  '--bg-hover': 'rgba(216, 222, 233, 0.06)',
  '--bg-hover-strong': 'rgba(216, 222, 233, 0.10)',
  '--bg-active': 'rgba(136, 192, 208, 0.16)',
  '--bg-active-strong': 'rgba(136, 192, 208, 0.24)',
  '--border-subtle': 'rgba(216, 222, 233, 0.08)',
  '--border-panel': 'rgba(216, 222, 233, 0.10)',
  '--border-strong': 'rgba(216, 222, 233, 0.16)',
  '--divider': 'rgba(216, 222, 233, 0.16)',
  '--guide-line': 'rgba(216, 222, 233, 0.06)',
  '--ring-focus': 'rgba(136, 192, 208, 0.45)',

  /* Text & accent (Frost) */
  '--text-primary': '#eceff4',
  '--text-secondary': '#b8c2d4',
  '--text-muted': '#7b88a1',
  '--accent': '#88c0d0',
  '--accent-hover': '#93ccdb',
  '--accent-soft': 'rgba(136, 192, 208, 0.14)',
  '--accent-border': 'rgba(136, 192, 208, 0.32)',
  '--accent-foreground': '#22262e',
  '--accent-glow': 'rgba(136, 192, 208, 0.30)',
  '--welcome-glow': 'rgba(136, 192, 208, 0.09)',

  /* Elevation */
  '--shadow-panel': '0 8px 30px rgba(0, 0, 0, 0.30), inset 0 1px 0 rgba(236, 239, 244, 0.04)',
  '--shadow-tab': '0 2px 10px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(236, 239, 244, 0.06)',
  '--shadow-tab-doc': 'inset 0 1px 0 rgba(236, 239, 244, 0.05)',
  '--shadow-popover':
    '0 18px 48px rgba(0, 0, 0, 0.48), 0 2px 8px rgba(0, 0, 0, 0.26), inset 0 1px 0 rgba(236, 239, 244, 0.07)',
  '--shadow-pill': '0 6px 20px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(236, 239, 244, 0.07)',
  '--shadow-kbd': 'inset 0 -1px 0 rgba(0, 0, 0, 0.38)',
  '--shadow-image': '0 14px 44px rgba(0, 0, 0, 0.42)',

  /* Semantic status tones (Aurora) */
  '--danger-bg': 'rgba(191, 97, 106, 0.14)',
  '--danger-border': 'rgba(191, 97, 106, 0.32)',
  '--danger-text': '#e5b0b5',
  '--danger-icon': '#bf616a',
  '--danger-btn-bg': 'rgba(191, 97, 106, 0.24)',
  '--danger-btn-hover': 'rgba(191, 97, 106, 0.34)',
  '--warning-bg': 'rgba(235, 203, 139, 0.12)',
  '--warning-border': 'rgba(235, 203, 139, 0.28)',
  '--warning-text': '#f0d9a0',
  '--warning-icon': '#ebcb8b',
  '--warning-btn-bg': 'rgba(235, 203, 139, 0.20)',
  '--warning-btn-hover': 'rgba(235, 203, 139, 0.30)',
  '--success-text': '#a3be8c',

  /* File icon palette */
  '--icon-folder': 'rgba(136, 192, 208, 0.90)',
  '--icon-folder-ignored': '#616981',
  '--icon-default': '#97a3b8',
  '--icon-ts': '#81a1c1',
  '--icon-js': '#ebcb8b',
  '--icon-style': '#88c0d0',
  '--icon-web': '#d08770',
  '--icon-shell': '#a3be8c',
  '--icon-code': '#d08770',
  '--icon-json': '#ebcb8b',
  '--icon-doc': '#a3be8c',
  '--icon-image': '#b48ead',
  '--icon-audio': '#88c0d0',
  '--icon-config': '#8a94a8',
}

export const themeNordPlugin: Plugin = {
  id: 'builtin.theme-nord',
  name: 'Nord Theme',
  activate(ctx) {
    ctx.contribute('i18n', {
      locale: 'zh-CN',
      messages: { 'theme.nord-dark': 'Nord 深色' },
    })
    ctx.contribute('i18n', {
      locale: 'en-US',
      messages: { 'theme.nord-dark': 'Nord Dark' },
    })
    ctx.contribute('theme', {
      id: 'nord-dark',
      label: 'Nord 深色',
      labelKey: 'theme.nord-dark',
      appearance: 'dark',
      variables: NORD_VARIABLES,
    })
  },
}
