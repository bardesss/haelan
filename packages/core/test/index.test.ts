import { describe, expect, it } from 'vitest'
import * as core from '../src/index.ts'

// Every other test imports by relative path, so this barrel is the package's only integration
// point with server, mcp, cli and web. Nothing else fails if a line is deleted from it.
describe('package barrel', () => {
  it('exports the database lifecycle', () => {
    expect(typeof core.openDatabase).toBe('function')
    expect(typeof core.closeDatabase).toBe('function')
    expect(typeof core.tableExists).toBe('function')
    expect(typeof core.DATABASE_FILENAME).toBe('string')
    expect(typeof core.migrateToLatest).toBe('function')
  })

  it('exports the schema namespace', () => {
    expect(typeof core.schema).toBe('object')
    expect(core.schema.people).toBeDefined()
    expect(core.schema.sources).toBeDefined()
    expect(core.schema.oauthClient).toBeDefined()
    expect(core.schema.credentials).toBeDefined()
    expect(core.schema.notes).toBeDefined()
    expect(core.schema.events).toBeDefined()
    expect(core.schema.overrides).toBeDefined()
    expect(core.schema.rawPayloads).toBeDefined()
    expect(core.schema.samples).toBeDefined()
    expect(core.schema.sessions).toBeDefined()
    expect(core.schema.sessionSegments).toBeDefined()
    expect(core.schema.daily).toBeDefined()
    expect(core.schema.syncState).toBeDefined()
  })

  it('exports the crypto primitives', () => {
    expect(typeof core.loadOrCreateKey).toBe('function')
    expect(typeof core.KEY_FILENAME).toBe('string')
    expect(typeof core.KEY_ENV_VAR).toBe('string')
    expect(typeof core.seal).toBe('function')
    expect(typeof core.unseal).toBe('function')
  })

  it('exports the store classes', () => {
    expect(typeof core.CredentialStore).toBe('function')
    expect(typeof core.RawArchive).toBe('function')
  })

  it('exports the test fixtures', () => {
    expect(typeof core.createTestDatabase).toBe('function')
    expect(typeof core.seedPerson).toBe('function')
  })
})
