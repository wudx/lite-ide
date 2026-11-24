import { createMockBackend } from '@lite-ide/protocol'
import { createRoot } from 'solid-js'
import { createComponent, render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchShell } from '../src/components/WorkbenchShell'
import { createWorkbenchKernel } from '../src/services'

describe('WorkbenchShell global contextmenu suppression', () => {
  let disposeRender: (() => void) | undefined
  let disposeRoot: (() => void) | undefined
  let container: HTMLDivElement | undefined

  function mountShell() {
    const backend = createMockBackend()
    const kernel = createRoot((d) => {
      disposeRoot = d
      return createWorkbenchKernel(backend)
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    disposeRender = render(() => createComponent(WorkbenchShell, { kernel }), container)
    return { container, kernel }
  }

  afterEach(() => {
    disposeRender?.()
    disposeRender = undefined
    disposeRoot?.()
    disposeRoot = undefined
    container?.remove()
    container = undefined
  })

  it('prevents native contextmenu on unhandled shell and document areas', () => {
    const { container: root } = mountShell()

    const shellTarget = root.querySelector('main') ?? root
    const shellEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    shellTarget.dispatchEvent(shellEvent)
    expect(shellEvent.defaultPrevented).toBe(true)

    const portalLike = document.createElement('div')
    document.body.appendChild(portalLike)
    try {
      const portalEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      portalLike.dispatchEvent(portalEvent)
      expect(portalEvent.defaultPrevented).toBe(true)
    } finally {
      portalLike.remove()
    }
  })

  it('runs in bubble phase so custom child contextmenu handlers execute first', () => {
    const { container: root } = mountShell()

    const child = document.createElement('div')
    root.appendChild(child)

    let defaultPreventedInChild: boolean | undefined
    child.addEventListener('contextmenu', (e) => {
      defaultPreventedInChild = e.defaultPrevented
    })

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    child.dispatchEvent(event)

    expect(defaultPreventedInChild).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })

  it('removes the global contextmenu listener on unmount', () => {
    mountShell()

    disposeRender?.()
    disposeRender = undefined
    container?.remove()
    container = undefined

    const target = document.createElement('div')
    document.body.appendChild(target)
    try {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    } finally {
      target.remove()
    }
  })
})
