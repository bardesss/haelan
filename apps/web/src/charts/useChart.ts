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

// Registering only what the six charts use, rather than importing the `echarts`
// barrel, is what keeps the bundle proportional to the charts that exist. Adding
// a chart type means adding it here, deliberately.
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
    const render = () => chart.setOption(build(currentChartTokens()), true)
    render()

    const observer = new MutationObserver(render)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const resize = () => chart.resize()
    window.addEventListener('resize', resize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
      chart.dispose()
    }
  }, [build])

  return { host, style: { width: '100%', height } }
}
