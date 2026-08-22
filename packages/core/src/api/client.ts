import type { RawArchive } from '../store/rawArchive.ts'
import type { DataType } from './catalogue.ts'
import { supports } from './catalogue.ts'
import { readEnvelope } from './envelope.ts'
import { ConfigError, HaelanError, SchemaDriftError, TransientError, classifyHttp } from '../errors.ts'

const API_ROOT = 'https://health.googleapis.com/v4'
const PAGE_SIZE = 10_000
const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 500
// volume.md's densest measured real day needed eight pages. Low hundreds is generous headroom
// while still catching a nextPageToken that never advances before it archives forever.
const MAX_PAGES = 200

export interface RollupInput {
  personId: string
  dataType: DataType
  /** Inclusive, `YYYY-MM-DD`. */
  fromLocalDate: string
  /**
   * Exclusive, `YYYY-MM-DD`. A walk whose `toLocalDate` is today's date therefore never requests
   * today itself, so today's provider row does not exist until tomorrow's run asks for it.
   */
  toLocalDate: string
}

export interface RollupResult { payloadId: string }

const civilRange = (localDate: string) => {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number]
  return { date: { year, month, day } }
}

export interface ListInput {
  personId: string
  dataType: DataType
  windowStartMs: number
  windowEndMs: number
  /** IANA zone name, e.g. 'Europe/Amsterdam'. Required: see buildFilter. */
  timezone: string
}

export interface ListResult {
  payloadIds: string[]
  pointCount: number
  /**
   * Pages whose body was not a shape this code knows. Distinct from a page carrying no points:
   * a quiet window and a renamed `dataPoints` both count zero, and only this separates them.
   * runJob withholds its high-water mark while this is non-zero.
   */
  unreadablePages: number
  pagesFetched: number
  /** Fetch attempts across every page, including the ones a backoff retried. */
  attempts: number
  /**
   * The status of the most recent response that triggered a backoff, or null if none did.
   * Null with `attempts` above `pagesFetched` means the retries were on the token endpoint,
   * which answers with no data plane status of its own.
   */
  lastRetriedStatus: number | null
}

export interface ClientDeps {
  fetch: typeof globalThis.fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Defaults to Math.random. Overridable so a test can pin or compare jitter sequences. */
  random: () => number
  /** Defaults to Google's v4 root. Overridable so a test can point the client at a stub. */
  apiRoot?: string
}

interface Tokens { accessTokenFor(personId: string): Promise<string> }

const iso = (ms: number) => new Date(ms).toISOString()

// en-CA yields ISO ordered parts (year, month, day), so formatToParts assembles a civil
// date and time without string-slicing a UTC instant and without a date library.
function civilParts(ms: number, timeZone: string): { date: string, time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(ms)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}:${get('second')}` }
}

const day = (ms: number, timeZone: string) => civilParts(ms, timeZone).date
const civil = (ms: number, timeZone: string) => {
  const { date, time } = civilParts(ms, timeZone)
  return `${date}T${time}`
}

function buildFilter(t: DataType, startMs: number, endMs: number, timezone: string): string {
  // Unreachable through listDataPoints, which refuses a type that does not support list before
  // it gets here. Stated rather than assumed, because the alternative to a null member is the
  // string "null" inside a filter the API would reject with a message about grammar.
  if (t.filterMember === null) {
    throw new ConfigError(`${t.id} has no filter member: it answers ${t.actions.join(', ')}, and none of those takes a filter`)
  }
  const member = `${t.filterRoot}.${t.filterMember}`
  // date and interval.civil_start_time carry no offset, so the same instant names a different
  // day depending on where the person is. iso is an absolute instant and is zone independent.
  const fmt = t.filterMember === 'date' ? (ms: number) => day(ms, timezone)
    : t.filterMember === 'interval.civil_start_time' ? (ms: number) => civil(ms, timezone)
    : iso
  return `${member} >= "${fmt(startMs)}" AND ${member} < "${fmt(endMs)}"`
}

export class HealthClient {
  readonly #tokens: Tokens
  readonly #archive: RawArchive
  readonly #deps: ClientDeps

  constructor(
    tokens: Tokens,
    archive: RawArchive,
    deps: ClientDeps = {
      fetch: globalThis.fetch,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
    },
  ) {
    this.#tokens = tokens
    this.#archive = archive
    this.#deps = deps
  }

  async listDataPoints(input: ListInput): Promise<ListResult> {
    const { dataType: t } = input
    if (!supports(t, 'list')) {
      throw new ConfigError(`${t.id} does not support list, only ${t.actions.join(', ')}`)
    }
    // A reversed or empty window builds a filter that is always false. The API would answer it
    // with a legitimate looking empty page, and an empty page recorded as "no data" for a range
    // never actually queried is a wrong answer a rebuild has no way to tell from a real one.
    if (input.windowStartMs >= input.windowEndMs) {
      throw new ConfigError(`window must be ordered and non-empty: start ${input.windowStartMs}, end ${input.windowEndMs}`)
    }

    const filter = buildFilter(t, input.windowStartMs, input.windowEndMs, input.timezone)
    const payloadIds: string[] = []
    let pointCount = 0
    let unreadablePages = 0
    let pagesFetched = 0
    let attempts = 0
    let lastRetriedStatus: number | null = null
    let pageToken: string | undefined

    do {
      // A nextPageToken that never advances would otherwise archive and grow payloadIds
      // forever. In M1c this runs unattended, so a hang here is worse than a thrown error.
      if (pagesFetched >= MAX_PAGES) {
        throw new TransientError(`${t.id} exceeded ${MAX_PAGES} pages without exhausting pagination`)
      }

      const url = new URL(`${this.#deps.apiRoot ?? API_ROOT}/users/me/dataTypes/${t.id}/dataPoints`)
      url.searchParams.set('filter', filter)
      url.searchParams.set('pageSize', String(PAGE_SIZE))
      if (pageToken) url.searchParams.set('pageToken', pageToken)

      const fetched = await this.fetchWithRetry(url, input.personId)
      const { body, status } = fetched
      // Carried out rather than discarded: the retried bodies are deliberately not archived, so
      // sync_state.last_error is the only place the episode can be recorded at all.
      attempts += fetched.attempts
      if (fetched.retriedStatus !== null) lastRetriedStatus = fetched.retriedStatus

      // Archived before parsing, so a payload Google changed the shape of is kept as evidence
      // rather than lost with the exception. Spec section 13, schema drift.
      const { id } = this.#archive.put({
        personId: input.personId,
        dataType: t.id,
        requestParams: { filter, pageSize: PAGE_SIZE, pageToken: pageToken ?? null },
        windowStartMs: input.windowStartMs,
        windowEndMs: input.windowEndMs,
        fetchedAtMs: this.#deps.now(),
        httpStatus: status,
        body,
      })

      if (status !== 200) {
        const message = `${status} listing ${t.id}: ${body.slice(0, 200)}`
        throw classifyHttp(status) === 'transient' ? new TransientError(message) : new SchemaDriftError(message)
      }

      payloadIds.push(id)
      pagesFetched++

      // A 200 whose body is not JSON, an HTML proxy error page, say, is already archived above,
      // so the evidence survives. The run continues rather than dying to a SyntaxError, but the
      // page is counted as unreadable: continuing is not the same as understanding, and the old
      // code conflated the two by folding it into a zero point count.
      const envelope = readEnvelope(body, 'dataPoints')
      if (envelope.readable) pointCount += envelope.points.length
      else unreadablePages += 1

      // A body we could not read carries no token we would trust, so pagination ends here and
      // the window is reported unreadable rather than followed into a shape we do not know.
      const token = envelope.readable ? envelope.body['nextPageToken'] : undefined
      pageToken = typeof token === 'string' ? token : undefined
    } while (pageToken)

    return { payloadIds, pointCount, unreadablePages, pagesFetched, attempts, lastRetriedStatus }
  }

  /**
   * The rollup read. It takes a civil interval rather than a filter, and it does not paginate:
   * `pageSize` is a floor the request must clear, not a page size, so the per type range cap is
   * the only lever a walk has. Measured in probe/findings/rollup-methods.md.
   */
  async dailyRollUpDataPoints(input: RollupInput): Promise<RollupResult> {
    const t = input.dataType
    if (!supports(t, 'dailyRollUp')) {
      throw new ConfigError(`${t.id} does not support dailyRollUp, only ${t.actions.join(', ')}`)
    }
    const url = new URL(`${this.#deps.apiRoot ?? API_ROOT}/users/me/dataTypes/${t.id}/dataPoints:dailyRollUp`)
    const request = {
      range: { start: civilRange(input.fromLocalDate), end: civilRange(input.toLocalDate) },
    }
    const fetched = await this.fetchWithRetry(url, input.personId, { method: 'POST', body: request })
    const { id } = this.#archive.put({
      personId: input.personId,
      dataType: t.id,
      requestParams: request,
      windowStartMs: Date.parse(`${input.fromLocalDate}T00:00:00Z`),
      windowEndMs: Date.parse(`${input.toLocalDate}T00:00:00Z`),
      fetchedAtMs: this.#deps.now(),
      httpStatus: fetched.status,
      body: fetched.body,
    })
    if (fetched.status !== 200) {
      const message = `${fetched.status} rolling up ${t.id}: ${fetched.body.slice(0, 200)}`
      throw classifyHttp(fetched.status) === 'transient'
        ? new TransientError(message)
        : new SchemaDriftError(message)
    }
    return { payloadId: id }
  }

  private async fetchWithRetry(url: URL, personId: string, init?: {
    method: string, body: unknown,
  }): Promise<{
    body: string, status: number, attempts: number, retriedStatus: number | null,
  }> {
    let lastStatus = 0
    let lastBody = ''
    let attempts = 0
    let retriedStatus: number | null = null

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      attempts++
      let token: string
      try {
        token = await this.#tokens.accessTokenFor(personId)
      } catch (err) {
        // Only a transient class is worth another attempt. Revocation, a person who is not
        // connected and a malformed token response are all settled answers, and retrying each
        // of eighteen listable types through four backoff sleeps is minutes of sleeping per
        // person per run to reach the same conclusion. RevokedError is an AuthError, so this
        // covers it too.
        if (err instanceof HaelanError && err.kind !== 'transient') throw err
        // An unclassified failure here is Google's token endpoint having a bad day, the same
        // shape the data endpoint below already gets five attempts for.
        if (attempt === MAX_ATTEMPTS - 1) throw err
        await this.#deps.sleep(this.backoffMs(attempt))
        continue
      }

      const headers: Record<string, string> = { authorization: `Bearer ${token}` }
      if (init) headers['content-type'] = 'application/json'
      const res = await this.#deps.fetch(url.toString(), {
        method: init?.method,
        headers,
        body: init ? JSON.stringify(init.body) : undefined,
      })
      lastStatus = res.status
      lastBody = await res.text()

      // Contract evidence, a shape or filter Google changed, only ever arrives on a terminal
      // response, so only a terminal response reaches the archive call in listDataPoints. A
      // retriable status here is transient infrastructure noise, not schema drift, and is
      // deliberately left unarchived; sync_state.last_error is its home instead.
      const retriable = res.status === 429 || res.status >= 500
      if (!retriable) return { body: lastBody, status: lastStatus, attempts, retriedStatus }
      retriedStatus = res.status

      // Jittered, because the household shares one project quota and a fleet of syncs
      // retrying in lockstep is how a transient 429 becomes a sustained one.
      if (attempt < MAX_ATTEMPTS - 1) {
        await this.#deps.sleep(this.backoffMs(attempt))
      }
    }

    return { body: lastBody, status: lastStatus, attempts, retriedStatus }
  }

  private backoffMs(attempt: number): number {
    const backoff = BASE_BACKOFF_MS * 2 ** attempt
    return backoff + Math.floor(backoff * this.#deps.random())
  }
}
