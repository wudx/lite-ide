# LiteIDE — Agent 项目指南

LiteIDE 是基于 **Tauri v2 (Rust) + SolidJS + Tailwind CSS v4** 的轻量跨平台桌面 IDE，采用 **微内核 + 插件化** 架构与 **pnpm workspace** monorepo。

## 工作区结构与依赖方向

依赖严格单向流动：`protocol` → `kernel` → `workbench` → `plugins/*` → `apps/desktop`（原生层位于 `src-tauri/`）。

| 目录 | 包名 | 职责 |
| --- | --- | --- |
| `apps/desktop/` | `@lite-ide/desktop` | Vite + SolidJS 入口：`src/main.tsx` 装配后端、内核、内置插件及 `localStorage` 会话恢复；`src/styles/app.css` 定义主题变量与 Tailwind `@source` |
| `packages/protocol/` | `@lite-ide/protocol` | 前后端契约 `WorkspaceBackend`：`tauri` IPC 实现、`mock` 浏览器演示后端、`workspace://` / `http://workspace.localhost/` 文件 URL 构造 |
| `packages/kernel/` | `@lite-ide/kernel` | 微内核：`AppKernel`、`ProjectScope`、强类型 `ServiceKey` DI（scope → kernel 回退）、响应式贡献点、`EventBus`、`DisposableStore`、LRU 热项目保活 |
| `packages/plugin-sdk/` | `@lite-ide/plugin-sdk` | 外部插件作者的类型与构建约定包：`definePlugin` 助手、`Plugin`/`PluginContext` 类型 re-export、环境模块 `liteide`（`apiVersion` / `plugin()` / `loadChunk()`）声明 |
| `packages/workbench/` | `@lite-ide/workbench` | 工作台壳层组件（`WorkbenchShell`、`TitleBar`、`ProjectWorkspace`、`PreviewHost`、`PanelHost`、`StatusBar`、`WelcomeEmpty`、`NavigationPanel`）与核心服务键（`WorkspaceBackendKey`、`ProjectSelectionKey`、`ProjectFsEventsKey`、`LayoutStateKey`、`SymbolIndexKey`（正则启发式符号索引，F12 跳转定义 / Shift+F12 查看引用 / Ctrl+F12 转到实现）、`CodeNavigationKey`（光标上下文、行级 reveal 与结果面板编排）） |
| `plugins/explorer/` | `@lite-ide/plugin-explorer` | 文件树插件（bundle 格式嵌入式内置）：贡献 `sidebar.view`，基于 `@tanstack/solid-virtual` 虚拟滚动与懒加载目录（服务键 `FileTreeStoreKey`）；贡献 `settings.section`（资源管理器）维护全局文件树排除 glob 规则（服务键 `ExplorerExcludeStateKey`，`localStorage` 持久化） |
| `plugins/git/` | `@lite-ide/plugin-git` | Git 插件（bundle 格式嵌入式内置）：贡献 `sidebar.view`、`statusbar.item`、双 `previewer.provider`（diff + xlsx 表格），`xlsx` 解析器拆为 `chunks:{xlsx}` 懒加载（服务键 `GitBackendKey`/`GitStoreKey`，消费 `ProjectFsEventsKey`/`AiModelKey` 等） |
| `plugins/preview-audio/` | `@lite-ide/plugin-preview-audio` | 音频预览插件（bundle 格式嵌入式内置）：`previewer.provider`（优先级 `60`），波形渲染与播放控制 |
| `plugins/preview-code/` | `@lite-ide/plugin-preview-code` | 代码预览插件（bundle 格式嵌入式内置）：贡献 `previewer.provider`（优先级 `10`，`editable: true` 元数据供宿主显示"已保存"徽章）与 `statusbar.item`，CodeMirror 6（含 language-data 全部语言包）打包进自身 dist（服务键 `CodeStatsKey`）；消费 `CodeNavigationKey` 实现光标上报、Ctrl+点击跳转定义与行级 reveal 闪烁高亮 |
| `plugins/preview-markdown/` | `@lite-ide/plugin-preview-markdown` | Markdown 预览插件（bundle 格式嵌入式内置）：`previewer.provider`（优先级 `50`），`markdown-it` + `DOMPurify` 打包进自身 dist，重写相对图片与站内文件链接 |
| `plugins/preview-image/` | `@lite-ide/plugin-preview-image` | 图片/SVG 预览插件（bundle 格式嵌入式内置）：`previewer.provider`（优先级 `60`），棋盘格背景、缩放与拖拽 |
| `plugins/preview-fallback/` | `@lite-ide/plugin-preview-fallback` | 兜底元信息卡片（bundle 格式嵌入式内置）：`previewer.provider`（优先级 `0`），展示二进制或任意文件元数据 |
| `plugins/theme-nord/` | `@lite-ide/plugin-theme-nord` | Nord 深色主题插件（bundle 格式嵌入式内置）：贡献 `theme`（`variables` 以行内样式覆盖 `:root` 默认值） |
| `plugins/theme-gruvbox/` | `@lite-ide/plugin-theme-gruvbox` | Gruvbox 深色主题插件（bundle 格式嵌入式内置）：贡献 `theme`（暖灰底色 + 鼠尾草绿强调） |
| `plugins/theme-catppuccin-latte/` | `@lite-ide/plugin-theme-catppuccin-latte` | Catppuccin Latte 浅色主题插件（bundle 格式嵌入式内置）：贡献 `theme`（柔灰浅底 + Mauve 紫色强调） |
| `plugins/terminal/` | `@lite-ide/plugin-terminal` | 终端插件（bundle 格式嵌入式内置）：贡献 `panel.view`（底部面板，`PanelStateKey` 控制开关/高度/激活 tab）+ `statusbar.item` 开关 + 命令 `terminal.toggle`（Ctrl+`），xterm.js + addon-fit 打包进自身 dist；每项目 scope 持有 `TerminalStoreKey` 会话（懒启动 PTY，随 scope 关闭回收），mock 模式由伪 shell（`mock-terminal.ts`）支持演示与 e2e |
| `src-tauri/` | `lite-ide` | Rust 后端：`project.rs`（`DashMap` 会话 + `notify` 250ms 防抖监听）、`fs.rs`（遵循 `.gitignore` 的列目录/探查/读取 + 路径穿越防护）、`plugins.rs`（外部插件目录管理：manifest v2 校验/文件夹安装/内嵌目录/卸载/入口与资产读取，classic 512KB、bundle 6MB 分级限额）、`protocol.rs`（异步 `workspace` 自定义协议 + HTTP `Range`）、`lib.rs`（IPC 命令与窗口初始化） |
| `samples/plugins/` | — | 外部插件示例：`hello-status` / `theme-dracula` 为 classic 脚本；`bundle-notes` 为 bundle 格式全能力样例（Solid 侧栏 + 自有服务键 + i18n + CSS 资产 + chunk 懒加载 `.log` 预览器，dist 检入仓库）。三者内容均为单一源，前端 mock 经 `?raw` 引用、Rust 经 `include_str!` 内嵌，也可在桌面端直接"从文件夹安装" |

## 核心架构与扩展约定

- **插件扩展机制**：新功能实现为独立插件。全部 12 个内置插件（含 preview-code、explorer、git、terminal 等重型插件与 3 个内置主题插件）均按外部插件格式构建、以嵌入式来源经注册表加载（见下条），`apps/desktop/src/main.tsx` 不再直接 `kernel.registerPlugin` 任何内置。内核提供 8 个贡献点：`sidebar.view`、`panel.view`（底部面板视图，宿主 `PanelHost` 渲染于编辑器卡片下方并以 `display: none` 保活隐藏面板，运行中的会话不丢输出）、`previewer.provider`（bundle 包用静态导入 + `Promise.resolve({ default })` 或 `liteide.loadChunk`；可选 `editable: true` 元数据声明可编辑视图，供宿主显示"已保存"徽章）、`command`、`statusbar.item`、`settings.section`、`theme`、`i18n`，以及项目生命周期钩子 `ctx.onProjectOpen(scope => ...)`。`theme` 贡献点供插件注册自定义配色主题（`{ id, label, appearance, variables }`），`ThemeStateKey` 服务响应式聚合内置与插件主题并负责行内变量注入/清除；`i18n` 贡献点供插件补充词条或注册新语言（`{ locale, label?, messages }`），`I18nStateKey` 服务响应式驱动全工作台多语言与设置对话框"通用"区语言切换（支持跟随系统、`zh-CN`、`en-US`）。
- **多项目隔离与生命周期**：顶部 1 个 Tab 对应 1 个 `ProjectScope`（内含独立 SolidJS `createRoot`）。`openProject` 必须先执行 `setupScope` 和全部 `onProjectOpen` 钩子，再在 `batch(...)` 中更新 `projects` / `warmProjectIds` / `activeProjectId`，保证组件同步挂载时所有项目级服务已就绪；非活跃的热项目（默认 LRU 上限 5 个）以 `display: none` 保活 DOM 与滚动状态。
- **外部插件系统（manifest v2 + 双格式 + 嵌入式内置）**：`plugin.json` 支持两种入口格式——`format: "classic"`（默认，经典脚本经 `globalThis.liteide.plugin({...})` 捕获注册，≤512KB）与 `format: "bundle"`（Vite lib 模式构建的 CommonJS 单文件 `dist/plugin.js`，≤6MB；共享模块 `solid-js`/`solid-js/web`/`@lite-ide/kernel`/`@lite-ide/workbench`/`@lite-ide/protocol`/`@lite-ide/plugin-sdk`/`liteide` 保持 external，由宿主 require 表注入——**solid 必须用宿主单例，否则响应式分裂**）。manifest 可选 `css`（激活时经 `pluginReadAsset` 读文本注入 `<style data-liteide-plugin>`，停用/卸载移除；插件自编译 CSS 用 `@import "tailwindcss/theme.css"` + `utilities.css` 分层，**禁 preflight**）与 `chunks`（逻辑名→文件名，`require('liteide').loadChunk(name)` 按需求值并缓存，实现懒加载预览器；chunk 应无状态——停用不清理缓存、启用复用旧实例，有状态 chunk 须在 activate 内自建）与 `api`（要求的主机 API 版本，高于 `HOST_API_VERSION` 拒载）。后端方法族 `pluginList/pluginInstallFromPath/pluginInstallFromCatalog/pluginUninstall/pluginReadEntry/pluginReadAsset/pluginCatalog`；workbench 的 `PluginRegistryKey`（`plugin-registry.ts`）统一装配：**嵌入式内置插件**（`EmbeddedPluginSource`：dist 经 `?raw` 内联进 main.tsx，与用户插件走同一加载器，可停用不可卸载）+ 后端已装插件。设置对话框"插件"分区提供目录安装、启用/停用、二次确认卸载（嵌入式行显示"内置"徽标且无卸载按钮）。**新增/修改 bundle 插件后必须先 `pnpm build:plugins` 产出 dist**（`pnpm dev`/`pnpm build`/`tauri:dev` 已自动前置；开发迭代用 `pnpm watch:plugins`）。信任模型与 VS Code 侧载扩展同级：插件目录位于应用数据目录，能写该目录的本地进程即视为可信——启用中的插件会在启动时自动执行。
- **双运行模式（Tauri + Mock）**：`createDefaultBackend()` 检测 `window.__TAURI_INTERNALS__`，桌面端走 Tauri IPC，纯浏览器（`pnpm dev`）自动降级为 `createMockBackend()` 并预载两个示例项目（`lite-ide-demo`、`rust-core-sample`）。改动 UI 或插件时保持两种模式均可用。
- **Rust 安全与错误边界**：所有文件读写与自定义协议请求均须通过 `resolve_safe_path` 校验路径位于项目 `canonical_root` 之内；错误统一走 `AppError` 序列化为 `{ code, message }`。

## 关键约定与避坑

- **Tailwind CSS v4 跨包扫描**：Vite 根目录在 `apps/desktop/`，所有组件在 `packages/` 与 `plugins/`。`apps/desktop/src/styles/app.css` 通过 `@source "../../../../packages";` 与 `@source "../../../../plugins";` 显式纳入扫描；若新增顶层 UI 目录，同步补充 `@source`。
- **SolidJS 响应式与虚拟列表**：始终在 JSX、`<Show>`、`<Switch>` 或 `createMemo` 内读取 `props`，避免在组件函数顶层做条件分支（`ExplorerView` 虚拟行按 `index` 复用，非响应式分支会导致目录展开图标与文件图标错乱）。搭配 `truncate`（`overflow: hidden`）时使用 `leading-normal`，避免 `leading-none` 裁切 `g`/`j` 等字母下伸部。
- **`lucide-solid` 按需导入**：直接从规范子路径 `lucide-solid/icons/<kebab-name>` 默认导入（如 `loader-circle`、`file-code-corner`、`triangle-exclamation-point`、`file-braces`、`file-exclamation-point`），避免从 `'lucide-solid'` 桶入口导入导致 dev 模式加载 1500+ 图标模块或旧别名缺少 `.d.ts`。
- **无边框标题栏**：`src-tauri/tauri.conf.json` 默认 `decorations: false`（Windows/Linux 使用 `TitleBar.tsx` 自绘控制按钮；macOS 在 `src-tauri/src/lib.rs` 切换为 `Overlay` 标题栏）。`data-tauri-drag-region` 内的非交互子元素需加 `pointer-events-none`，确保 Windows WebView2 拖拽生效；新增窗口 API 调用需在 `src-tauri/capabilities/default.json` 补齐权限。

## 常用命令与验证标准

- **开发启动**：`pnpm dev`（先自动构建插件 dist 再起浏览器 mock 模式，`http://localhost:1420`，`strictPort: true`）；`pnpm tauri:dev`（完整 Tauri 桌面端）。改动轻量内置插件源码后，另开 `pnpm watch:plugins` 让 dist 即时生效。
- **插件 dist 构建**：`pnpm build:plugins`（12 个嵌入式内置 + bundle-notes 样例并行构建；`pnpm dev` / `pnpm build` / `tauri:dev` 已自动前置）；单独构建用 `pnpm --filter <pkg> run build:plugin`。
- **前端校验**：`pnpm test`（Vitest + jsdom）、`pnpm typecheck`（全量 18 个有 typecheck 的工作区包）、`pnpm build`（先构建插件 dist 再 Vite 生产构建）。
- **Rust 校验**：`cargo test --manifest-path src-tauri/Cargo.toml`。
- **UI 改动必做目视核验**：涉及样式、布局或交互改动时，启动 `pnpm dev` 在浏览器打开 `http://localhost:1420` 检查实际渲染效果与控制台零报错；核验完毕后释放 `1420` 端口，以免阻塞后续 `pnpm dev` / `pnpm tauri:dev`。
