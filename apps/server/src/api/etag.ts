import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'

/**
 * A weak ETag over a `daily` backed answer, built from the two figures that between them
 * describe it: the newest `updated_at_ms` among the rows it drew on, and how many rows it drew
 * on. Two figures rather than one, because a deletion moves the count without moving any
 * timestamp, and a client refetching only on a timestamp change would keep a row the derivation
 * has dropped.
 */
export function stampEtag(newestMs: number | null, rows: number): string {
  return `W/"${newestMs ?? 'none'}-${rows}"`
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
