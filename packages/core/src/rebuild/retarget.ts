import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { overrides, samples, sessions } from '../db/schema/index.ts'
import { SampleKeys } from '../db/keys.ts'
import type { SessionKind } from '../db/schema/index.ts'
import {
  parseSampleTarget, parseSessionTarget, sampleTarget, sessionTarget,
} from '../derive/targetKey.ts'
import type { OverrideScope } from '../derive/targetKey.ts'

export interface OldSession {
  kind: string
  externalId: string
}

export interface RetargetInput {
  personId: string
  /** The identity of each session id the rebuild deleted, captured before it deleted them. */
  oldSessions: ReadonlyMap<string, OldSession>
}

export interface OrphanedOverride {
  id: string
  scope: OverrideScope
  targetKey: string
  reason: string
}

export interface RetargetOutcome {
  retargeted: number
  orphaned: OrphanedOverride[]
}

/**
 * Moves a person's overrides onto the rows a rebuild just regenerated.
 *
 * Re-resolving source identity moves every sample key that names a source and every session id
 * that embeds one, so a rebuild that did nothing here would leave a person's corrections
 * pointing at rows that no longer exist. They would not fail loudly, they would simply stop
 * applying, and a spike somebody threw out would quietly come back.
 *
 * Only unambiguous moves are made. A sample override names an instant, and an instant with
 * exactly one source has exactly one answer, as does one whose own source is still reporting it.
 * Anything else is left where it is and reported, on the grounds that a correction silently
 * applied to the wrong reading is worse than one an operator gets told about.
 */
export function retargetOverrides(tx: DbOrTx, input: RetargetInput): RetargetOutcome {
  const rows = tx.select().from(overrides).where(eq(overrides.personId, input.personId)).all()
  // Every key this person holds, so a move onto an occupied key is refused rather than left to
  // the unique index, which would abort the whole rebuild transaction over one correction.
  const taken = new Set(rows.map((row) => `${row.scope} ${row.targetKey}`))

  const outcome: RetargetOutcome = { retargeted: 0, orphaned: [] }

  // Bound to the caller's transaction, which is the rebuild's own: an override key names a source
  // id and a metric name, and the rows it has to be matched against are keyed on refs.
  const keys = new SampleKeys(tx)

  for (const row of rows) {
    // A day metric key is a local date and a metric. No source, no session, nothing to move.
    if (row.scope === 'day_metric') continue

    const resolved = row.scope === 'sample'
      ? resolveSample(tx, input.personId, row.targetKey, keys)
      : resolveSession(tx, input.personId, row.targetKey, input.oldSessions)

    if (typeof resolved !== 'string') {
      outcome.orphaned.push({
        id: row.id, scope: row.scope, targetKey: row.targetKey, reason: resolved.reason,
      })
      continue
    }
    if (resolved === row.targetKey) continue

    if (taken.has(`${row.scope} ${resolved}`)) {
      outcome.orphaned.push({
        id: row.id, scope: row.scope, targetKey: row.targetKey,
        reason: 'another override already points there',
      })
      continue
    }

    tx.update(overrides).set({ targetKey: resolved }).where(eq(overrides.id, row.id)).run()
    taken.delete(`${row.scope} ${row.targetKey}`)
    taken.add(`${row.scope} ${resolved}`)
    outcome.retargeted++
  }

  return outcome
}

interface Unresolved { reason: string }

function resolveSample(
  tx: DbOrTx, personId: string, targetKey: string, keys: SampleKeys,
): string | Unresolved {
  const target = parseSampleTarget(targetKey)
  // IfKnown, not metricRef: an override can name a metric this person has no sample of at all -
  // one they excluded before a backfill reached it, or one a retired catalogue entry used to
  // produce - and the answer for that is the same "no sample at that instant" the empty query
  // gives, not a new dictionary row written from a rebuild.
  const metricRef = keys.metricRefIfKnown(target.metric)
  if (metricRef === undefined) return { reason: 'no sample at that instant' }

  const rows = tx.select({ sourceRef: samples.sourceRef }).from(samples).where(and(
    eq(samples.personRef, keys.personRef(personId)),
    eq(samples.metricRef, metricRef),
    eq(samples.utcMs, target.utcMs),
  )).all()

  // Distinct sources, not distinct rows. Per minute downsampling writes one row per aggregate
  // at the same instant, and three rows from one watch is still one unambiguous answer.
  const sourceIds = [...new Set(rows.map((row) => keys.sourceId(row.sourceRef)))]
  if (sourceIds.length === 0) return { reason: 'no sample at that instant' }

  // Asked before ambiguity, not after. A phone and a watch on the same platform report the same
  // minute all day, so deciding ambiguity first reported every override on a shared minute as
  // orphaned even though its own source never moved and its correction still applied perfectly.
  // The override was untouched and only the boot log was wrong, which is worse than it sounds:
  // an operator reading that their exclusion no longer applies goes and deletes or re-creates a
  // correction that was working the whole time. Ambiguity is a question about which reading the
  // person meant, and a key whose source is still here has already answered it.
  if (sourceIds.includes(target.source)) {
    return sampleTarget({ source: target.source, metric: target.metric, utcMs: target.utcMs })
  }

  if (sourceIds.length > 1) return { reason: 'two or more sources report that instant' }
  return sampleTarget({ source: sourceIds[0]!, metric: target.metric, utcMs: target.utcMs })
}

function resolveSession(
  tx: DbOrTx, personId: string, targetKey: string, oldSessions: ReadonlyMap<string, OldSession>,
): string | Unresolved {
  const oldId = parseSessionTarget(targetKey)
  // A session that still exists under its old id needs no move: the rebuild reproduced the same
  // source, so it reproduced the same id.
  const old = oldSessions.get(oldId)
  if (old === undefined) return { reason: 'no record of that session before the rebuild' }

  // The external id is the provider's own name for the night, and it is the one part of a
  // session's identity that re-resolving a source cannot move.
  const rows = tx.select({ id: sessions.id }).from(sessions).where(and(
    eq(sessions.personId, personId),
    eq(sessions.kind, old.kind as SessionKind),
    eq(sessions.externalId, old.externalId),
  )).all()

  if (rows.length === 0) return { reason: 'no session with that external id survived' }
  if (rows.length > 1) return { reason: 'two or more sessions share that external id' }
  return sessionTarget(rows[0]!.id)
}
