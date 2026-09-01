import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'

/** One window's contribution to a `daily` backed ETag. See stampEtag. */
export interface Stamp {
  /** The newest `updated_at_ms` among the rows, or null where not one of them carries a stamp. */
  newestMs: number | null
  rows: number
}

/**
 * Bumped whenever a stamped route (anything answered through `stampEtag`: /series, /baselines,
 * /insights, /trend) starts serializing the SAME rows, under the SAME stamp and row count,
 * differently than before -- which `newestMs` and `rows` have no way to express on their own,
 * since neither one moves when the change is in how a value is shown rather than in which rows
 * exist. This task is the first such change: rounding at the response boundary means a client
 * holding an ETag computed before this shipped would revalidate, match on stamp and row count
 * alone, and be told 304 to keep the old, unrounded body forever, since nothing about the
 * underlying row ever needs to move again for that client to notice. Folding this constant into
 * the basis makes that old validator fail to match exactly once, on the deploy that bumped it,
 * and costs nothing on every request after: the ETag is still built from the stamp and the count
 * alone, with one more fixed term joined in. Bump this again the next time a stamped route's
 * serialization changes independently of what `newestMs`/`rows` can see; leave it alone for a
 * change that only touches routes answered through `hashEtag` instead, which already hashes the
 * exact body it sends and has no equivalent gap.
 */
export const SERIALIZATION_VERSION = 1

/**
 * A weak ETag over a `daily` backed answer, built from the two figures that between them
 * describe it: the newest `updated_at_ms` among the rows it drew on, and how many rows it drew
 * on. Two figures rather than one, because a deletion moves the count without moving any
 * timestamp, and a client refetching only on a timestamp change would keep a row the derivation
 * has dropped. A third, fixed term, `SERIALIZATION_VERSION`, joins every validator this builds:
 * see its own comment for what it guards against that the other two cannot.
 *
 * One pair per window, rendered in order and joined, for an answer that drew on more than one:
 * /series answers a window per metric and /insights two periods. Folding them into a single pair
 * first, by taking the newest stamp and adding the counts, let one window's loss cancel
 * another's gain: two metrics where one lost a row and the other gained one on an equal or older
 * stamp summed to the same count under the same maximum, so the validator did not move and a
 * client kept a body that had changed. A single window renders exactly as it did before (aside
 * from the version prefix every render now carries), so the routes that read one are otherwise
 * unaffected.
 */
export function stampEtag(windows: readonly Stamp[]): string {
  // No caller passes an empty list today: every route folds in at least its own window. Rendered
  // as one empty window rather than as an empty string, so the validator stays the shape the
  // comparison below strips a `W/` off.
  const parts = windows.length === 0 ? [{ newestMs: null, rows: 0 }] : windows
  const body = parts.map((part) => `${part.newestMs ?? 'none'}-${part.rows}`).join('.')
  return `W/"v${SERIALIZATION_VERSION}.${body}"`
}

/**
 * A weak ETag over a response with no `updated_at_ms` to read at all: `samples`, `sessions` and
 * `session_segments` carry no such column. Hashes exactly what the caller passes, so it must be
 * called on the assembled response body, after any thinning or pagination, not on the rows that
 * fed it: hashing the rows would let two differently shaped responses share an ETag.
 */
export function hashEtag(body: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  return `W/"${digest.slice(0, 32)}"`
}

/**
 * Whether the request already names this ETag in `If-None-Match`. Compares weakly throughout,
 * since both bases above only ever emit weak validators and RFC 9110's weak comparison ignores
 * the `W/` prefix on either side.
 */
export function notModified(request: FastifyRequest, etag: string): boolean {
  const header = request.headers['if-none-match']
  if (header === undefined) return false
  if (header.trim() === '*') return true
  const wanted = stripWeak(etag)
  return header.split(',').some((candidate) => stripWeak(candidate.trim()) === wanted)
}

function stripWeak(value: string): string {
  return value.startsWith('W/') ? value.slice(2) : value
}
