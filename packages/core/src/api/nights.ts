/**
 * One night per local date, when two sources recorded the same night.
 *
 * Moved here from apps/web/src/data/nights.ts for M9, because the glance payload needs the same
 * rule on the server and the native app would otherwise need a Kotlin copy of it. Browser-safe:
 * no import reaches the database, so apps/web keeps importing it through `@haelan/core/nights`.
 *
 * /sleep/nights returns one row per (localDate, sourceId), so two sources reporting sleep on the
 * same date is two rows for what is, to a reader, one night. Collapsed to one per date with a
 * stated rule rather than left to whatever order the route happens to return: the longest
 * duration entry wins, since a second device capturing the same night is more likely to hold a
 * shorter, partial recording than the source that actually stayed on through it.
 */
export function oneNightPerDate<T extends { localDate: string, startMs: number, endMs: number }>(
  items: readonly T[],
): T[] {
  const byDate = new Map<string, T>()
  for (const n of items) {
    const existing = byDate.get(n.localDate)
    if (existing === undefined || (n.endMs - n.startMs) > (existing.endMs - existing.startMs)) {
      byDate.set(n.localDate, n)
    }
  }
  return [...byDate.values()].sort((a, b) => a.localDate.localeCompare(b.localDate))
}
