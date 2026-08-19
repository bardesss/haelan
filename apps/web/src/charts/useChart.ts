import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import { currentChartTokens, type ChartTokens } from './tokens.js'

export function useChart(build: (t: ChartTokens) => echarts.EChartsOption, height: number) {
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
