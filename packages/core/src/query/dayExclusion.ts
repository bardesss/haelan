import { sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { daily, overrides } from '../db/schema/index.ts'

/**
 * True for a `daily` row unless it is a provider row and its person excluded that metric for
 * that day.
 *
 * A provider row is ingested rather than derived, so derivation cannot rewrite it and no longer
 * deletes it either: deleting it made an exclusion permanent, because removing the override
 * could not bring the figure back until the next sync of that metric. Derived rows are rebuilt
 * without an excluded metric, so only provider rows need this at read time. A derived row is
 * left visible until derivation rebuilds it, so a day that is not yet re-derived is not half-hidden.
 *
 * Correlated over `daily`, so a reader that selects from it adds this to its WHERE. The key is
 * matched with `json_extract` rather than string equality so key formatting never matters.
 */
export function dayMetricNotExcluded(): SQL {
  return sql`(${daily.source} <> 'provider' OR NOT EXISTS (SELECT 1 FROM ${overrides} WHERE ${overrides.personId} = ${daily.personId}
    AND ${overrides.scope} = 'day_metric' AND ${overrides.action} = 'exclude'
    AND json_extract(${overrides.targetKey}, '$.localDate') = ${daily.localDate}
    AND json_extract(${overrides.targetKey}, '$.metric') = ${daily.metric}))`
}
