import { eq } from 'drizzle-orm'
import type { DbOrTx } from './open.ts'
import { metricDictionary, people, sources, rawPayloads } from './schema/index.ts'
import { ConfigError } from '../errors.ts'

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
    const cached = this.#metricRefByName.get(name)
    if (cached !== undefined) return cached

    const existing = this.#db.select({ ref: metricDictionary.ref }).from(metricDictionary)
      .where(eq(metricDictionary.name, name)).get()
    if (existing) {
      this.#cacheMetric(name, existing.ref)
      return existing.ref
    }

    const inserted = this.#db.insert(metricDictionary).values({ name })
      .onConflictDoNothing().returning({ ref: metricDictionary.ref }).get()
    const ref = inserted ?? this.#db.select({ ref: metricDictionary.ref }).from(metricDictionary)
      .where(eq(metricDictionary.name, name)).get()
    if (!ref) throw new ConfigError(`metric '${name}' was inserted and then vanished`)
    this.#cacheMetric(name, ref.ref)
    return ref.ref
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
    const cached = cache.get(id)
    if (cached !== undefined) return cached

    const row = lookup(id)
    if (!row) throw new ConfigError(`no ${label} for id ${id}`)
    cache.set(id, row.ref)
    reverseCache.set(row.ref, id)
    return row.ref
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
