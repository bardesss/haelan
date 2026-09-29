import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/i18n/index.js'
import { FigureRow } from '../src/components/FigureRow.js'
import { gaugeScale, gaugeFraction } from '../src/pages/dashboard/UsualGauge.js'

const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider lng="en">{node}</I18nProvider>)
const BAND = { center: 85, low: 70, high: 100, thin: false }

describe('FigureRow', () => {
  it('shows the label, the value and the verdict', () => {
    const html = render(<FigureRow label="Deep sleep" value="1h 04m" verdict="shorter than your usual 1h 10m-1h 40m" judged="worse" band={BAND} mark={64} />)
    expect(html).toContain('>Deep sleep<')
    expect(html).toContain('>1h 04m<')
    expect(html).toContain('>shorter than your usual 1h 10m-1h 40m<')
  })
  it('colours the verdict by whether it is better or worse, and leaves a neutral one plain', () => {
    expect(render(<FigureRow label="a" value="1" verdict="v" judged="worse" band={BAND} mark={64} />)).toContain('figure-row-verdict worse')
    expect(render(<FigureRow label="a" value="1" verdict="v" judged="better" band={BAND} mark={110} />)).toContain('figure-row-verdict better')
    expect(render(<FigureRow label="a" value="1" verdict="v" judged={null} band={BAND} mark={80} />)).toContain('class="figure-row-verdict"')
  })
  it('places the band and the mark on the dashboard gauge scale', () => {
    const scale = gaugeScale(BAND)
    const left = (gaugeFraction(BAND.low, scale) * 100).toFixed(1)
    const mark = (gaugeFraction(64, scale) * 100).toFixed(1)
    const html = render(<FigureRow label="a" value="1" verdict="v" judged="worse" band={BAND} mark={64} />)
    expect(html).toContain(`left:${left}%`)
    expect(html).toContain(`left:${mark}%`)
  })
  it('draws no bar without a band', () => {
    expect(render(<FigureRow label="a" value="1" verdict="v" judged={null} band={null} mark={64} />)).not.toContain('figure-row-bar')
  })
  it('draws no bar on a thin band, which would look as sure as a full one', () => {
    const html = render(<FigureRow label="a" value="1" verdict="v" judged={null} band={{ ...BAND, thin: true }} mark={64} />)
    expect(html).not.toContain('figure-row-bar')
    expect(html).toContain('>v<')
  })
  it('wraps a strip in a description carrying the verdict', () => {
    const strip = {
      values: [1, 2, null, 4], labels: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'],
      metric: 'weight', unit: 'kg', formatValue: (v: number | null, absent: string) => (v === null ? absent : String(v)),
    }
    const html = render(<FigureRow label="Weight" value="4" verdict="within your usual range" judged={null} band={null} mark={null} strip={strip} />)
    // echarts never mounts under renderToStaticMarkup, so the canvas host is empty; what static
    // rendering CAN show is that the verdict text is present as the chart's own description,
    // reachable through ChartFigure's aria-describedby wiring (Described's own contract).
    expect(html).toContain('within your usual range')
    expect(html).toContain('sr-only')
    expect(html).not.toContain('figure-row-bar')
  })
})
