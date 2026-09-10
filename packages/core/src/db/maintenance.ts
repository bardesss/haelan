import { statfsSync } from 'node:fs'
import type { Database } from './open.ts'

/** Free pages must be more than this share of the file before a vacuum is worth a stall. */
export const BLOAT_FRACTION = 0.2
/** ...and more than this many bytes, so a small instance never stalls to reclaim a rounding error. */
export const BLOAT_FLOOR_BYTES = 67_108_864
/** VACUUM builds a new file before replacing the old, so the disk must hold both plus room. */
export const DISK_MARGIN = 1.2

export interface DatabaseBloat {
  fileBytes: number
  liveBytes: number
  freeBytes: number
  freeFraction: number
}

/**
 * What the file costs against what it holds.
 *
 * `page_count` is the whole file in pages and `freelist_count` is the part of it SQLite has
 * finished with and kept for reuse. The gap between them is why this unit exists: a delete moves
 * pages from live to free and never changes the size of the file, so an operating system reports
 * 891 MB for a database holding 296 MB.
 */
export function databaseBloat(db: Database): DatabaseBloat {
  const pageSize = db.$client.pragma('page_size', { simple: true }) as number
  const pageCount = db.$client.pragma('page_count', { simple: true }) as number
  const freeCount = db.$client.pragma('freelist_count', { simple: true }) as number
  const fileBytes = pageSize * pageCount
  const freeBytes = pageSize * freeCount
  return {
    fileBytes,
    liveBytes: fileBytes - freeBytes,
    freeBytes,
    freeFraction: pageCount === 0 ? 0 : freeCount / pageCount,
  }
}

/**
 * Bytes available on the filesystem holding `path`.
 *
 * `bavail` rather than `bfree`: the difference is the reserve only root may use, and this process
 * is not root - the image runs as `node`. Reporting space we cannot actually write into is how a
 * disk check passes and the vacuum it guards then fails.
 */
export function freeDiskBytes(path: string): number {
  const stats = statfsSync(path)
  return Number(stats.bavail) * Number(stats.bsize)
}
