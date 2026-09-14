import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '../src/routes.js'

const listed: string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../scripts/layout-check-routes.json', import.meta.url)), 'utf8'),
)

describe('the layout check route list', () => {
  // The two parameterised routes are excluded here and swept in M7b, where their ids can be read
  // out of the capture manifest. Everything else must be listed: a page nobody checks at 375px is
  // a page that silently goes back to being 700px wide.
  it('lists every route that takes no parameter', () => {
    const expected = ROUTES.map((r) => r.path).filter((p) => !p.includes(':'))
    expect([...listed].sort()).toEqual([...expected].sort())
  })
})
