import { getTableColumns } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

export { people, sources, sourcePriority, sourceAliases, sourcePanelVisibility } from './people.ts'
export { oauthClient, credentials } from './credentials.ts'
export { notes, events, overrides } from './annotations.ts'
export { rawPayloads } from './raw.ts'
export {
  samples, sessions, sessionSegments, sessionRoutes, daily, observations, metricDictionary,
  SAMPLE_AGGS, SAMPLE_AGG_REFS, sampleAggOf, SESSION_KINDS,
} from './derived.ts'
export type { SampleAgg, SessionKind } from './derived.ts'
export { syncState, deriveQueue, excludedDataTypes, rebuildState, rebuildDrops } from './sync.ts'
export {
  accounts, authSessions, instanceSettings, invites, mcpTokens, mcpCalls,
  CONSENT_PATHS, MCP_CALL_OUTCOMES, MCP_TOKEN_REVOKE_REASONS,
} from './accounts.ts'
export type { ConsentPath, McpCallOutcome, McpTokenRevokeReason } from './accounts.ts'

/**
 * Every column of a table that declares a default, as database column name to that default written
 * as text. The two disagreeing is the defect this exists to make visible: a `default(480)` in a
 * schema module and a `DEFAULT 480` in a migration are two literals in two files, nothing generated
 * keeps them in step, and a column whose default moves without a new migration leaves every already
 * migrated database carrying the old number while every freshly created one carries the new.
 *
 * Here rather than in apps/server, which is where its one caller (the upgrade rehearsal) lives:
 * reading a table's declared defaults is drizzle's own column metadata, and the server app reaches
 * core only through the root export rather than depending on drizzle directly. A test that imported
 * drizzle for itself would be the first crack in that.
 */
export function declaredColumnDefaults(table: SQLiteTable): Map<string, string> {
  const entries = Object.values(getTableColumns(table))
    .filter((column) => column.hasDefault)
    .map((column) => [column.name, String(column.default)] as const)
  return new Map(entries)
}
