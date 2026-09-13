import { useEffect, useLayoutEffect, useRef } from 'react'
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

export function useChart(
  build: (t: ChartTokens) => EChartsOption,
  height: number,
  onClick?: (event: ECElementEvent) => void,
) {
  const host = useRef<HTMLDivElement>(null)
  // A ref, not a `build`-style dependency: a caller's click handler is typically a fresh closure
  // every render (it captures whatever local date it should report), and folding it into the
  // effect's own dependency array would dispose and reinitialise the chart on every render for a
  // reason that has nothing to do with what the chart draws, the exact defect chart-lifecycle.test.tsx
  // guards on the build side.
  const onClickRef = useRef(onClick)
  useLayoutEffect(() => { onClickRef.current = onClick })

  useEffect(() => {
    if (!host.current) return
    const chart = echarts.init(host.current, undefined, { renderer: 'svg' })
    const handleClick = (event: ECElementEvent) => onClickRef.current?.(event)
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
    const resize = () => chart.resize()
    window.addEventListener('resize', resize)

    return () => {
      observer.disconnect()
      scheme.removeEventListener('change', render)
      motion.removeEventListener('change', render)
      window.removeEventListener('resize', resize)
      chart.dispose()
    }
  }, [build])

  return { host, style: { width: '100%', height } }
}
