/**
 * Whether a newer release of this program exists, asked of GitHub by the server and cached.
 *
 * Server-side rather than from the browser, and off until an admin turns it on. The browser
 * version would send every reader's address to a third party on every visit to Settings, break
 * behind a firewall, and share GitHub's unauthenticated sixty-per-hour ceiling with everyone else
 * on that address. The server asks once every six hours for the whole household, and an instance
 * that cannot reach the internet reports that it does not know rather than showing an error for
 * ever.
 *
 * **What goes over the wire, in full:** a GET to
 * `https://api.github.com/repos/bardesss/haelan/releases/latest` with a `User-Agent: haelan`
 * header and no credentials. No identifier, no version, no instance address, nothing about the
 * household. GitHub learns that somebody at this IP asked for a public release tag, which is the
 * entire cost of the feature and is why it is off by default and documented in the README.
 *
 * No version comparison happens here. The server does not know which version it is running -
 * `apps/server/package.json` is not the release version, and the version the reader sees comes
 * from the bundle's own build-time constant - so this module answers "the latest tag GitHub
 * names" and the browser, which does know its version, decides whether that is newer.
 */

/** GitHub's own address for the newest published release of this repository. */
export const LATEST_RELEASE_URL = 'https://api.github.com/repos/bardesss/haelan/releases/latest'

/**
 * How long an answer is good for.
 *
 * Six hours is four requests a day against a sixty-an-hour ceiling, and a release nobody hears
 * about for six hours is a release nobody was waiting on that closely. The ceiling is per address,
 * shared with everything else behind the same one, which is the reason this is hours rather than
 * minutes.
 */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** How long to wait for GitHub before giving up and reporting that this instance cannot ask. */
const REQUEST_TIMEOUT_MS = 5_000

/**
 * How long a failure is honoured before trying again.
 *
 * Without this, an instance with no outbound network retries on every single page view and pays
 * the timeout above each time - the "error card for ever" the design was written to avoid, in its
 * slow form. Fifteen minutes is short enough that a firewall rule fixed at lunchtime is noticed
 * after lunch, and long enough that being offline costs one stalled request a quarter of an hour
 * rather than one per visit.
 */
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000

export interface UpdateCheck {
  /** The newest release tag GitHub names, without its leading `v`. Null when nothing is known. */
  latest: string | null
  /** When that answer was fetched, or null when no answer has ever arrived. */
  checkedAtMs: number | null
  /** False when the last attempt failed. A reader is told "could not check", never shown an error. */
  reachable: boolean
}

/** The cached answer plus when it was last *attempted*, which is not the same as when it last
 *  succeeded and is what the backoff above is counted from. */
interface CacheEntry extends UpdateCheck { attemptedAtMs: number | null }

const UNKNOWN: CacheEntry = { latest: null, checkedAtMs: null, reachable: true, attemptedAtMs: null }

interface ReleaseBody { tag_name?: unknown }

/**
 * The cache, and the one request in flight.
 *
 * Module level rather than in the database: the answer is worth keeping for hours, not across
 * restarts, and a restart is exactly the moment an operator wants a fresh answer anyway. Keeping
 * it out of the schema also keeps the only persistent trace of this feature the one thing that
 * genuinely is a setting - whether it may run at all.
 *
 * `inFlight` is what stops a household opening Settings on four devices at once from making four
 * requests: the second through fourth wait on the first one's promise.
 */
let cached: CacheEntry = UNKNOWN
let inFlight: Promise<CacheEntry> | null = null

/** Exported for the tests, which need each case to start from a known cache. */
export function resetUpdateCacheForTest(): void {
  cached = UNKNOWN
  inFlight = null
}

function parse(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const tag = (body as ReleaseBody).tag_name
  if (typeof tag !== 'string' || tag === '') return null
  // Tags are published as `v1.33.0`; the version the browser holds has no `v`. Stripped here, at
  // the one place that knows GitHub's spelling, rather than in the browser, which would then have
  // to know it too.
  return tag.startsWith('v') ? tag.slice(1) : tag
}

async function ask(nowMs: number, fetchImpl: typeof fetch): Promise<CacheEntry> {
  try {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'haelan' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return { ...cached, reachable: false, attemptedAtMs: nowMs }
    const latest = parse(await response.json())
    // A 200 whose body has no tag is not a reachability problem, and it is not an answer either.
    // Keeping the previous latest with a fresh timestamp would claim knowledge this did not get.
    if (latest === null) return { ...cached, reachable: false, attemptedAtMs: nowMs }
    return { latest, checkedAtMs: nowMs, reachable: true, attemptedAtMs: nowMs }
  } catch {
    // Every failure lands here on purpose: no network, DNS that does not resolve, a proxy that
    // refuses, a timeout, a body that is not JSON. None of them is something a reader can act on,
    // and all of them mean the same thing to the page - this instance could not ask.
    return { ...cached, reachable: false, attemptedAtMs: nowMs }
  }
}

/** Whether the answer in hand is worth serving without asking again: a success inside the cache
 *  window, or a failure inside the shorter one the backoff allows. */
function usable(entry: CacheEntry, nowMs: number): boolean {
  if (entry.checkedAtMs !== null && nowMs - entry.checkedAtMs < CACHE_TTL_MS) return true
  return entry.attemptedAtMs !== null && nowMs - entry.attemptedAtMs < RETRY_AFTER_FAILURE_MS
}

/**
 * The cached answer, refreshed first when it has gone stale.
 *
 * Awaited rather than returned stale with a refresh left running behind it: the request is bounded
 * by its own timeout, it happens at most once every six hours for the whole household, and a page
 * that showed a six-hour-old answer and then silently changed its mind would be harder to trust
 * than one that took a moment on the visit after a release.
 */
export async function checkForUpdate(nowMs: number, fetchImpl: typeof fetch = fetch): Promise<UpdateCheck> {
  if (usable(cached, nowMs)) return answer(cached)
  if (inFlight === null) {
    inFlight = ask(nowMs, fetchImpl).then((result) => {
      cached = result
      inFlight = null
      return result
    })
  }
  return answer(await inFlight)
}

/** The three fields a caller gets, named one at a time rather than spread from the cache entry:
 *  the route sends this straight to the browser, and `attemptedAtMs` is this module's bookkeeping
 *  rather than something an instance owes anybody. */
function answer(entry: CacheEntry): UpdateCheck {
  return { latest: entry.latest, checkedAtMs: entry.checkedAtMs, reachable: entry.reachable }
}
