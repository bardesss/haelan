import BetterSqlite3 from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import type { DbOrTx } from '../db/open.ts'
import { ConfigError } from '../errors.ts'

/**
 * The tables an agent's SQL can see, and the only ones.
 *
 * Seven, and `samples` is deliberately not among them: 2.1 million rows, 85% of the database with
 * its indexes, and the one table whose integer-ref shape is actively hostile to hand-written SQL.
 * Intraday is what `get_intraday` and `get_workout` serve, at the resolution the data holds.
 */
export const PROJECTION_TABLES = [
  'daily', 'sessions', 'session_segments', 'notes', 'events', 'observations', 'sources',
] as const

/**
 * The projection's own schema, written for an agent rather than for the deriver.
 *
 * Three deliberate differences from the real schema, and each is load-bearing:
 *
 * **No `person_id` column, anywhere.** Not filtered per query - absent from the definitions. Its
 * absence is the documentation: there is no person column because there is only one person in the
 * file. A query that writes `WHERE person_id = ...` gets a clear error naming a missing column,
 * which is a better failure than a silent empty result.
 *
 * **Refs resolved to names.** `sessions.source_id` becomes `source_name`. Nothing here requires
 * knowing that `SampleKeys` exists.
 *
 * **`raw_payload_id` dropped.** It points into the tier-1 archive, which is not in this file. A
 * column that can only ever join to nothing is a trap.
 */
const DDL = `
CREATE TABLE daily (
  local_date text, metric text, agg text, source text,
  value real, coverage real, source_mix text, updated_at_ms integer
);
CREATE TABLE sessions (
  id text, source_name text, kind text, external_id text,
  start_ms integer, start_offset_minutes integer,
  end_ms integer, end_offset_minutes integer,
  local_date text, attrs text
);
CREATE TABLE session_segments (
  id text, session_id text, stage text, start_ms integer, end_ms integer
);
CREATE TABLE notes (id text, local_date text, body text, updated_at_ms integer);
CREATE TABLE events (
  id text, kind text, started_at_ms integer, started_at_offset_minutes integer,
  ended_at_ms integer, ended_at_offset_minutes integer, value real, note text
);
CREATE TABLE observations (
  id text, source_name text, kind text, started_at_ms integer, started_at_offset_minutes integer,
  ended_at_ms integer, ended_at_offset_minutes integer, local_date text, value text
);
CREATE TABLE sources (id text, name text, kind text, created_at_ms integer);
CREATE INDEX daily_metric_date ON daily (metric, local_date);
CREATE INDEX sessions_kind_date ON sessions (kind, local_date);
`

/**
 * Writes one person's rows to a fresh SQLite file at `destPath`.
 *
 * Measured at the real instance's scale - 24,463 daily rows across three people, 434 sessions -
 * one person's projection builds in a median 23.7ms at 412KB. That number is why nothing here is
 * cached: at 23.7ms there is nothing to buy and a great deal to lose, namely a cache key, an
 * invalidation on sync, and an agent quietly reading yesterday's data.
 *
 * `journal_mode = OFF` and `synchronous = OFF` because this file is a throwaway: nothing recovers
 * it and nothing reads it after the query that asked for it.
 *
 * The live database is ATTACHed here, by our own text, and that is not in tension with the rule
 * that the caller's SQL can never attach anything. The boundary is which API the caller's string
 * reaches, not whether ATTACH exists - see `apps/server/src/mcp/runSql.ts`.
 */
export function writeProjection(db: DbOrTx, personId: string, destPath: string): void {
  // A stale file from a previous call would otherwise be appended to rather than replaced.
  if (existsSync(destPath)) rmSync(destPath, { force: true })

  // `DbOrTx` omits `$client` on purpose (see open.ts: a transaction handle has none), but every
  // caller of this function reaches it through `PersonQuery`, which is always constructed on a
  // real connection, never a transaction - so the property is there at runtime even though the
  // narrowed type does not carry it. Checked rather than trusted: a future caller that does hand
  // this a transaction handle gets a sentence naming the real problem instead of a bare
  // "Cannot read properties of undefined" three frames inside the security boundary.
  const client = (db as unknown as { $client?: BetterSqlite3.Database }).$client
  if (client === undefined) {
    throw new ConfigError('writeProjection needs a live database connection, not a transaction handle - $client is only present on the former')
  }
  const livePath = client.name
  const out = new BetterSqlite3(destPath)
  try {
    out.pragma('journal_mode = OFF')
    out.pragma('synchronous = OFF')
    out.exec(DDL)
    out.exec(`ATTACH DATABASE '${livePath.replace(/'/g, "''")}' AS live`)
    out.transaction(() => {
      out.prepare(`INSERT INTO daily SELECT local_date, metric, agg, source, value, coverage,
        source_mix, updated_at_ms FROM live.daily WHERE person_id = ?`).run(personId)
      // `src.person_id = ?` in the join, not only the row's own `WHERE`: `sessions.source_id` is
      // a foreign key into `sources.id`, which is a global primary key with no composite
      // constraint tying a session's source to a source owned by the same person. Nothing but an
      // application-level invariant in SourceRegistry keeps them aligned today, and this file
      // cannot see that invariant and must not depend on it - if it were ever violated, an
      // unscoped join would resolve a stranger's `display_name` into this person's projection.
      // One extra clause is the whole cost of not relying on it.
      out.prepare(`INSERT INTO sessions SELECT s.id, src.display_name, s.kind, s.external_id,
        s.start_ms, s.start_offset_minutes, s.end_ms, s.end_offset_minutes, s.local_date, s.attrs
        FROM live.sessions s LEFT JOIN live.sources src ON src.id = s.source_id AND src.person_id = ?
        WHERE s.person_id = ?`).run(personId, personId)
      out.prepare(`INSERT INTO session_segments SELECT g.id, g.session_id, g.stage, g.start_ms, g.end_ms
        FROM live.session_segments g JOIN live.sessions s ON s.id = g.session_id
        WHERE s.person_id = ?`).run(personId)
      out.prepare(`INSERT INTO notes SELECT id, local_date, body, updated_at_ms
        FROM live.notes WHERE person_id = ?`).run(personId)
      out.prepare(`INSERT INTO events SELECT id, kind, started_at_ms, started_at_offset_minutes,
        ended_at_ms, ended_at_offset_minutes, value, note FROM live.events WHERE person_id = ?`).run(personId)
      // Scoped for the same reason as the sessions join above: `observations.source_id` is a
      // foreign key into the global `sources.id`, and only `WHERE o.person_id = ?` filtering the
      // row is not enough to keep the resolved name from crossing a person boundary if the
      // application-level invariant that aligns them ever breaks.
      out.prepare(`INSERT INTO observations SELECT o.id, src.display_name, o.kind, o.started_at_ms,
        o.started_at_offset_minutes, o.ended_at_ms, o.ended_at_offset_minutes, o.local_date, o.value
        FROM live.observations o LEFT JOIN live.sources src ON src.id = o.source_id AND src.person_id = ?
        WHERE o.person_id = ?`).run(personId, personId)
      out.prepare(`INSERT INTO sources SELECT id, display_name, kind, created_at_ms
        FROM live.sources WHERE person_id = ?`).run(personId)
    })()
    out.exec('DETACH DATABASE live')
  } finally {
    // Closed here rather than by the caller: an open handle on Windows makes the file unlinkable,
    // and this function's whole output is a file somebody else is about to open and then delete.
    out.close()
  }
}
