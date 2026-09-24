import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { SettingsStore } from '../src/store/settings.ts'

let fixture: TestDatabase
let settings: SettingsStore

// A restart used to forget when the last sync finished: the runner kept it in memory only, so
// every boot read "never synced" until the next run ended.
describe('SettingsStore last sync', () => {
  beforeEach(() => {
    fixture = createTestDatabase()
    seedPerson(fixture.db, 'p1')
    settings = new SettingsStore(fixture.db)
    // put() is what setup writes on the instance-url step; lastSync/putLastSync update that row
    // rather than creating one, so a test of them needs the row to already exist the way it would
    // on a real instance.
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 0 })
  })
  afterEach(() => fixture.cleanup())

  it('answers null before any run has finished', () => {
    expect(settings.lastSync()).toBeNull()
  })

  it('reads back the run it was given', () => {
    settings.putLastSync({ finishedAtMs: 1_000, rowsWritten: 12, failed: 1 }, 1_000)
    expect(settings.lastSync()).toEqual({ finishedAtMs: 1_000, rowsWritten: 12, failed: 1 })
  })

  it('keeps only the latest run', () => {
    settings.putLastSync({ finishedAtMs: 1_000, rowsWritten: 12, failed: 1 }, 1_000)
    settings.putLastSync({ finishedAtMs: 2_000, rowsWritten: 0, failed: 0 }, 2_000)
    expect(settings.lastSync()).toEqual({ finishedAtMs: 2_000, rowsWritten: 0, failed: 0 })
  })
})
