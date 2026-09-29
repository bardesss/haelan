import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { GRID_STACK_WIDTH } from '../src/ui/breakpoint.js'
import { I18nProvider } from '../src/i18n/index.js'
import { ChartFigure } from '../src/charts/ChartFigure.js'

// Comments stripped first, grid-collapse.test.ts's reason: the stylesheet's prose names the very
// selectors these checks look for.
const css = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

interface Rule { selectors: string[], body: string, at: number, media: string | null }

/** Every rule in the file, in order, with the media query it sits in (null at the top level). */
function rules(): Rule[] {
  const out: Rule[] = []
  const stack: string[] = []
  let start = 0
  for (let i = 0; i < css.length; i += 1) {
    if (css[i] === '{') {
      const prelude = css.slice(start, i).trim()
      if (prelude.startsWith('@')) stack.push(prelude)
      else {
        const close = css.indexOf('}', i)
        out.push({
          selectors: prelude.split(',').map((s) => s.trim()), body: css.slice(i + 1, close), at: i,
          media: stack.at(-1) ?? null,
        })
        i = close
      }
      start = i + 1
    } else if (css[i] === '}') {
      stack.pop()
      start = i + 1
    }
  }
  return out
}

const all = rules()

describe('the detail pages\' stylesheet', () => {
  // The night's "Die dag" rows stayed three across on a phone because the phone rule sat above the
  // rule it overrode, and a later rule of the same weight wins. Every narrow-width override of a
  // detail piece has to come after the piece's own rule.
  it('puts every narrow-width override of a detail piece after the rule it overrides', () => {
    const piece = /^\.(detail-|day-log|figure-row|day-nav)/
    const late: string[] = []
    for (const rule of all.filter((r) => r.media !== null && /max-width/.test(r.media))) {
      for (const selector of rule.selectors.filter((s) => piece.test(s))) {
        const base = all.find((r) => r.media === null && r.selectors.includes(selector))
        if (base !== undefined && base.at > rule.at) late.push(`${selector} (${rule.media})`)
      }
    }
    expect(late).toEqual([])
  })

  // Between 620px and 900px the rail keeps its width and a card is as narrow as on a phone, so the
  // rows go two across where the grid collapses, not only at the phone breakpoint.
  it('takes the detail rows to two across where the grid collapses', () => {
    const collapse = all.filter((r) => r.media === `@media (max-width: ${GRID_STACK_WIDTH}px)`)
    for (const selector of ['.detail-rows', '.detail-side-rows']) {
      const rule = collapse.find((r) => r.selectors.includes(selector))
      expect(rule?.body, selector).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
    }
    expect(collapse.find((r) => r.selectors.includes('.detail-side'))?.body).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/)
  })

  // One definition of a small uppercase label: FigureRow's label carries .label, and its own rule
  // must not restate the type with a different letter-spacing again.
  it('leaves a figure row label\'s type to .label', () => {
    const own = all.filter((r) => r.selectors.includes('.figure-row-label')).map((r) => r.body).join(';')
    expect(own).not.toMatch(/letter-spacing|text-transform|font-size|color/)
  })

  // A chart card's label sat flush on its chart (the night's "De nacht" and "Slaapschema") while
  // every other card had the label gap: ChartFigure zeroed the figure's margin inline, and an
  // inline style beats the one card-label rule. The reset lives in a class the rule outweighs.
  it('leaves a chart figure\'s margin to a class the card-label rule outweighs', () => {
    const figure = renderToStaticMarkup(
      <I18nProvider lng="en"><ChartFigure label="Night" table={{ columns: [], rows: [] }} host={{ current: null }} style={{}} /></I18nProvider>,
    ).match(/<figure[^>]*>/)?.[0]
    expect(figure).not.toMatch(/style=/)
    expect(figure).toMatch(/class="chart-figure"/)
    expect(all.find((r) => r.media === null && r.selectors.includes('.chart-figure'))?.body).toMatch(/margin:\s*0/)
    expect(all.find((r) => r.media === null && r.selectors.includes('.detail-page .card > .label + :not(.basis)'))?.body)
      .toMatch(/margin-top:\s*var\(--space-3\)/)
  })

  // The header's controls are one height whatever sits beside them: a detail page's row holds
  // only arrows and a link, where the dashboard's labelled buttons used to set the height.
  it('gives every control in the header row the same explicit height', () => {
    for (const selector of ['.day-nav-btn', '.day-nav-today', '.day-nav-back']) {
      const rule = all.find((r) => r.media === null && r.selectors.includes(selector))
      expect(rule?.body, selector).toMatch(/min-height:\s*32px/)
    }
  })
})
