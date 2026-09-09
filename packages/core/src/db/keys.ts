import { eq } from 'drizzle-orm'
import type { DbOrTx } from './open.ts'
import {
  metricDictionary, people, sources, rawPayloads, samples, SAMPLE_AGG_REFS, sampleAggOf,
} from './schema/index.ts'
import type { SampleAgg } from './schema/index.ts'
import { ConfigError } from '../errors.ts'

/**
 * A `samples` row spelled the way everything outside the table still speaks of it: a metric name,
 * three text ids and an aggregate name.
 *
 * The mappers produce this shape (`SampleRow` in api/mapSamples.ts is assignable to it), the
 * derivation and the readers consume it, and `samples` is the only place the refs exist at all.
 * That is deliberate: making the mapping layer speak refs would put a database concern in code
 * whose whole job is reading a provider's JSON, and would need a `SampleKeys` in every one of its
 * tests.
 */
export interface SampleText {
  personId: string
  sourceId: string
  metric: string
  utcMs: number
  tzOffsetMinutes: number
  agg: SampleAgg
  value: number | null
  n: number
  rawPayloadId: string | null
}

/**
 * Translates between the five text identifiers `samples` used to repeat in every one of its 1.6
 * million rows - a metric name, and the id of a person, a source and a raw payload - and the
 * narrow integer `ref` each of their tables now carries alongside its text id.
 *
 * Same shape as SourceRegistry, which this deliberately resembles rather than reinvents:
 * resolve-or-insert with a per-instance cache. The difference is that a person, a source and a raw
 * payload all exist by the time this class is asked for their ref - something else created the
 * row - so those three only resolve. A metric name is the exception: this class is what the
 * dictionary has, so `metricRef` inserts on first sight, and widening the derivation catalogue
 * needs no migration.
 *
 * The cache is why this is a class rather than four functions. `deriveDay` reads a person's whole
 * window and groups by metric, so `metricName` is called once per row over 1.6 million rows during
 * a rebuild; a select per call would make the rebuild slower than the columns it replaces. The
 * cache is both directions - name-to-ref and ref-to-name, and likewise for the other three - so
 * whichever direction a caller needs is equally cheap on the second ask.
 *
 * Transaction-scoped, not shared: construct one per transaction rather than reusing a long-lived
 * instance across one. A transaction that rolls back takes the rows it inserted with it while a
 * shared cache would keep pointing at them, and a later write through that stale instance would
 * then either fail a foreign key or, for a metric ref, silently answer a name for a ref the
 * dictionary no longer has. SourceRegistry meets the same hazard with `forget`; this class meets
 * it by never outliving the transaction that might roll back underneath it.
 */
export class SampleKeys {
  readonly #db: DbOrTx

  readonly #metricRefByName = new Map<string, number>()
  readonly #metricNameByRef = new Map<number, string>()
  readonly #personRefById = new Map<string, number>()
  readonly #personIdByRef = new Map<number, string>()
  readonly #sourceRefById = new Map<string, number>()
  readonly #sourceIdByRef = new Map<number, string>()
  readonly #rawPayloadRefById = new Map<string, number>()
  readonly #rawPayloadIdByRef = new Map<number, string>()

  constructor(db: DbOrTx) { this.#db = db }

  /**
   * Assigns on first sight: a metric name the dictionary has never stored gets a new row. Unlike
   * people, sources and raw_payloads, `metricDictionary.ref` is a real AUTOINCREMENT primary key
   * rather than a placeholder overwritten by an AFTER INSERT trigger, so RETURNING here answers
   * the ref the insert actually assigned. `onConflictDoNothing` is still worth keeping, the same
   * way SourceRegistry keeps it: it costs nothing on the common path and turns a race with another
   * writer into a second select instead of a thrown unique-constraint error.
   */
  metricRef(name: string): number {
    const existing = this.metricRefIfKnown(name)
    if (existing !== undefined) return existing

    const inserted = this.#db.insert(metricDictionary).values({ name })
      .onConflictDoNothing().returning({ ref: metricDictionary.ref }).get()
    const ref = inserted ?? this.#db.select({ ref: metricDictionary.ref }).from(metricDictionary)
      .where(eq(metricDictionary.name, name)).get()
    if (!ref) throw new ConfigError(`metric '${name}' was inserted and then vanished`)
    this.#cacheMetric(name, ref.ref)
    return ref.ref
  }

  /**
   * `metricRef` without the insert: answers undefined for a name the dictionary has never seen.
   *
   * The read paths need this. `readIntraday` and `OverrideStore` are both handed a metric name
   * that came from a URL or from an override's target key, and a name with no dictionary row is
   * simply a name with no samples - an ordinary answer, not a reason to write. Calling `metricRef`
   * there would turn every read of an unknown metric into an insert, which is a write on a GET
   * and an unbounded row source pointed at by whatever a client puts in a query string.
   *
   * A miss is deliberately not cached. Nothing here stops the same transaction inserting that
   * metric a moment later, and a remembered "no" would then be wrong for the rest of the
   * instance's life.
   */
  metricRefIfKnown(name: string): number | undefined {
    const cached = this.#metricRefByName.get(name)
    if (cached !== undefined) return cached

    const row = this.#db.select({ ref: metricDictionary.ref }).from(metricDictionary)
      .where(eq(metricDictionary.name, name)).get()
    if (!row) return undefined
    this.#cacheMetric(name, row.ref)
    return row.ref
  }

  /**
   * Throws `ConfigError` rather than returning `undefined` for a ref nothing assigned: a caller
   * that forgot to check would otherwise render a chart with an empty metric name instead of
   * failing loudly.
   */
  metricName(ref: number): string {
    const cached = this.#metricNameByRef.get(ref)
    if (cached !== undefined) return cached

    const row = this.#db.select({ name: metricDictionary.name }).from(metricDictionary)
      .where(eq(metricDictionary.ref, ref)).get()
    if (!row) throw new ConfigError(`no metric for ref ${ref}`)
    this.#cacheMetric(row.name, ref)
    return row.name
  }

  #cacheMetric(name: string, ref: number): void {
    this.#metricRefByName.set(name, ref)
    this.#metricNameByRef.set(ref, name)
  }

  personRef(id: string): number {
    return this.#resolveRef(
      this.#personRefById, this.#personIdByRef,
      (i) => this.#db.select({ ref: people.ref }).from(people).where(eq(people.id, i)).get(),
      id, 'person',
    )
  }

  /**
   * `personRef` without the throw, for the same reason `metricRefIfKnown` exists. A person id that
   * names no row is how the readers and the override store express "not yours, or not here yet":
   * `affectedLocalDate` is asked about a person id that came from a request, and answering null
   * for a stranger is the isolation guarantee, not a fault to raise. Misses are not cached.
   */
  personRefIfKnown(id: string): number | undefined {
    return this.#lookupRef(
      this.#personRefById, this.#personIdByRef,
      (i) => this.#db.select({ ref: people.ref }).from(people).where(eq(people.id, i)).get(),
      id,
    )
  }

  personId(ref: number): string {
    return this.#resolveId(
      this.#personIdByRef, this.#personRefById,
      (r) => this.#db.select({ id: people.id }).from(people).where(eq(people.ref, r)).get(),
      ref, 'person',
    )
  }

  sourceRef(id: string): number {
    return this.#resolveRef(
      this.#sourceRefById, this.#sourceIdByRef,
      (i) => this.#db.select({ ref: sources.ref }).from(sources).where(eq(sources.id, i)).get(),
      id, 'source',
    )
  }

  /**
   * `sourceRef` without the throw, for the same reason `metricRefIfKnown` exists: an override's
   * target key names a source id, and a person may write an override for a day a backfill has
   * not reached, so a source id with no row is an ordinary answer there rather than a fault.
   * Misses are not cached; see `metricRefIfKnown`.
   */
  sourceRefIfKnown(id: string): number | undefined {
    return this.#lookupRef(
      this.#sourceRefById, this.#sourceIdByRef,
      (i) => this.#db.select({ ref: sources.ref }).from(sources).where(eq(sources.id, i)).get(),
      id,
    )
  }

  sourceId(ref: number): string {
    return this.#resolveId(
      this.#sourceIdByRef, this.#sourceRefById,
      (r) => this.#db.select({ id: sources.id }).from(sources).where(eq(sources.ref, r)).get(),
      ref, 'source',
    )
  }

  rawPayloadRef(id: string): number {
    return this.#resolveRef(
      this.#rawPayloadRefById, this.#rawPayloadIdByRef,
      (i) => this.#db.select({ ref: rawPayloads.ref }).from(rawPayloads).where(eq(rawPayloads.id, i)).get(),
      id, 'raw payload',
    )
  }

  rawPayloadId(ref: number): string {
    return this.#resolveId(
      this.#rawPayloadIdByRef, this.#rawPayloadRefById,
      (r) => this.#db.select({ id: rawPayloads.id }).from(rawPayloads).where(eq(rawPayloads.ref, r)).get(),
      ref, 'raw payload',
    )
  }

  /**
   * Shared by personRef, sourceRef and rawPayloadRef: check the cache, else look the row up with
   * the closure the caller supplies, cache both directions, or throw. These three never insert -
   * something else already created the row - so, unlike metricRef, there is no third branch.
   */
  #resolveRef(
    cache: Map<string, number>, reverseCache: Map<number, string>,
    lookup: (id: string) => { ref: number } | undefined,
    id: string, label: string,
  ): number {
    const ref = this.#lookupRef(cache, reverseCache, lookup, id)
    if (ref === undefined) throw new ConfigError(`no ${label} for id ${id}`)
    return ref
  }

  /** #resolveRef without the throw, and what the `IfKnown` readers above are built from. */
  #lookupRef(
    cache: Map<string, number>, reverseCache: Map<number, string>,
    lookup: (id: string) => { ref: number } | undefined,
    id: string,
  ): number | undefined {
    const cached = cache.get(id)
    if (cached !== undefined) return cached

    const row = lookup(id)
    if (!row) return undefined
    cache.set(id, row.ref)
    reverseCache.set(row.ref, id)
    return row.ref
  }

  /**
   * A whole sample row, text in and refs out - the shape `samples` is written in.
   *
   * Here rather than spelled out at each writer because the two writers (`runJob` and the rebuild
   * `replay`) have to agree exactly: a row translated one way at ingest and another way at replay
   * would upsert onto a different natural key and quietly double the table on the first rebuild.
   * `metricRef` assigns on first sight, so a metric the catalogue grew since the last release
   * needs no migration to be writable.
   */
  sampleRefs(row: SampleText): typeof samples.$inferInsert {
    return {
      personRef: this.personRef(row.personId),
      sourceRef: this.sourceRef(row.sourceId),
      metricRef: this.metricRef(row.metric),
      utcMs: row.utcMs,
      tzOffsetMinutes: row.tzOffsetMinutes,
      aggRef: SAMPLE_AGG_REFS[row.agg],
      value: row.value,
      n: row.n,
      rawPayloadRef: row.rawPayloadId === null ? null : this.rawPayloadRef(row.rawPayloadId),
    }
  }

  /**
   * The reverse: a stored row back into names, for the derivation and the readers, which key
   * overrides and priority lists on the text a person actually typed.
   */
  sampleText(row: typeof samples.$inferSelect): SampleText {
    const agg = sampleAggOf(row.aggRef)
    // Not a defensive check that cannot fire: a database written by a newer release can carry an
    // aggregate this one has no name for, and the alternative to throwing is charting a stranger's
    // number under whichever name happened to be first in the map.
    if (agg === undefined) throw new ConfigError(`no sample aggregate for ref ${row.aggRef}`)
    return {
      personId: this.personId(row.personRef),
      sourceId: this.sourceId(row.sourceRef),
      metric: this.metricName(row.metricRef),
      utcMs: row.utcMs,
      tzOffsetMinutes: row.tzOffsetMinutes,
      agg,
      value: row.value,
      n: row.n,
      rawPayloadId: row.rawPayloadRef === null ? null : this.rawPayloadId(row.rawPayloadRef),
    }
  }

  /** The reverse of #resolveRef: ref to id. */
  #resolveId(
    cache: Map<number, string>, reverseCache: Map<string, number>,
    lookup: (ref: number) => { id: string } | undefined,
    ref: number, label: string,
  ): string {
    const cached = cache.get(ref)
    if (cached !== undefined) return cached

    const row = lookup(ref)
    if (!row) throw new ConfigError(`no ${label} for ref ${ref}`)
    cache.set(ref, row.id)
    reverseCache.set(row.id, ref)
    return row.id
  }
}
