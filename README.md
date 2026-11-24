# LiteIDE

**简体中文** | [English](README.en.md)

轻量级跨平台桌面 IDE，基于 **Tauri v2 (Rust) + SolidJS + Tailwind CSS v4** 构建。

<p align="center">
  <img src="docs/screenshots/workspace-dark.png" alt="LiteIDE 深色工作区（代码编辑与集成终端）" width="100%" />
</p>

## 为什么做这个项目

日常开发里，很多时候只是想快速打开几个仓库对照看看代码、改几行配置、预览下 Markdown 或表格文件，顺手跑个终端命令、提交下 Git。

打开传统重型 IDE（动辄几百 MB 安装包、常驻上 GB 内存、冷启动要等半天）实在太重；而用纯文本编辑器又少了工程目录、多项目切换、Git 和终端这些顺手的工具。

所以做了 **LiteIDE**：不追求大而全，只把最常用的工作台能力做成可按需加载的轻量插件，尽量做到**体积小、内存省、打开就能用**。

## 为什么它足够轻、足够快？

### 1. 极致小巧的应用体积
基于 **Tauri v2 + Rust**，直接复用系统原生 WebView（Windows WebView2 / macOS WKWebView / Linux WebKitGTK），彻底省去捆绑 Chromium 和 Node.js 运行时的冗余体积：

| 构建产物（Windows x64 Release） | 实测大小 |
| --- | --- |
| 安装包 (`LiteIDE_0.1.0_x64-setup.exe`) | **4.27 MB** |
| 安装包 (`LiteIDE_0.1.0_x64_en-US.msi`) | **5.91 MB** |
| 主程序单文件 (`lite-ide.exe`) | **15.52 MB** |

### 2. 克制的内存占用
- **SolidJS 细粒度响应式**：无 Virtual DOM diff 开销，运行时极其轻盈；
- **虚拟滚动与懒加载**：文件树基于 `@tanstack/solid-virtual` 按视口渲染、目录按需展开；大型能力（如 `.xlsx` 表格解析）通过 `liteide.loadChunk` 懒加载，不触发不加载、不占内存；
- **受控的多项目保活**：顶部一个标签页对应一个独立的 `ProjectScope`，非活跃热项目按 LRU 上限（默认 5 个）保活，切项目秒回现场的同时防止内存无限膨胀。

### 3. 快速启动与响应
- **Rust 原生后端**：文件列举（遵循 `.gitignore`）、`notify` 防抖监听、自定义协议文件流传输与 `portable-pty` 终端均由 Rust 原生承载，冷启动即开即用，不卡界面主线程；
- **微内核 + 轻量化符号索引**：用轻量正则启发式符号索引提供 `F12` 跳转定义 / `Shift+F12` 查看引用 / `Ctrl+F12` 转到实现，无需拉起沉重的语言服务器进程即可完成日常代码浏览。

<p align="center">
  <img src="docs/screenshots/git-markdown-light.png" alt="LiteIDE 浅色主题（Git 面板与 Markdown 预览）" width="100%" />
</p>

## 核心能力（全插件化）

LiteIDE 采用**微内核 + 插件化**架构，全部 12 个内置功能均以标准外部插件 `bundle` 格式构建加载，可按需启用或停用，也支持安装外部目录插件：

- **工作区与编辑**：多项目标签页隔离、虚拟文件树与全局文本搜索、CodeMirror 6 代码编辑（全语言高亮 + 符号导航）。
- **多模态文件预览**：Markdown 富文本（`markdown-it` + `DOMPurify`）、图片/SVG（缩放拖拽）、音频波形播放、Git Diff、Excel（`.xlsx` 懒加载）与二进制元信息兜底卡片。
- **Git 与终端**：侧栏 Git 状态管理（分支、暂存/提交、AI 生成提交信息、Stash）+ 底部 `xterm.js` 集成终端。
- **主题与多语言**：内置 Default Dark、Nord、Gruvbox、Catppuccin Latte 多套主题，支持 `zh-CN` / `en-US` 实时切换。
- **双模式运行**：桌面端走 Tauri IPC；纯浏览器执行 `pnpm dev` 自动启用内置 Mock 后端并预载示例项目，无需编译 Rust 即可快速预览与调试 UI。

## 目录结构

依赖严格单向流动：`protocol` → `kernel` → `workbench` → `plugins/*` → `apps/desktop`。

```text
lite-ide/
├── apps/desktop/       # @lite-ide/desktop — Vite + SolidJS 入口与全局样式
├── packages/
│   ├── protocol/       # WorkspaceBackend 契约（Tauri IPC / 浏览器 Mock）
│   ├── kernel/         # 微内核、ProjectScope、ServiceKey DI、EventBus
│   ├── plugin-sdk/     # 外部插件开发 SDK 与类型定义
│   └── workbench/      # 工作台壳层、符号索引、代码导航与插件注册表
├── plugins/            # 12 个内置插件（explorer, search, git, terminal, preview-*, theme-*）
├── samples/plugins/    # 外部插件开发样例（classic & bundle 格式）
├── src-tauri/          # Rust 原生后端（文件安全校验、监听、PTY、插件管理）
└── docs/screenshots/   # README 展示截图
```

## 快速开始

### 环境要求

- **Node.js** >= 20 & **pnpm** >= 9
- **Rust** 工具链（仅运行或打包 Tauri 桌面端时需要；浏览器 Mock 模式无需安装 Rust）

### 安装与运行

```bash
# 安装依赖
pnpm install

# 浏览器 Mock 模式（自动构建插件并在 http://localhost:1420 启动）
pnpm dev

# Tauri 桌面端开发模式
pnpm tauri:dev

# 打包桌面端安装包
pnpm tauri:build
```

### 常用开发与校验命令

```bash
pnpm build:plugins   # 并行构建全部内置与样例插件 dist
pnpm watch:plugins   # 监听插件源码变化并自动重编
pnpm typecheck       # 全量 TypeScript 类型检查
pnpm test            # Vitest 单元测试
pnpm test:e2e        # Playwright E2E 测试
cargo test --manifest-path src-tauri/Cargo.toml  # Rust 后端测试
```
