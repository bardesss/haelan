import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'

// The defect class this milestone exists to close: eleven cards written by six people, four
// different conventions for pending, empty and error, and each divergence found in a separate
// review round. A page that hand rolls its own gating is how it comes back, so make that visible
// at review time rather than three rounds later.
describe('pages route their cards through MetricCard', () => {
  const pages = readdirSync('apps/web/src/pages').filter((f) => f.endsWith('.tsx'))

  it.each(pages)('%s does not hand roll the gating', (page) => {
    const source = readFileSync(`apps/web/src/pages/${page}`, 'utf8')
    if (!source.includes('emptyStateFor')) return
    expect(source).toContain('MetricCard')
  })

  it('finds the pages it claims to check', () => {
    expect(pages.length).toBeGreaterThan(0)
  })
})
