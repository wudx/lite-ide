import type { FileMeta, ProjectInfo } from '@lite-ide/protocol'
import type { Accessor, Component } from 'solid-js'
import type { Disposable } from './disposable'

export interface ServiceKey<T> {
  readonly id: symbol
  readonly name: string
}

export function createServiceKey<T>(name: string): ServiceKey<T> {
  return { id: Symbol(name), name }
}

export interface PreviewProps {
  scope: ProjectScope
  file: FileMeta
}

export interface ContributionMap {
  'sidebar.view': {
    id: string
    title: string
    titleKey?: string
    order: number
    icon?: Component
    component: Component<{ scope: ProjectScope }>
  }
  /**
   * Bottom panel view (e.g. terminal, output): rendered below the editor area
   * of each project, toggled through the workbench PanelState service.
   */
  'panel.view': {
    id: string
    title: string
    titleKey?: string
    order: number
    icon?: Component
    /** 视图自绘集成页签栏：仅存在单个 panel.view 时跳过 PanelHost 默认标题栏 */
    customHeader?: boolean
    component: Component<{ scope: ProjectScope }>
  }
  'previewer.provider': {
    id: string
    label: string
    labelKey?: string
    priority: number
    canHandle: (file: FileMeta) => boolean
    load: () => Promise<{ default: Component<PreviewProps> }>
    /** 该 provider 提供可编辑文本视图：宿主可据此显示"已保存"等编辑态徽章 */
    editable?: boolean
  }
  command: {
    id: string
    title: string
    titleKey?: string
    shortcut?: string
    run: (ctx: { kernel: AppKernel; activeProject?: ProjectScope }) => void | Promise<void>
  }
  'statusbar.item': {
    id: string
    align: 'left' | 'right'
    order: number
    component: Component<{ scope?: ProjectScope }>
  }
  'settings.section': {
    id: string
    title: string
    titleKey?: string
    order: number
    component: Component<{ kernel: AppKernel }>
  }
  theme: {
    id: string
    label: string
    labelKey?: string
    /** 明暗基调：驱动根元素 dark/light class 与代码编辑器配色回退 */
    appearance: 'dark' | 'light'
    /** 激活时以行内样式注入根元素的 CSS 自定义属性（覆盖 app.css 的 :root 默认值） */
    variables?: Record<string, string>
  }
  i18n: {
    /** BCP 47 语言标识（如 'zh-CN'、'en-US'） */
    locale: string
    /** 语言的自称显示名；提供时会将该语言注册为设置界面的可选项 */
    label?: string
    /** 该语言下的词条字典 */
    messages: Record<string, string>
  }
}

export type ContributionPoint = keyof ContributionMap

export interface KernelEvents {
  'project.opened': { scope: ProjectScope }
  'project.activated': { scope: ProjectScope | undefined }
  'project.closed': { projectId: string; rootPath: string }
  'project.reordered': { projectIds: readonly string[] }
  'plugin.registered': { id: string }
  'plugin.unregistered': { id: string }
  [key: string]: unknown
}

export interface ProjectScope extends Disposable {
  readonly id: string
  readonly rootPath: string
  readonly name: string
  readonly isDisposed: boolean
  provide<T>(key: ServiceKey<T>, service: T): Disposable
  get<T>(key: ServiceKey<T>): T
  tryGet<T>(key: ServiceKey<T>): T | undefined
  onDispose(disposable: Disposable | (() => void)): Disposable
  runInScope<R>(fn: () => R): R
}

export interface PluginContext {
  readonly kernel: AppKernel
  provide<T>(key: ServiceKey<T>, service: T): Disposable
  get<T>(key: ServiceKey<T>): T
  tryGet<T>(key: ServiceKey<T>): T | undefined
  contribute<K extends ContributionPoint>(point: K, item: ContributionMap[K]): Disposable
  onEvent<K extends keyof KernelEvents>(
    event: K,
    listener: (payload: KernelEvents[K]) => void,
  ): Disposable
  emit<K extends keyof KernelEvents>(event: K, payload: KernelEvents[K]): void
  onProjectOpen(handler: (scope: ProjectScope) => void | Disposable): Disposable
  onDispose(disposable: Disposable | (() => void)): Disposable
}

export interface Plugin {
  id: string
  name: string
  activate(ctx: PluginContext): void | Disposable
}

export interface OpenedProjectHandle {
  info: ProjectInfo
  setupScope?: (scope: ProjectScope) => void
  close?: () => Promise<void> | void
}

export interface KernelProjectHost {
  open(rootPath: string): Promise<OpenedProjectHandle>
  pickFolder?(options?: { title?: string }): Promise<string | null>
}

export interface AppKernelOptions {
  host: KernelProjectHost
  maxWarmProjects?: number
}

export interface AppKernel extends Disposable {
  provide<T>(key: ServiceKey<T>, service: T): Disposable
  get<T>(key: ServiceKey<T>): T
  tryGet<T>(key: ServiceKey<T>): T | undefined
  contribute<K extends ContributionPoint>(point: K, item: ContributionMap[K]): Disposable
  contributions<K extends ContributionPoint>(point: K): Accessor<readonly ContributionMap[K][]>
  onEvent<K extends keyof KernelEvents>(
    event: K,
    listener: (payload: KernelEvents[K]) => void,
  ): Disposable
  emit<K extends keyof KernelEvents>(event: K, payload: KernelEvents[K]): void
  registerPlugin(plugin: Plugin): Disposable
  readonly projects: Accessor<readonly ProjectScope[]>
  readonly activeProjectId: Accessor<string | null>
  readonly activeProject: Accessor<ProjectScope | undefined>
  readonly warmProjectIds: Accessor<readonly string[]>
  isWarm(projectId: string): boolean
  openProject(rootPath: string): Promise<ProjectScope>
  openProjectWithDialog(options?: { title?: string }): Promise<ProjectScope | null>
  activateProject(projectId: string): void
  /**
   * 重排项目页签：把 fromIndex 的项目移动到 toIndex（splice 落位语义）。
   * 不改变活跃项目与热项目集合；越界下标收敛到合法区间，无效变动为 no-op。
   */
  reorderProjects(fromIndex: number, toIndex: number): void
  closeProject(projectId: string): Promise<void>
  executeCommand(commandId: string): Promise<void>
}
