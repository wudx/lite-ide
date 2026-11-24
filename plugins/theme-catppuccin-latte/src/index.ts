import type { Plugin } from '@lite-ide/kernel'

/**
 * Catppuccin Latte 浅色主题（官方色板：Crust / Mantle / Base + Mauve 紫色主强调）。
 *
 * 通过 `theme` 贡献点注册：激活时变量以行内样式覆盖 app.css 的 `:root`
 * 默认值，因此需要携带完整的关键表面与前景色集合（含 color-scheme 与文件图标色板）；
 * 切走到其他主题时由 ThemeState 统一清除注入的变量。
 */
const CATPPUCCIN_LATTE_VARIABLES: Record<string, string> = {
  'color-scheme': 'light',

  /* Layered Catppuccin Latte surfaces (Crust / Mantle / Base) */
  '--bg-app': '#dce0e8',
  '--bg-titlebar': 'transparent',
  '--bg-sidebar': '#e6e9ef',
  '--bg-editor': '#eff1f5',
  '--bg-editor-chrome': '#e6e9ef',
  '--bg-surface': '#eff1f5',
  '--bg-subtle': 'rgba(76, 79, 105, 0.055)',
  '--bg-inset': 'rgba(76, 79, 105, 0.075)',
  '--bg-inset-focus': '#f7f8fb',
  '--bg-popover': '#eff1f5',
  '--bg-pill': '#f7f8fb',
  '--bg-backdrop': 'rgba(76, 79, 105, 0.28)',
  '--bg-dialog-footer': 'rgba(76, 79, 105, 0.045)',

  /* Interactive fills & borders (Mauve accent) */
  '--bg-hover': 'rgba(76, 79, 105, 0.065)',
  '--bg-hover-strong': 'rgba(76, 79, 105, 0.11)',
  '--bg-active': 'rgba(136, 57, 239, 0.12)',
  '--bg-active-strong': 'rgba(136, 57, 239, 0.20)',
  '--border-subtle': 'rgba(76, 79, 105, 0.10)',
  '--border-panel': 'rgba(76, 79, 105, 0.13)',
  '--border-strong': 'rgba(76, 79, 105, 0.20)',
  '--divider': 'rgba(76, 79, 105, 0.18)',
  '--guide-line': 'rgba(76, 79, 105, 0.12)',
  '--ring-focus': 'rgba(136, 57, 239, 0.45)',

  /* Text & accent (Text / Subtext / Mauve) */
  '--text-primary': '#4c4f69',
  '--text-secondary': '#5c5f77',
  '--text-muted': '#6c6f85',
  '--accent': '#8839ef',
  '--accent-hover': '#782ae0',
  '--accent-soft': 'rgba(136, 57, 239, 0.11)',
  '--accent-border': 'rgba(136, 57, 239, 0.30)',
  '--accent-foreground': '#ffffff',
  '--accent-glow': 'rgba(136, 57, 239, 0.26)',
  '--welcome-glow': 'rgba(136, 57, 239, 0.09)',

  /* Airy elevation */
  '--shadow-panel': '0 2px 12px rgba(76, 79, 105, 0.075), 0 1px 2px rgba(76, 79, 105, 0.05)',
  '--shadow-tab': '0 1px 4px rgba(76, 79, 105, 0.09), 0 0.5px 1px rgba(76, 79, 105, 0.05)',
  '--shadow-tab-doc': '0 -1px 3px rgba(76, 79, 105, 0.04)',
  '--shadow-popover': '0 12px 36px rgba(76, 79, 105, 0.16), 0 2px 8px rgba(76, 79, 105, 0.08)',
  '--shadow-pill': '0 4px 16px rgba(76, 79, 105, 0.12), 0 1px 3px rgba(76, 79, 105, 0.07)',
  '--shadow-kbd': 'inset 0 -1px 0 rgba(76, 79, 105, 0.14)',
  '--shadow-image': '0 10px 32px rgba(76, 79, 105, 0.15), 0 2px 8px rgba(76, 79, 105, 0.07)',

  /* Semantic status tones (Red / Yellow / Green, darkened for AA text legibility) */
  '--danger-bg': 'rgba(210, 15, 57, 0.09)',
  '--danger-border': 'rgba(210, 15, 57, 0.24)',
  '--danger-text': '#b00c30',
  '--danger-icon': '#d20f39',
  '--danger-btn-bg': 'rgba(210, 15, 57, 0.13)',
  '--danger-btn-hover': 'rgba(210, 15, 57, 0.21)',
  '--warning-bg': 'rgba(223, 142, 29, 0.11)',
  '--warning-border': 'rgba(223, 142, 29, 0.28)',
  '--warning-text': '#9a5d07',
  '--warning-icon': '#df8e1d',
  '--warning-btn-bg': 'rgba(223, 142, 29, 0.16)',
  '--warning-btn-hover': 'rgba(223, 142, 29, 0.24)',
  '--success-text': '#2f7d1f',

  /* Diff preview tones (Green / Red) */
  '--diff-add-bg': 'rgba(64, 160, 43, 0.11)',
  '--diff-add-text': '#2f7d1f',
  '--diff-del-bg': 'rgba(210, 15, 57, 0.09)',
  '--diff-del-text': '#b00c30',

  /* File icon palette */
  '--icon-folder': '#8839ef',
  '--icon-folder-ignored': '#8c8fa1',
  '--icon-default': '#6c6f85',
  '--icon-ts': '#1e66f5',
  '--icon-js': '#df8e1d',
  '--icon-style': '#04a5e5',
  '--icon-web': '#fe640b',
  '--icon-shell': '#40a02b',
  '--icon-code': '#fe640b',
  '--icon-json': '#df8e1d',
  '--icon-doc': '#179299',
  '--icon-image': '#ea76cb',
  '--icon-audio': '#dd7878',
  '--icon-config': '#7287fd',
}

export const themeCatppuccinLattePlugin: Plugin = {
  id: 'builtin.theme-catppuccin-latte',
  name: 'Catppuccin Latte Theme',
  activate(ctx) {
    ctx.contribute('i18n', {
      locale: 'zh-CN',
      messages: { 'theme.catppuccin-latte': 'Catppuccin 浅色' },
    })
    ctx.contribute('i18n', {
      locale: 'en-US',
      messages: { 'theme.catppuccin-latte': 'Catppuccin Latte' },
    })
    ctx.contribute('theme', {
      id: 'catppuccin-latte',
      label: 'Catppuccin 浅色',
      labelKey: 'theme.catppuccin-latte',
      appearance: 'light',
      variables: CATPPUCCIN_LATTE_VARIABLES,
    })
  },
}

export default themeCatppuccinLattePlugin
