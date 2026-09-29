import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { FigureRows } from '../src/components/FigureRow.js'
import { GRID_STACK_WIDTH } from '../src/ui/breakpoint.js'

const css = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')

const rows = (n: number) => Array.from({ length: n }, (_, i) => <div key={i}>row {i}</div>)

// A grid of figure rows is as many columns as it has rows, up to its cap: one strength figure
// used to sit in a quarter of its card with three empty quarters beside it.
describe('FigureRows', () => {
  it('takes one column per row, up to four', () => {
    expect(renderToStaticMarkup(<FigureRows>{rows(1)}</FigureRows>)).toMatch(/^<div class="detail-rows" data-columns="1">/)
    expect(renderToStaticMarkup(<FigureRows>{rows(3)}</FigureRows>)).toMatch(/^<div class="detail-rows" data-columns="3">/)
    expect(renderToStaticMarkup(<FigureRows>{rows(8)}</FigureRows>)).toMatch(/^<div class="detail-rows" data-columns="4">/)
  })

  it('caps at the columns its card gives it, and draws the side variant for a side card', () => {
    expect(renderToStaticMarkup(<FigureRows max={3}>{rows(5)}</FigureRows>)).toMatch(/data-columns="3"/)
    expect(renderToStaticMarkup(<FigureRows side>{rows(2)}</FigureRows>)).toMatch(/^<div class="detail-side-rows" data-columns="2">/)
  })

  it('counts only the rows it is actually given, not a false left by a condition', () => {
    expect(renderToStaticMarkup(<FigureRows>{[...rows(2), false, null]}</FigureRows>)).toMatch(/data-columns="2"/)
  })

  // The stylesheet side: each column count is a rule, and below the grid's collapse width every
  // count of two or more is two across (a single row stays one).
  it('has a rule for each column count, and two across where the grid collapses', () => {
    for (const n of [1, 2, 3, 4]) {
      expect(css, String(n)).toMatch(new RegExp(`\\[data-columns="${n}"\\][^{]*\\{[^}]*grid-template-columns: repeat\\(${n}, minmax\\(0, 1fr\\)\\)`))
    }
    const collapse = css.slice(css.indexOf(`@media (max-width: ${GRID_STACK_WIDTH}px)`))
    expect(collapse).toMatch(/\.detail-rows\[data-columns\][^{]*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/)
    expect(collapse).toMatch(/\[data-columns="1"\][^{]*\{[^}]*repeat\(1, minmax\(0, 1fr\)\)/)
  })
})
