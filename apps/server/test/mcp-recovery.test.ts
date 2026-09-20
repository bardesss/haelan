import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { PersonQuery, createTestDatabase, seedPerson, schema, DERIVATION_VERSION } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { recoveryIndexTool } from '../src/mcp/tools/recovery.ts'

describe('recovery_index tool', () => {
  it('declares the person bound window parameters and nothing else', () => {
    expect(recoveryIndexTool.name).toBe('recovery_index')
    // `inputSchema` is the bare ZodRawShape a tool is declared with (see `Tool` in contract.ts),
    // not a `z.object(...)` instance - so its keys are read directly, the same way
    // mcp-tools.test.ts checks `'sourceId' in t.inputSchema` elsewhere in this suite. The brief's
    // own snippet read `.inputSchema.properties`, which is undefined on this shape.
    expect(Object.keys(recoveryIndexTool.inputSchema).sort()).toEqual(['from', 'to'])
  })
})

describe('recovery_index tool, hrvFilled', () => {
  let test: TestDatabase
  beforeEach(() => {
    test = createTestDatabase()
    seedPerson(test.db, 'robin', { displayName: 'Robin', timezone: 'Europe/Amsterdam' })
  })
  afterEach(() => test.cleanup())

  function seedDaily(input: { localDate: string, value: number, metric: string, agg: string }): void {
    test.db.insert(schema.daily).values({
      personId: 'robin', localDate: input.localDate, metric: input.metric, agg: input.agg,
      source: 'merged', value: input.value, coverage: null, sourceMix: null,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
  }

  // A language model reading recovery_index cannot see the dashed line the web app draws for a
  // filled daily_hrv point, and HRV is the only one of the four recovery inputs
  // DEVICE_ROLLED_EQUIVALENT can ever fall back for (packages/core/src/query/personQuery.ts) - the
  // reason this task singles recovery_index out rather than leaving it parked with the other three
  // aggregate tools again. Exercised through the real fallback, the same reason
  // v1-export.test.ts's and mcp-tools.test.ts's own filled cases seed hrv/mean rather than
  // asserting the field in isolation.
  it('counts a daily_hrv day pulled from the intraday fallback among the filled, and a genuine one not', () => {
    seedDaily({ localDate: '2026-08-01', metric: 'hrv', agg: 'mean', value: 42 })
    seedDaily({ localDate: '2026-08-02', metric: 'daily_hrv', agg: 'last', value: 55 })

    const out = recoveryIndexTool.run(new PersonQuery(test.db, 'robin'), {
      from: '2026-08-02', to: '2026-08-02',
    }) as { hrvFilled: { filled: number, of: number } }

    expect(out.hrvFilled).toEqual({ filled: 1, of: 2 })
  })

  it('answers zero filled of zero when there is no HRV history at all', () => {
    const out = recoveryIndexTool.run(new PersonQuery(test.db, 'robin'), {
      from: '2026-08-02', to: '2026-08-02',
    }) as { hrvFilled: { filled: number, of: number } }

    expect(out.hrvFilled).toEqual({ filled: 0, of: 0 })
  })
})
