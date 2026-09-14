import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ECElementEvent, EChartsOption } from 'echarts'
import * as echarts from 'echarts/core'
import { BarChart, CustomChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts'
import {
  GraphicComponent, GridComponent, MarkAreaComponent, MarkLineComponent,
  MarkPointComponent, TooltipComponent, VisualMapComponent,
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { currentChartTokens, type ChartTokens } from './tokens.js'
import { withMotionPreference } from './base.js'
import { useIsPhone } from '../ui/breakpoint.js'

// Registers only what's used, not the echarts barrel, so the bundle stays proportional; add new
// chart types here deliberately.
//
// A series type missing from this list does not throw and does not degrade: echarts logs
// "[ECharts] Series <type> is used but not imported." and draws nothing at all, leaving the grid
// and the axes in place around an empty plot. `ZoneBar` drew `type: 'bar'` for a whole release
// against a list that had no `BarChart` in it, and the workout page's zone chart was an empty box
// the entire time -- with its accessible table listing the zones correctly beside it, which is
// what made it invisible to both the suite and a casual look. `chart-series-registered.test.ts`
// now reads this list against every series type in src/charts, so the next one cannot be silent.
echarts.use([
  BarChart, CustomChart, HeatmapChart, LineChart, ScatterChart,
  GraphicComponent, GridComponent, MarkAreaComponent, MarkLineComponent,
  MarkPointComponent, TooltipComponent, VisualMapComponent,
  SVGRenderer,
])

/**
 * What a chart knows about the points it draws: how to act on the one that was clicked, and how
 * to name it.
 *
 * One argument rather than two, because neither half is usable alone. Below the breakpoint a click
 * does not act, so the only way back to the annotate panel is a control that says which point it
 * will open - and a control that cannot name its point is the "enabled but says nothing" case the
 * spec rules out. Taking them together makes a chart that can act but cannot name unrepresentable
 * rather than merely discouraged.
 */
export type ChartPointHandlers = {
  /** Opens the annotate panel for this point. Above the breakpoint a click runs it directly. */
  onClick: (event: ECElementEvent) => void
  /**
   * The point in the reader's own words - a formatted date, a time of day - or undefined when the
   * click landed on something that is not a point (an axis, the grid, empty space). Undefined
   * means "not a selection", so the previous one stands, exactly as `onClick` does nothing there.
   */
  describe: (event: ECElementEvent) => string | undefined
}

/** The last tapped point and the control that acts on it. Below the breakpoint only. */
export type ChartTap = {
  /** `describe`'s answer for the last tap, or null until a tap has landed on a point. */
  name: string | null
  /** Opens the annotate panel for that point. */
  annotate: () => void
}

export function useChart(
  build: (t: ChartTokens) => EChartsOption,
  height: number,
  point?: ChartPointHandlers,
): { host: RefObject<HTMLDivElement | null>; style: { width: string; height: number }; tap?: ChartTap } {
  const host = useRef<HTMLDivElement>(null)
  // A ref, not a `build`-style dependency: a caller's point handlers are a fresh object of fresh
  // closures every render (they capture whatever local date they should report), and folding it into the
  // effect's own dependency array would dispose and reinitialise the chart on every render for a
  // reason that has nothing to do with what the chart draws, the exact defect chart-lifecycle.test.tsx
  // guards on the build side.
  const pointRef = useRef(point)
  useLayoutEffect(() => { pointRef.current = point })

  // The guard lives here, in the one place that binds the one click handler, rather than in the
  // six chart components that pass a handler to it: a chart should know what it draws and not what
  // a phone is. It is a ref for the same reason the handlers are - the click listener is bound once
  // per chart, inside the effect below, and would otherwise read whatever this was at init.
  const isPhone = useIsPhone()
  const isPhoneRef = useRef(isPhone)
  useLayoutEffect(() => { isPhoneRef.current = isPhone })

  // The tapped point survives in state rather than a ref because the control's own label and
  // disabled state are rendered from it: a ref would record the tap and leave the footer showing
  // "tap a point" over a point that had just been tapped.
  const [tapped, setTapped] = useState<ECElementEvent | null>(null)
  const [tappedName, setTappedName] = useState<string | null>(null)

  useEffect(() => {
    if (!host.current) return
    const element = host.current
    const chart = echarts.init(element, undefined, { renderer: 'svg' })
    // Above the breakpoint a click opens the annotate panel, as it always has. Below it, the same
    // gesture is the only way to read a value at all - touch has no hover, so the tap that shows
    // the tooltip is the tap that would open a modal over it - so the click is remembered instead
    // of run, and ChartFigure's own control is what opens the panel for it.
    const handleClick = (event: ECElementEvent) => {
      const handlers = pointRef.current
      if (!handlers) return
      if (!isPhoneRef.current) { handlers.onClick(event); return }
      const name = handlers.describe(event)
      // Not a point: the axis, the grid, the space between bars. Desktop does nothing here either,
      // so neither does this - in particular it does not clear a selection the reader already made.
      if (name === undefined) return
      setTapped(event)
      setTappedName(name)
    }
    chart.on('click', handleClick)
    // Read per render rather than once: the preference can change while the page is open, and
    // the next redraw is the first chance to honour it.
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const render = () => chart.setOption(withMotionPreference(build(currentChartTokens()), motion.matches), true)
    render()

    // Two ways the effective theme changes, and a chart that watches only one keeps stale
    // colours until something else happens to redraw it. The attribute covers an explicit
    // choice; the media query covers the reader's system flipping while the page is open, which
    // is the default case now that no theme is pinned in the document.
    const observer = new MutationObserver(render)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = window.matchMedia('(prefers-color-scheme: light)')
    scheme.addEventListener('change', render)
    motion.addEventListener('change', render)
    // The chart's own container, not the window. A `resize` listener runs *during* the resize
    // event, while the document still carries the layout it is about to leave: crossing the
    // breakpoint upward - a tablet rotating portrait to landscape - every chart measured a
    // `.layout-phone` `.main` that was still full-bleed, because useIsPhone's state change had not
    // re-rendered yet, and then kept that width once the 186px rail came back. Every page scrolled
    // sideways afterwards and only a *further* resize corrected it, which a rotation never sends.
    //
    // A ResizeObserver is delivered after layout, carrying the container's settled size, so it
    // cannot read a mode that is already gone. Deliberately not a timeout: a delay long enough
    // today is a race nobody can see being lost tomorrow.
    const sizeObserver = new ResizeObserver(() => chart.resize())
    sizeObserver.observe(element)

    return () => {
      observer.disconnect()
      sizeObserver.disconnect()
      scheme.removeEventListener('change', render)
      motion.removeEventListener('change', render)
      chart.dispose()
    }
  }, [build])

  // A new `build` is new data - a different range, a different metric, a refetch that moved a
  // value - and the point the reader tapped belongs to the data that is gone. React bails out when
  // the value is already null, so a chart that was never tapped pays nothing for this.
  useEffect(() => {
    setTapped(null)
    setTappedName(null)
  }, [build])

  const annotate = useCallback(() => {
    // pointRef, not the `point` this render closed over, for the same reason the click handler
    // reads it: by the time this runs the chart has re-rendered several times and only the current
    // handler knows the current data. `tapped` is the event, kept as echarts delivered it.
    if (tapped) pointRef.current?.onClick(tapped)
  }, [tapped])

  return {
    host,
    style: { width: '100%', height },
    // Only below the breakpoint, and only for a chart that has points to act on: above it a click
    // still opens the panel, so a second control beside the table toggle would be a second way to
    // do a thing the reader can already do, taking up room in a footer that is not getting wider.
    ...(isPhone && point ? { tap: { name: tappedName, annotate } } : {}),
  }
}
