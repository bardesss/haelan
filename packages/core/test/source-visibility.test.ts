import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { SourceVisibilityStore } from '../src/store/sourceVisibility.ts'
import { sources } from '../src/db/schema/index.ts'

let test: TestDatabase
let instance: { sourceVisibility: SourceVisibilityStore }

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  seedPerson(test.db, 'p2')
  test.db.insert(sources).values([
    { id: 'watch', personId: 'p1', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4', kind: 'device', createdAtMs: 10 },
    { id: 'phone', personId: 'p1', externalId: 'HEALTH_CONNECT:com.lyfta', displayName: 'com.lyfta', kind: 'app', createdAtMs: 20 },
    { id: 'theirs', personId: 'p2', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4', kind: 'device', createdAtMs: 10 },
  ]).run()
  instance = { sourceVisibility: new SourceVisibilityStore(test.db) }
})
afterEach(() => test.cleanup())

describe('SourceVisibilityStore', () => {
  it('knows nothing until a person chooses', () => {
    expect(instance.sourceVisibility.list('p1')).toEqual(new Map())
  })

  it('records a choice either way and replaces it', () => {
    instance.sourceVisibility.put({ personId: 'p1', sourceId: 'watch', visible: false, nowMs: 1 })
    instance.sourceVisibility.put({ personId: 'p1', sourceId: 'phone', visible: true, nowMs: 1 })
    instance.sourceVisibility.put({ personId: 'p1', sourceId: 'watch', visible: true, nowMs: 2 })
    expect(instance.sourceVisibility.list('p1')).toEqual(new Map([['watch', true], ['phone', true]]))
  })

  it('forgets a choice on clear, which puts the source back on the 30-day default', () => {
    instance.sourceVisibility.put({ personId: 'p1', sourceId: 'watch', visible: false, nowMs: 1 })
    instance.sourceVisibility.clear({ personId: 'p1', sourceId: 'watch' })
    expect(instance.sourceVisibility.list('p1').has('watch')).toBe(false)
  })

  it('refuses a source that is not this person\'s', () => {
    expect(() => instance.sourceVisibility.put({ personId: 'p1', sourceId: 'nope', visible: true, nowMs: 1 }))
      .toThrow(/does not belong/)
  })
})
