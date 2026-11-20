// LiteIDE 外部插件入口（经典脚本，无构建步骤）。
// 通过全局 liteide.plugin({ activate(ctx) {...} }) 注册；activate 收到的
// ctx 与内置插件一致，可使用全部贡献点。返回的 Disposable 在停用 /
// 卸载时由工作台统一释放。外部脚本不参与 Tailwind 扫描，样式请用
// 行内 style 或全局 CSS 变量。
liteide.plugin({
  activate(ctx) {
    return ctx.contribute('statusbar.item', {
      id: 'hello-status.greeting',
      align: 'right',
      order: 90,
      component: () => {
        const el = document.createElement('span')
        el.style.color = 'var(--accent)'
        el.style.fontWeight = '600'
        el.textContent = '你好，插件！'
        return el
      },
    })
  },
})
