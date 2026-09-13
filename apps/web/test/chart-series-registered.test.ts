import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHARTS = fileURLToPath(new URL('../src/charts', import.meta.url))
const USE_CHART = fileURLToPath(new URL('../src/charts/useChart.ts', import.meta.url))

/**
 * echarts series type names, so that `type: 'value'` on an axis and `type: 'rect'` in a custom
 * renderItem are not mistaken for series. Only the names this project could plausibly reach are
 * listed; a series type absent from here is simply not checked, which is the safe direction for a
 * guard whose failure mode should be silence rather than noise.
 */
const SERIES_TYPES = [
  'bar', 'line', 'scatter', 'effectScatter', 'custom', 'heatmap', 'pie', 'radar', 'boxplot',
  'candlestick', 'gauge', 'funnel', 'sankey', 'graph', 'tree', 'treemap', 'sunburst',
  'pictorialBar', 'themeRiver', 'lines', 'map', 'parallel',
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** The identifiers useChart.ts imports from `echarts/charts` and hands to `echarts.use`. */
function registeredCharts(): Set<string> {
  const source = withoutComments(readFileSync(USE_CHART, 'utf8'))
  const importMatch = source.match(/import\s*\{([^}]*)\}\s*from\s*'echarts\/charts'/)
  if (!importMatch) throw new Error('useChart.ts imports nothing from echarts/charts')
  const imported = importMatch[1]!.split(',').map((name) => name.trim()).filter(Boolean)
  const used = source.match(/echarts\.use\(\[([\s\S]*?)\]\)/)
  if (!used) throw new Error('useChart.ts calls no echarts.use')
  const registered = used[1]!.split(',').map((name) => name.trim())
  // Imported is not the same as registered: an import left out of the use() call registers nothing.
  return new Set(imported.filter((name) => registered.includes(name)))
}

/**
 * A series type this app draws but never registered renders NOTHING, and says so only in a console
 * warning nobody is reading.
 *
 * echarts' modular build ships each series separately and `echarts.use` is the whole of the
 * registration; `setOption` with an unregistered `type` logs "[ECharts] Series bar is used but not
 * imported." and skips the series. Measured on this exact registration list: a bar series renders
 * an SVG of 945 bytes containing 2 elements, all of them grid and axis, against 3585 bytes and 13
 * elements for the same data as a line.
 *
 * That is exactly what happened. `ZoneBar` drew `type: 'bar'` from the day it was added, `BarChart`
 * was never added to the list, and the workout page's zone chart rendered as an empty box through
 * a release. No test caught it because every chart test in this suite mocks `echarts/core`'s
 * `init`, so `setOption` is a spy and the real renderer never runs -- and `ChartFigure`'s
 * accessible table still listed the zones, so the data was demonstrably present while the picture
 * was not.
 *
 * Reading the property off source is the only place it can be caught cheaply, the same device
 * `css-classes.test.ts`, `no-raw-color.test.ts` and `no-unescaped-tooltip.test.ts` use for the
 * other interfaces here that fail silently.
 */
describe('every series type src/charts draws is registered in useChart', () => {
  it('registers a chart module for each series type in use', () => {
    const registered = registeredCharts()
    const missing: string[] = []
    for (const file of sourceFiles(CHARTS)) {
      const source = withoutComments(readFileSync(file, 'utf8'))
      for (const match of source.matchAll(/type:\s*'([A-Za-z]+)'/g)) {
        const seriesType = match[1]!
        if (!SERIES_TYPES.includes(seriesType)) continue
        const module = `${seriesType[0]!.toUpperCase()}${seriesType.slice(1)}Chart`
        if (registered.has(module)) continue
        missing.push(`${file.slice(CHARTS.length + 1)} draws '${seriesType}', needs ${module}`)
      }
    }
    expect([...new Set(missing)], 'these series render nothing at all').toEqual([])
  })

  // The guard reads two shapes out of one file with two regexes, so "it passes" is not evidence it
  // can fail. An identifier that is imported but left out of the use() call registers nothing, and
  // that is the likelier future mistake than forgetting the import outright.
  it('does not count an import that never reaches echarts.use', () => {
    const registered = registeredCharts()
    expect(registered.has('LineChart'), 'LineChart is imported and used').toBe(true)
    expect(registered.has('PieChart'), 'nothing imports PieChart').toBe(false)
  })
})
