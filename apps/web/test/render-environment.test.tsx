// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act, useEffect, useState } from 'react'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

describe('the render environment', () => {
  // renderToStaticMarkup can prove none of this: it runs no effects, keeps no state between
  // renders, and dispatches no events. These three assertions are the coverage M3a did not have.
  it('runs effects, keeps state across a rerender, and dispatches a real event', () => {
    const effectRuns: number[] = []

    function Probe() {
      const [count, setCount] = useState(0)
      useEffect(() => { effectRuns.push(count) }, [count])
      return <button type="button" onClick={() => setCount((c) => c + 1)}>{count}</button>
    }

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => { root!.render(<Probe />) })

    const button = container.querySelector('button')!
    expect(button.textContent).toBe('0')

    act(() => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(button.textContent).toBe('1')
    expect(effectRuns).toEqual([0, 1])
  })
})
