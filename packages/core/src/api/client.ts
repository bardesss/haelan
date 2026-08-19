import type { RawArchive } from '../store/rawArchive.ts'
import type { DataType } from './catalogue.ts'

const API_ROOT = 'https://health.googleapis.com/v4'
const PAGE_SIZE = 10_000
const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 500

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
  pagesFetched: number
}

export interface ClientDeps {
  fetch: typeof globalThis.fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
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
  const member = `${t.filterRoot}.${t.filterMember}`
  // date and interval.civil_start_time carry no offset, so the same instant names a different
  // day depending on where the person is. iso is an absolute instant and is zone independent.
  const fmt = t.filterMember === 'date' ? (ms: number) => day(ms, timezone)
    : t.filterMember === 'interval.civil_start_time' ? (ms: number) => civil(ms, timezone)
    : iso
  return `${member} >= "${fmt(startMs)}" AND ${member} < "${fmt(endMs)}"`
}

export class HealthClient {
  constructor(
    private readonly tokens: Tokens,
    private readonly archive: RawArchive,
    private readonly deps: ClientDeps = { fetch: globalThis.fetch, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  ) {}

  async listDataPoints(input: ListInput): Promise<ListResult> {
    const { dataType: t } = input
    if (!t.listSupported) {
      throw new Error(`${t.id} does not support list, only rollup and dailyRollup`)
    }

    const filter = buildFilter(t, input.windowStartMs, input.windowEndMs, input.timezone)
    const payloadIds: string[] = []
    let pointCount = 0
    let pagesFetched = 0
    let pageToken: string | undefined

    do {
      const url = new URL(`${API_ROOT}/users/me/dataTypes/${t.id}/dataPoints`)
      url.searchParams.set('filter', filter)
      url.searchParams.set('pageSize', String(PAGE_SIZE))
      if (pageToken) url.searchParams.set('pageToken', pageToken)

      const { body, status } = await this.fetchWithRetry(url, input.personId)

      // Archived before parsing, so a payload Google changed the shape of is kept as evidence
      // rather than lost with the exception. Spec section 13, schema drift.
      const { id } = this.archive.put({
        personId: input.personId,
        dataType: t.id,
        requestParams: { filter, pageSize: PAGE_SIZE, pageToken: pageToken ?? null },
        windowStartMs: input.windowStartMs,
        windowEndMs: input.windowEndMs,
        fetchedAtMs: this.deps.now(),
        httpStatus: status,
        body,
      })

      if (status !== 200) throw new Error(`${status} listing ${t.id}: ${body.slice(0, 200)}`)

      payloadIds.push(id)
      pagesFetched++
      const json = JSON.parse(body) as { dataPoints?: unknown[], nextPageToken?: string }
      pointCount += json.dataPoints?.length ?? 0
      pageToken = json.nextPageToken
    } while (pageToken)

    return { payloadIds, pointCount, pagesFetched }
  }

  private async fetchWithRetry(url: URL, personId: string): Promise<{ body: string, status: number }> {
    let lastStatus = 0
    let lastBody = ''

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const token = await this.tokens.accessTokenFor(personId)
      const res = await this.deps.fetch(url.toString(), { headers: { authorization: `Bearer ${token}` } })
      lastStatus = res.status
      lastBody = await res.text()

      // Contract evidence, a shape or filter Google changed, only ever arrives on a terminal
      // response, so only a terminal response reaches the archive call in listDataPoints. A
      // retriable status here is transient infrastructure noise, not schema drift, and is
      // deliberately left unarchived; sync_state.last_error is its home instead.
      const retriable = res.status === 429 || res.status >= 500
      if (!retriable) return { body: lastBody, status: lastStatus }

      // Jittered, because the household shares one project quota and a fleet of syncs
      // retrying in lockstep is how a transient 429 becomes a sustained one.
      if (attempt < MAX_ATTEMPTS - 1) {
        const backoff = BASE_BACKOFF_MS * 2 ** attempt
        await this.deps.sleep(backoff + Math.floor(backoff * 0.25))
      }
    }

    return { body: lastBody, status: lastStatus }
  }
}
