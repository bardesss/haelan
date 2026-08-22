import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import { sourcePriority } from '../src/db/schema/index.ts'

describe('source_priority', () => {
  it('is keyed by person, metric and source, so one rank per source per list is enforced rather than assumed', () => {
    const pk = getTableConfig(sourcePriority).primaryKeys[0]
    expect(pk?.columns.map((c) => c.name)).toEqual(['person_id', 'metric', 'source_id'])
  })

  it('references both people and sources, so a rank pointing at a source that went away fails at the constraint', () => {
    expect(getTableConfig(sourcePriority).foreignKeys).toHaveLength(2)
  })
})
