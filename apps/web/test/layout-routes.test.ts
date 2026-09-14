import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '../src/routes.js'

const listed: string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../scripts/layout-check-routes.json', import.meta.url)), 'utf8'),
)

describe('the layout check route list', () => {
  // Every route in ROUTES, parameterised ones included, listed as ROUTES.tsx itself spells them -
  // `/activity/:sessionId` and `/sleep/night/:localDate` as literal templates, `:` and all. A page
  // nobody checks at 375px is a page that silently goes back to being 700px wide, and that risk
  // does not go away just because a route also happens to take a parameter.
  //
  // scripts/layout-check.mjs is what turns those two templates into real URLs before it opens
  // them: it reads the built demo's own capture manifest (dist-demo/demo-api/manifest.json) for a
  // real session id (off a captured `/sessions/:id` read) and a real night date (off a captured
  // single-day `/sleep/nights?from=X&to=X` read), and substitutes them in. Never hardcoded here or
  // there - a re-capture reassigns every id (capture-demo.mjs's writeCapture hashes each URL), and
  // a hardcoded id would rot into a 404 the SPA renders as an empty page nothing here would notice.
  it('lists every route in ROUTES', () => {
    const expected = ROUTES.map((r) => r.path)
    expect([...listed].sort()).toEqual([...expected].sort())
  })
})
