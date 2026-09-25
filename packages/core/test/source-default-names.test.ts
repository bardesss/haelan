import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { defaultNamesOf, englishDefaultName, knownAppOf } from '../src/api/sourceNames.ts'
import type { NameableSource } from '../src/api/sourceNames.ts'
import { SourceAliasStore, namedSourcesOf } from '../src/store/sourceAliases.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { readAllTime } from '../src/query/allTime.ts'

// Synthetic sources only: the package names are the real ones the rule is keyed on, the hashes,
// ids and dates are made up.
const HC_A = 'com.android.healthconnect.phone.0a1b2c3d'
const HC_B = 'com.android.healthconnect.phone.9f8e7d6c'

const row = (o: Partial<NameableSource> & { id: string, displayName: string }): NameableSource => ({
  kind: 'app', alias: null, firstSeenDate: '2026-09-04', ...o,
})

describe('knownAppOf', () => {
  it('knows the three packages by what describe() stores for an app with no device name', () => {
    expect(knownAppOf({ kind: 'app', displayName: 'com.haelan.android' })?.key).toBe('haelanPhone')
    expect(knownAppOf({ kind: 'app', displayName: 'health.openscale.sync.oss' })?.key).toBe('openScale')
    expect(knownAppOf({ kind: 'app', displayName: HC_A })?.key).toBe('healthConnectPhone')
    expect(knownAppOf({ kind: 'app', displayName: 'com.android.healthconnect.phone' })?.key).toBe('healthConnectPhone')
  })

  it('includes a manual source, which describe() names after its package as well', () => {
    expect(knownAppOf({ kind: 'manual', displayName: 'com.haelan.android' })?.key).toBe('haelanPhone')
  })

  // A device named itself; its name is its own even when it looks like a package.
  it('never renames a device', () => {
    expect(knownAppOf({ kind: 'device', displayName: 'com.haelan.android' })).toBeNull()
  })

  it('does not match a package that merely starts the same way', () => {
    expect(knownAppOf({ kind: 'app', displayName: 'com.haelan.android.debug' })).toBeNull()
    expect(knownAppOf({ kind: 'app', displayName: 'com.android.healthconnect.phonebook' })).toBeNull()
    expect(knownAppOf({ kind: 'app', displayName: 'com.lyfta' })).toBeNull()
  })
})

describe('defaultNamesOf', () => {
  it('gives a lone known app its plain default, with no date', () => {
    expect(defaultNamesOf([row({ id: 'h', displayName: HC_A })]).get('h'))
      .toEqual({ key: 'healthConnectPhone', since: null, tag: null })
  })

  it('dates each of two colliding defaults by when it was first seen', () => {
    const names = defaultNamesOf([
      row({ id: 'a', displayName: HC_A, firstSeenDate: '2026-09-04' }),
      row({ id: 'b', displayName: HC_B, firstSeenDate: '2026-09-12' }),
      row({ id: 'h', displayName: 'com.haelan.android', firstSeenDate: '2026-09-04' }),
    ])
    expect(names.get('a')).toEqual({ key: 'healthConnectPhone', since: '2026-09-04', tag: null })
    expect(names.get('b')).toEqual({ key: 'healthConnectPhone', since: '2026-09-12', tag: null })
    // A different app on the same date does not collide with either.
    expect(names.get('h')).toEqual({ key: 'haelanPhone', since: null, tag: null })
  })

  it('stops dating a default once the other one is renamed', () => {
    const names = defaultNamesOf([
      row({ id: 'a', displayName: HC_A, firstSeenDate: '2026-09-04' }),
      row({ id: 'b', displayName: HC_B, firstSeenDate: '2026-09-12', alias: 'Old phone' }),
    ])
    expect(names.get('a')).toEqual({ key: 'healthConnectPhone', since: null, tag: null })
    // Still present, for the rename field's placeholder, but undated: it collides with nothing.
    expect(names.get('b')).toEqual({ key: 'healthConnectPhone', since: null, tag: null })
  })

  // Sources first created by one upload or one rebuild share a date, and a date that does not
  // separate them would leave two identical labels in a picker.
  it('falls back to a piece of the id when the dates collide too', () => {
    const names = defaultNamesOf([
      row({ id: 'aaaa1111', displayName: HC_A, firstSeenDate: '2026-09-04' }),
      row({ id: 'bbbb2222', displayName: HC_B, firstSeenDate: '2026-09-04' }),
      row({ id: 'cccc3333', displayName: 'com.android.healthconnect.phone', firstSeenDate: '2026-09-05' }),
    ])
    expect(names.get('aaaa1111')).toEqual({ key: 'healthConnectPhone', since: '2026-09-04', tag: 'aaaa' })
    expect(names.get('bbbb2222')).toEqual({ key: 'healthConnectPhone', since: '2026-09-04', tag: 'bbbb' })
    expect(names.get('cccc3333')).toEqual({ key: 'healthConnectPhone', since: '2026-09-05', tag: null })
  })

  it('leaves an unknown app and a device out entirely', () => {
    const names = defaultNamesOf([
      row({ id: 'app', displayName: 'com.lyfta' }),
      row({ id: 'watch', displayName: 'Pixel Watch 4', kind: 'device' }),
    ])
    expect(names.size).toBe(0)
  })
})

describe('englishDefaultName', () => {
  it('says the default, its date and its tag in full', () => {
    expect(englishDefaultName({ key: 'haelanPhone', since: null, tag: null })).toBe('Haelan (phone)')
    expect(englishDefaultName({ key: 'openScale', since: null, tag: null })).toBe('openScale')
    expect(englishDefaultName({ key: 'healthConnectPhone', since: '2026-09-04', tag: null }))
      .toBe('Health Connect (phone), since 4 Sep 2026')
    expect(englishDefaultName({ key: 'healthConnectPhone', since: '2026-12-31', tag: 'aaaa' }))
      .toBe('Health Connect (phone), since 31 Dec 2026 (aaaa)')
  })
})

describe('namedSourcesOf', () => {
  let test: TestDatabase
  // 2026-09-03T23:30Z is already 4 Sep in Amsterdam, the fixture person's zone.
  const LATE_ON_THE_3RD_UTC = Date.UTC(2026, 8, 3, 23, 30)
  const ON_THE_12TH = Date.UTC(2026, 8, 12, 10)

  beforeEach(() => {
    test = createTestDatabase()
    seedPerson(test.db, 'p1')
    test.db.insert(sources).values([
      { id: 'watch', personId: 'p1', externalId: 'HEALTH_CONNECT:Pixel Watch 4', displayName: 'Pixel Watch 4', kind: 'device', createdAtMs: 1 },
      { id: 'lyfta', personId: 'p1', externalId: 'HEALTH_CONNECT:com.lyfta', displayName: 'com.lyfta', kind: 'app', createdAtMs: 2 },
      { id: 'haelan', personId: 'p1', externalId: 'HEALTH_CONNECT:com.haelan.android', displayName: 'com.haelan.android', kind: 'app', createdAtMs: 3 },
      { id: 'scale', personId: 'p1', externalId: 'HEALTH_CONNECT:health.openscale.sync.oss', displayName: 'health.openscale.sync.oss', kind: 'app', createdAtMs: 4 },
      { id: 'hcA', personId: 'p1', externalId: `HEALTH_CONNECT:${HC_A}`, displayName: HC_A, kind: 'app', createdAtMs: LATE_ON_THE_3RD_UTC },
      { id: 'hcB', personId: 'p1', externalId: `HEALTH_CONNECT:${HC_B}`, displayName: HC_B, kind: 'app', createdAtMs: ON_THE_12TH },
    ]).run()
  })
  afterEach(() => test.cleanup())

  const names = () => Object.fromEntries(namedSourcesOf(test.db, 'p1').map((s) => [s.id, s.name]))

  it('names known apps readably and leaves everything else as it was', () => {
    expect(names()).toEqual({
      watch: 'Pixel Watch 4',
      lyfta: 'com.lyfta',
      haelan: 'Haelan (phone)',
      scale: 'openScale',
      // The first-seen date in the person's zone, not UTC's.
      hcA: 'Health Connect (phone), since 4 Sep 2026',
      hcB: 'Health Connect (phone), since 12 Sep 2026',
    })
  })

  it('lets an alias win, and sends the default beside it for the placeholder', () => {
    const store = new SourceAliasStore(test.db)
    store.put({ personId: 'p1', sourceId: 'haelan', alias: 'My phone', nowMs: 10 })
    const haelan = namedSourcesOf(test.db, 'p1').find((s) => s.id === 'haelan')!
    expect(haelan.name).toBe('My phone')
    expect(haelan.defaultName).toEqual({ key: 'haelanPhone', since: null, tag: null })
  })

  it('carries the key and date the web localises from', () => {
    const hcA = namedSourcesOf(test.db, 'p1').find((s) => s.id === 'hcA')!
    expect(hcA.defaultName).toEqual({ key: 'healthConnectPhone', since: '2026-09-04', tag: null })
    expect(namedSourcesOf(test.db, 'p1').find((s) => s.id === 'lyfta')!.defaultName).toBeNull()
  })

  it('is what listNamed answers, so no surface resolves a second way', () => {
    expect(new SourceAliasStore(test.db).listNamed('p1')).toEqual(namedSourcesOf(test.db, 'p1'))
  })

  it('is what describe_person names the sources, in English', () => {
    const described = new PersonQuery(test.db, 'p1').describe()
    expect(Object.fromEntries(described.sources.map((s) => [s.id, s.name]))).toEqual(names())
  })

  it('is what an all-time record names its source, with the key beside it', () => {
    test.db.insert(daily).values({
      personId: 'p1', localDate: '2026-09-14', metric: 'steps', agg: 'sum', source: 'merged',
      value: 21_000, coverage: 0.9,
      sourceMix: JSON.stringify([{ source: 'haelan', hours: 20 }]),
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
    expect(readAllTime(test.db, 'p1').records.find((r) => r.metric === 'steps')).toMatchObject({
      sourceName: 'Haelan (phone)',
      sourceDefaultName: { key: 'haelanPhone', since: null, tag: null },
    })

    // Renamed, the record says the alias and carries no default that could outrank it.
    new SourceAliasStore(test.db).put({ personId: 'p1', sourceId: 'haelan', alias: 'My phone', nowMs: 10 })
    expect(readAllTime(test.db, 'p1').records.find((r) => r.metric === 'steps')).toMatchObject({
      sourceName: 'My phone', sourceDefaultName: null,
    })
  })
})
