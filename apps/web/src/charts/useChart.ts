import { useEffect, useRef } from 'react'
import type { EChartsOption } from 'echarts'
import * as echarts from 'echarts/core'
import { CustomChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts'
import {
  GraphicComponent, GridComponent, MarkAreaComponent, MarkLineComponent,
  MarkPointComponent, TooltipComponent, VisualMapComponent,
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { currentChartTokens, type ChartTokens } from './tokens.js'
import { withMotionPreference } from './base.js'

// Registers only what's used, not the echarts barrel, so the bundle stays proportional; add new chart types here deliberately.
echarts.use([
  CustomChart, HeatmapChart, LineChart, ScatterChart,
  GraphicComponent, GridComponent, MarkAreaComponent, MarkLineComponent,
  MarkPointComponent, TooltipComponent, VisualMapComponent,
  SVGRenderer,
])

export function useChart(build: (t: ChartTokens) => EChartsOption, height: number) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!host.current) return
    const chart = echarts.init(host.current, undefined, { renderer: 'svg' })
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
