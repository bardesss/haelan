// @vitest-environment happy-dom
//
// happy-dom, not the default node environment, because this file mounts a real echarts instance
// and clicks a real button, the same reason chart-lifecycle.test.tsx needs it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useCallback } from 'react'
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

// Module scope, so each is the same reference on every render with it: useChart keys its
// init/dispose effect on `build`, which is what chart-lifecycle.test.tsx guards on the production
// charts. Handing the probe the second array is what a range or metric change looks like from
// inside a chart - new data, and so a new `build`.
const DAYS = ['2026-09-01', '2026-09-02']
const LATER_DAYS = ['2026-10-05', '2026-10-06']

function Probe({ days, onClick }: { days: string[]; onClick: (event: ECElementEvent) => void }) {
  // Memoised over `days`, exactly as every production chart memoises `build` over its own data.
  const build = useCallback((): EChartsOption => ({
    xAxis: { type: 'category', data: days },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', data: days.map((_, index) => index + 1) }],
  }), [days])
  const { host, style, tap } = useChart(build, 60, {
    onClick,
    describe: (event) => days[event.dataIndex],
  })
  return (
    <ChartFigure label="probe" host={host} style={style} tap={tap}
      table={{ columns: ['Date'], rows: days.map((date) => [date]) }} />
  )
}

function renderProbe(days: string[], clicks: ECElementEvent[]): void {
  act(() => {
    root!.render(
      <I18nProvider lng="en"><Probe days={days} onClick={(event) => clicks.push(event)} /></I18nProvider>,
    )
  })
}

function mount(isPhone: boolean): ECElementEvent[] {
  const clicks: ECElementEvent[] = []
  pretendPhone(isPhone)
  renderProbe(DAYS, clicks)
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

  // The one behaviour with nothing else standing behind it. A stored tap is an `ECElementEvent`,
  // which names a point by `dataIndex` and nothing else, so replaying it against data the chart no
  // longer draws would annotate whichever day now happens to sit at that index - a reader taps
  // 2 September, changes the range, presses the control and corrects an October day instead.
  //
  // useChart's reset keyed on `build` is the whole of what prevents that, and every other case in
  // this file passes with it deleted. Verified by deleting it: the other five stayed green and
  // this one failed at `control.disabled`, still armed over a September day under a chart that had
  // moved to October.
  it('forgets the tapped point when the chart is handed new data', () => {
    const clicks = mount(true)
    tapPoint(1)
    expect(annotateControl()!.textContent).toContain('2026-09-02')

    // A new range: a fresh array, so a fresh `build`, which is how a data change reaches useChart
    // from every chart in the app.
    renderProbe(LATER_DAYS, clicks)

    const control = annotateControl()
    expect(control!.disabled).toBe(true)
    expect(control!.textContent).toContain('Tap a point')
    expect(control!.textContent).not.toContain('2026-09-02')

    // And the selection that replaces it comes from the new data, not the old: proof the reset
    // cleared the stored event rather than only the label rendered from it.
    tapPoint(0)
    expect(annotateControl()!.textContent).toContain('2026-10-05')
    act(() => { annotateControl()!.click() })
    expect(clicks).toHaveLength(1)
    expect(clicks[0]?.dataIndex).toBe(0)
  })
})
