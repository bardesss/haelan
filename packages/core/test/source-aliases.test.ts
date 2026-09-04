import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { SourceAliasStore, nameFor, MAX_ALIAS_LENGTH } from '../src/store/sourceAliases.ts'
import { getSource } from '../src/store/sources.ts'
import { ConfigError } from '../src/errors.ts'
import { sources } from '../src/db/schema/index.ts'

let test: TestDatabase
let store: SourceAliasStore

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  seedPerson(test.db, 'p2')
  test.db.insert(sources).values([
    { id: 'watch', personId: 'p1', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4', kind: 'device', createdAtMs: 10 },
    { id: 'app', personId: 'p1', externalId: 'HEALTH_CONNECT:com.lyfta', displayName: 'com.lyfta', kind: 'app', createdAtMs: 20 },
    { id: 'nameless', personId: 'p1', externalId: 'HEALTH_CONNECT:', displayName: '', kind: 'app', createdAtMs: 30 },
    { id: 'theirs', personId: 'p2', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4', kind: 'device', createdAtMs: 10 },
  ]).run()
  store = new SourceAliasStore(test.db)
})
afterEach(() => test.cleanup())

describe('nameFor', () => {
  it('prefers the alias', () => {
    expect(nameFor({ id: 'watch', displayName: 'Pixel Watch 4', alias: 'My watch' })).toBe('My watch')
  })

  it('falls back to the provider name when there is no alias', () => {
    expect(nameFor({ id: 'watch', displayName: 'Pixel Watch 4', alias: null })).toBe('Pixel Watch 4')
  })

  // display_name is not null but nothing stops a provider sending an empty one, and a picker
  // showing a blank option is worse than one showing a hex id.
  it('falls back to the id when the provider name is empty', () => {
    expect(nameFor({ id: 'nameless', displayName: '', alias: null })).toBe('nameless')
  })
})

describe('listNamed', () => {
  it('names every source the person has, in creation order', () => {
    store.put({ personId: 'p1', sourceId: 'app', alias: 'Food diary', nowMs: 100 })
    expect(store.listNamed('p1')).toEqual([
      { id: 'watch', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4', alias: null, name: 'Pixel Watch 4', kind: 'device', createdAtMs: 10 },
      { id: 'app', externalId: 'HEALTH_CONNECT:com.lyfta', displayName: 'com.lyfta', alias: 'Food diary', name: 'Food diary', kind: 'app', createdAtMs: 20 },
      { id: 'nameless', externalId: 'HEALTH_CONNECT:', displayName: '', alias: null, name: 'nameless', kind: 'app', createdAtMs: 30 },
    ])
  })

  it('does not leak another person\'s sources', () => {
    expect(store.listNamed('p1').map((s) => s.id)).not.toContain('theirs')
  })
})

describe('put', () => {
  it('trims', () => {
    store.put({ personId: 'p1', sourceId: 'watch', alias: '  My watch  ', nowMs: 100 })
    expect(store.listNamed('p1')[0]!.alias).toBe('My watch')
  })

  it('replaces an existing alias rather than adding a second row', () => {
    store.put({ personId: 'p1', sourceId: 'watch', alias: 'First', nowMs: 100 })
    store.put({ personId: 'p1', sourceId: 'watch', alias: 'Second', nowMs: 200 })
    expect(store.listNamed('p1').filter((s) => s.id === 'watch')).toHaveLength(1)
    expect(store.listNamed('p1')[0]!.name).toBe('Second')
  })

  it('refuses an alias that is empty once trimmed', () => {
    expect(() => store.put({ personId: 'p1', sourceId: 'watch', alias: '   ', nowMs: 100 }))
      .toThrow(ConfigError)
  })

  it(`refuses an alias longer than ${MAX_ALIAS_LENGTH} characters`, () => {
    expect(() => store.put({ personId: 'p1', sourceId: 'watch', alias: 'x'.repeat(MAX_ALIAS_LENGTH + 1), nowMs: 100 }))
      .toThrow(ConfigError)
    store.put({ personId: 'p1', sourceId: 'watch', alias: 'x'.repeat(MAX_ALIAS_LENGTH), nowMs: 100 })
    expect(store.listNamed('p1')[0]!.alias).toHaveLength(MAX_ALIAS_LENGTH)
  })

  // Two sources called the same thing is a picker that cannot be used and an ECharts legend that
  // merges two series into one entry. Refused here rather than coped with downstream.
  it('refuses a name this person already used for another source', () => {
    store.put({ personId: 'p1', sourceId: 'watch', alias: 'Watch', nowMs: 100 })
    expect(() => store.put({ personId: 'p1', sourceId: 'app', alias: 'Watch', nowMs: 200 }))
      .toThrow(ConfigError)
  })

  // The duplicate check excludes the source being written (`ne(sourceAliases.sourceId, ...)` in
  // sourceAliases.ts) so a person retyping a source's own current name into the settings field --
  // an unremarkable no-op edit, not a rename -- does not read back as a clash with itself.
  it('lets a source keep the name it already has', () => {
    store.put({ personId: 'p1', sourceId: 'watch', alias: 'Watch', nowMs: 100 })
    expect(() => store.put({ personId: 'p1', sourceId: 'watch', alias: 'Watch', nowMs: 200 }))
      .not.toThrow()
    expect(store.listNamed('p1')[0]!.name).toBe('Watch')
  })

  it('lets another person use the same name', () => {
    store.put({ personId: 'p1', sourceId: 'watch', alias: 'Watch', nowMs: 100 })
    store.put({ personId: 'p2', sourceId: 'theirs', alias: 'Watch', nowMs: 100 })
    expect(store.listNamed('p2')[0]!.name).toBe('Watch')
  })

  // Defence in depth behind the route's own check, and the same rule SourcePriorityStore's
  // #assertOwned enforces: the foreign key is on sources.id alone, so the database would happily
  // file another person's source under this one.
  it('refuses a source belonging to another person', () => {
    expect(() => store.put({ personId: 'p1', sourceId: 'theirs', alias: 'Theirs', nowMs: 100 }))
      .toThrow(ConfigError)
  })
})

describe('clear', () => {
  it('removes the name and falls back to the provider\'s', () => {
    store.put({ personId: 'p1', sourceId: 'watch', alias: 'My watch', nowMs: 100 })
    store.clear({ personId: 'p1', sourceId: 'watch' })
    expect(store.listNamed('p1')[0]!.name).toBe('Pixel Watch 4')
  })

  it('is not an error when there is no name to remove', () => {
    expect(() => store.clear({ personId: 'p1', sourceId: 'watch' })).not.toThrow()
  })
})

describe('getSource', () => {
  it('finds this person\'s source', () => {
    expect(getSource(test.db, 'p1', 'watch')?.displayName).toBe('Pixel Watch 4')
  })

  it('does not find another person\'s', () => {
    expect(getSource(test.db, 'p1', 'theirs')).toBeUndefined()
  })
})
