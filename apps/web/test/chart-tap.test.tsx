// @vitest-environment happy-dom
//
// happy-dom, not the default node environment, because this file mounts a real echarts instance
// and clicks a real button, the same reason chart-lifecycle.test.tsx needs it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import * as echarts from 'echarts/core'
import type { ECElementEvent, EChartsOption } from 'echarts'
import { useChart } from '../src/charts/useChart.js'
import { ChartFigure } from '../src/charts/ChartFigure.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { PHONE_MEDIA_QUERY } from '../src/ui/breakpoint.js'
import { I18nProvider } from '../src/i18n/index.js'

// happy-dom applies no stylesheet, so echarts.init's effect throws "missing chart token" without
// this, the same reason chart-lifecycle.test.tsx sets them.
for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null
const realMatchMedia = window.matchMedia.bind(window)

/**
 * Answers the phone query however this test wants and hands every other query to happy-dom.
 *
 * Delegating rather than stubbing wholesale matters: useChart reads
 * '(prefers-reduced-motion: reduce)' and '(prefers-color-scheme: light)' through the same
 * function and subscribes to both, so a stub that answered every query itself would also be
 * deciding the motion preference this suite sets in vitest.config.ts.
 */
function pretendPhone(isPhone: boolean): void {
  window.matchMedia = ((query: string) => {
    if (query !== PHONE_MEDIA_QUERY) return realMatchMedia(query)
    return {
      matches: isPhone, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    } as unknown as MediaQueryList
  }) as typeof window.matchMedia
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  window.matchMedia = realMatchMedia as typeof window.matchMedia
})

const DAYS = ['2026-09-01', '2026-09-02']

// Module scope, so it is the same reference on every render: useChart keys its init/dispose effect
// on `build`, which is what chart-lifecycle.test.tsx guards on the production charts.
const build = (): EChartsOption => ({
  xAxis: { type: 'category', data: DAYS },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', data: [1, 2] }],
})

function Probe({ onClick }: { onClick: (event: ECElementEvent) => void }) {
  const { host, style, tap } = useChart(build, 60, {
    onClick,
    describe: (event) => DAYS[event.dataIndex],
  })
  return (
    <ChartFigure label="probe" host={host} style={style} tap={tap}
      table={{ columns: ['Date'], rows: DAYS.map((date) => [date]) }} />
  )
}

function mount(isPhone: boolean): ECElementEvent[] {
  const clicks: ECElementEvent[] = []
  pretendPhone(isPhone)
  act(() => {
    root!.render(<I18nProvider lng="en"><Probe onClick={(event) => clicks.push(event)} /></I18nProvider>)
  })
  return clicks
}

/**
 * A click on a plotted point, delivered the way echarts itself delivers one.
 *
 * echarts converts a zrender hit into `this.trigger(eventType, params)` on the instance, and
 * `chart.on('click', handler)` - what useChart binds - registers on that same emitter. Calling
 * trigger directly is therefore the same call the library makes, without needing a hit test:
 * happy-dom has no layout engine, so no synthesised pointer event would ever land on a bar.
 */
function tapPoint(dataIndex: number): void {
  const hostElement = container!.querySelector<HTMLElement>('[role="img"]')
  if (!hostElement) throw new Error('no chart host rendered')
  const chart = echarts.getInstanceByDom(hostElement) as unknown as {
    trigger(name: string, payload: unknown): void
  } | undefined
  if (!chart) throw new Error('no echarts instance on the chart host')
  act(() => {
    chart.trigger('click', {
      componentType: 'series', seriesType: 'bar', seriesIndex: 0, dataIndex, name: DAYS[dataIndex],
    })
  })
}

function annotateControl(): HTMLButtonElement | null {
  return container!.querySelector<HTMLButtonElement>('.chart-annotate')
}

describe('a tap on a chart', () => {
  // The desktop behaviour, unchanged: hover shows the tooltip, a click opens the annotate panel.
  it('opens the annotate panel above the breakpoint', () => {
    const clicks = mount(false)
    tapPoint(1)
    expect(clicks).toHaveLength(1)
    expect(clicks[0]?.dataIndex).toBe(1)
  })

  // The decision this task exists for. Touch has no hover, so one tap would both read the value
  // and open a modal over it; below the breakpoint it reads the value and nothing else.
  it('does not open the annotate panel below the breakpoint', () => {
    const clicks = mount(true)
    tapPoint(1)
    expect(clicks).toHaveLength(0)
  })

  // Nothing above the breakpoint changes, the footer row included: the control exists only where
  // the suppression above does.
  it('leaves the footer row alone above the breakpoint', () => {
    mount(false)
    expect(annotateControl()).toBeNull()
  })

  it('offers a disabled annotate control below the breakpoint until something is tapped', () => {
    mount(true)
    const control = annotateControl()
    expect(control).not.toBeNull()
    expect(control!.disabled).toBe(true)
    expect(control!.textContent).toContain('Tap a point')
  })

  // What travels from the chart to the control: the point last tapped, named, so the reader can
  // see which one they are about to act on before they act on it.
  it('names the point last tapped and annotates it when pressed', () => {
    const clicks = mount(true)
    tapPoint(1)
    const control = annotateControl()
    expect(control).not.toBeNull()
    expect(control!.disabled).toBe(false)
    expect(control!.textContent).toContain('2026-09-02')

    act(() => { control!.click() })
    expect(clicks).toHaveLength(1)
    expect(clicks[0]?.dataIndex).toBe(1)

    // A second tap moves the selection rather than adding to it.
    tapPoint(0)
    expect(annotateControl()!.textContent).toContain('2026-09-01')
  })
})
