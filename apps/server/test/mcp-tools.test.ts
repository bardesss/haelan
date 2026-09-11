import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { PersonQuery, createTestDatabase, seedPerson, schema } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { CATALOGUE } from '../src/mcp/catalogue.ts'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'robin', { displayName: 'Robin', timezone: 'Europe/Amsterdam' })
  test.db.insert(schema.sources).values({
    id: 'watch', personId: 'robin', externalId: 'watch', displayName: 'Fitbit Sense',
    kind: 'device', createdAtMs: 0,
  }).run()
})
afterEach(() => test.cleanup())

const tool = (name: string) => {
  const found = CATALOGUE.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool named ${name}`)
  return found
}
const q = () => new PersonQuery(test.db, 'robin')

describe('describe_person', () => {
  it('answers the bound person, their timezone and their sources', () => {
    const out = tool('describe_person').run(q(), {}) as {
      personId: string, timezone: string, sources: { id: string, name: Record<string, unknown> }[]
    }
    expect(out.personId).toBe('robin')
    expect(out.timezone).toBe('Europe/Amsterdam')
    expect(out.sources).toHaveLength(1)
    expect(out.sources[0]!.id).toBe('watch')
  })

  it('puts a source name in the untrusted envelope, because a device chose it', () => {
    const out = tool('describe_person').run(q(), {}) as {
      sources: { name: { untrustedText: string | null } }[]
    }
    expect(out.sources[0]!.name.untrustedText).toBe('Fitbit Sense')
  })
})

describe('list_metrics', () => {
  it('names every metric with the aggregates the catalogue allows it', () => {
    const out = tool('list_metrics').run(q(), {}) as { metrics: { metric: string, aggs: string[] }[] }
    const steps = out.metrics.find((m) => m.metric === 'steps')
    expect(steps).toBeDefined()
    expect(steps!.aggs.length).toBeGreaterThan(0)
  })
})

describe('the catalogue itself', () => {
  it('has no duplicate tool names', () => {
    const names = CATALOGUE.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every tool a description that tells an agent when to reach for it', () => {
    for (const t of CATALOGUE) expect(t.description.length).toBeGreaterThan(40)
  })
})
