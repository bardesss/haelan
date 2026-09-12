import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountStore, PeopleStore, SCOPES, SettingsStore, body, openHaelan } from '@haelan/core'
import type { RateLimiter } from '@haelan/core'
import { buildServer } from '../src/app.ts'
import type { FastifyInstance } from 'fastify'

export type GoogleMode = 'ok' | 'redirect_uri_mismatch' | 'service_disabled' | 'list_fails'

// list_fails fails this one type and no other, so a test can prove a healthy type keeps
// advancing while this one is retried and never does - "a type that fails every window", not
// every type failing every window. Picked for no reason beyond being listable and daily tiered;
// tests that need a "the rest is healthy" reference type use weight instead, so the two never
// collide.
export const LIST_FAILS_TYPE = 'body-fat'
const typeIdFrom = (url: string): string => url.match(/\/dataTypes\/([^/]+)\/dataPoints/)?.[1] ?? ''

export interface WithServerOptions {
  google?: GoogleMode
  /** Replaces the pass through limiter, so a test can park a run mid flight and release it. */
  limiter?: RateLimiter
  /**
   * See ServerDeps.sprintDays. Defaults small below so a run that merely completes consent -
   * and so starts a sprint of its own, since oauth.ts's callback calls tryStart('setup') -
   * finishes in a pass or two instead of paying for the real 90 day depth in every such test's
   * cleanup. The tests that are actually about the sprint's own depth override this to the real
   * production number.
   */
  sprintDays?: number
  /**
   * See ServerDeps.backfillBatchDays. Defaults small below; the sprint depth tests override
   * this too, to the real batch size, so their pass count lines up with production rather than
   * this suite's speed-picked default.
   */
  backfillBatchDays?: number
  /**
   * Which data types this instance's runs walk, by id. Unset means all of them, which is what
   * every test got before this existed and what most still want.
   *
   * The other half of the cost sprintDays bounds: a run is depth times breadth, and a test about
   * the sprint's own mechanics pays for 42 data types to prove something two would prove. Pass a
   * short list where the test's subject is the loop rather than the catalogue, and say so in the
   * test - a narrowed test that reads as if it covered the whole catalogue is worse than a slow one.
   */
  dataTypes?: readonly string[]
  /** See ServerDeps.v1TestExtra. Unset by every test but the one that exercises it. */
  v1TestExtra?: (app: FastifyInstance) => void
  /** See ServerDeps.onRouteForTest. Unset by every test but registeredRoutes below. */
  onRouteForTest?: (route: { method: string, url: string }) => void
  /** See ServerDeps.backupKeep. Defaults to 7, the production default, below; a test about
   * retention itself (HAELAN_BACKUP_KEEP=0 disabling the manual backup route) overrides it. */
  backupKeep?: number
  /** See ServerDeps.rebuildInFlight. Unset by every test but the one that exercises the two
   * maintenance routes declining while it is true. */
  rebuildInFlight?: () => boolean
  /** See ServerDeps.webRoot. Unset by every test but the one that installs the static handler
   * to prove the not found handler's non-GET branch, since most of this suite is about the API
   * and registering @fastify/static against a directory that does not exist would fail. */
  webRoot?: string
}

const GOOGLE_STUB_ROOT = 'http://stub.invalid'

// Answers the two endpoints the consent round trip touches, by URL, so no test ever reaches
// Google. Anything else throws rather than returning a plausible empty answer.
function stubFetch(mode: GoogleMode): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/token')) {
      if (mode === 'redirect_uri_mismatch') {
        return new Response(JSON.stringify({ error: 'redirect_uri_mismatch' }), { status: 400 })
      }
      return new Response(JSON.stringify({
        refresh_token: 'stub-refresh-token', access_token: 'stub-access-token',
        expires_in: 3599, scope: SCOPES.join(' '),
      }), { status: 200 })
    }
    if (url.endsWith('/users/me/profile')) {
      if (mode === 'service_disabled') {
        return new Response(JSON.stringify({
          error: {
            status: 'PERMISSION_DENIED',
            message: 'Health API has not been used in project 1 before or it is disabled',
            details: [{ reason: 'SERVICE_DISABLED' }],
          },
        }), { status: 403 })
      }
      return new Response(JSON.stringify({ displayName: 'Robin' }), { status: 200 })
    }
    // list_fails answers LIST_FAILS_TYPE's data windows with a status the client does not retry
    // (only 429 and 5xx get a backoff sleep; see fetchWithRetry), so a sprint that hits it fails
    // fast instead of dragging the test through retry backoff. It is recorded through runJob's
    // catch as an immediate per-type failure rather than swallowed. Every other type answers
    // normally, so a test can assert a healthy type is unaffected by the broken one.
    if (url.includes('/dataPoints') && mode === 'list_fails' && typeIdFrom(url) === LIST_FAILS_TYPE) {
      return new Response(JSON.stringify({ error: 'the stub is failing every list request' }), { status: 400 })
    }
    // An empty page in the shape the mappers expect. These tests are about the runner's
    // scheduling and progress, not its mapping; Task 16's end to end run is where real points
    // travel through and land as rows.
    if (url.includes('/dataPoints')) return new Response(body([]), { status: 200 })
    throw new Error(`the stub was asked for ${url}, which it does not serve`)
  }) as unknown as typeof globalThis.fetch
}

export interface Harness {
  app: FastifyInstance
  dir: string
  clock: { nowMs: number }
  completeSetup: () => Promise<void>
  connectPerson: () => Promise<void>
  // Every test file has been rolling its own cookie extraction. One helper instead, returning
  // the raw session id, which is what both transports carry.
  signIn: (username?: string, password?: string) => Promise<string>
  // The isolation suite needs a person the signed in account does not own. The harness seeds
  // exactly one, and every test that wanted a second has been reaching into the stores itself.
  addPerson: (input: { id: string, displayName: string, username: string }) =>
    Promise<{ personId: string, accountId: string }>
  /**
   * A usable MCP token for an account, minted straight through the store rather than through the
   * Profile card's route: the guard's tests are about the credential, not about the screen that
   * hands one out, and going through the route would make every one of them depend on it.
   */
  mintMcpToken: (options?: { accountId?: string, label?: string, days?: number }) =>
    { secret: string, id: string }
  cleanup: () => Promise<void>
}

export async function withServer(options: WithServerOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-server-'))
  const clock = { nowMs: 1_770_000_000_000 }
  const instance = openHaelan(dir, {})
  const app = buildServer({
    instance,
    now: () => clock.nowMs,
    fetch: options.google
      ? stubFetch(options.google)
      : async () => { throw new Error('no stub fetch installed for this test') },
    ...(options.google
      ? {
          endpoints: {
            apiRoot: `${GOOGLE_STUB_ROOT}/v4`,
            tokenEndpoint: `${GOOGLE_STUB_ROOT}/token`,
            authEndpoint: `${GOOGLE_STUB_ROOT}/auth`,
          },
        }
      : {}),
    // A pass through, because these tests drive hundreds of stubbed windows and the real
    // bucket refills against the wall clock. Rate limiting is exercised by TokenBucket's own
    // tests; making every server test wait on it would only make them slow.
    limiter: options.limiter ?? { take: async () => {} },
    // The same temp directory openHaelan just opened below, matching what index.ts hands
    // buildServer in production - see ServerDeps.dataDir for why a route cannot read
    // HAELAN_DATA_DIR itself. keep and intervalHours are config.ts's own defaults; no test here
    // is about either number, so nothing narrows them further.
    dataDir: dir,
    backupKeep: options.backupKeep ?? 7,
    backupIntervalHours: 24,
    rebuildInFlight: options.rebuildInFlight,
    // One window per type, not fourteen, by default. Enough to prove the walk moved and
    // recorded a cursor, which is all most server tests assert; the ordering of a longer walk
    // is run-backfill's own test. A real batch is eighteen types of gzip per trigger and turns
    // this suite into minutes when it runs alongside the others.
    backfillBatchDays: options.backfillBatchDays ?? 1,
    // How deep a sprint walks before this instance settles into the trickle. See
    // WithServerOptions.sprintDays above for why this defaults small.
    sprintDays: options.sprintDays ?? 2,
    // Undefined by default on purpose: a test walks the whole catalogue unless it says otherwise,
    // so breadth coverage can only be given up deliberately and never inherited.
    dataTypeIdsForTest: options.dataTypes,
    v1TestExtra: options.v1TestExtra,
    onRouteForTest: options.onRouteForTest,
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
  })
  await app.ready()

  // What a finished wizard would have left behind, so a test about anything else does not
  // have to walk it.
  //
  // Guarded against a second call: PeopleStore.create and AccountStore.create both throw on a
  // repeat id/username, and both signIn and addPerson below call this themselves so a test can
  // use either without having called it first. That only works if calling it twice is free,
  // which needs the flag set after the work succeeds, not before: setting it early would make a
  // failed first call look like a finished one to every caller after it, turning one loud
  // failure into a silent no-op somewhere else.
  let setupComplete = false
  const completeSetup = async () => {
    if (setupComplete) return
    // Through the store the wizard itself uses, not seedPerson, because the two now differ in a
    // way that matters here: create stamps the current versions and seedPerson leaves them null,
    // which is a person the sync runner skips. A harness that produced the second while claiming
    // to produce a finished wizard would make every sync test in this file a test of the skip.
    new PeopleStore(instance.db).create({
      id: 'p1', displayName: 'Robin', timezone: 'Europe/Amsterdam', nowMs: clock.nowMs,
    })
    const accounts = new AccountStore(instance.db)
    const settings = new SettingsStore(instance.db)
    await accounts.create({
      id: 'a1', personId: 'p1', username: 'robin', password: 'a good long password',
      isAdmin: true, nowMs: clock.nowMs,
    })
    settings.put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: clock.nowMs })
    instance.credentials.putClient({
      clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret', nowMs: clock.nowMs,
    })
    settings.markSetupComplete(clock.nowMs)
    setupComplete = true
  }

  // completeSetup leaves the state between the console step and consent: a client, no token.
  // connectPerson adds the token, which is what a finished wizard actually produces and what
  // anything about syncing needs.
  const connectPerson = async () => {
    await completeSetup()
    instance.credentials.putRefreshToken({
      personId: 'p1', refreshToken: 'stub-refresh-token', scopes: [...SCOPES], nowMs: clock.nowMs,
    })
  }

  return {
    app,
    dir,
    clock,
    completeSetup,
    connectPerson,

    // Every test file has been rolling its own cookie extraction. One helper instead, returning
    // the raw session id, which is what both transports carry.
    signIn: async (username = 'robin', password = 'a good long password') => {
      await completeSetup()
      const response = await app.inject({
        method: 'POST', url: '/api/auth/login',
        headers: { origin: 'http://localhost:4235', host: 'localhost:4235' },
        payload: { username, password },
      })
      const cookie = response.cookies.find((c) => c.name === 'haelan_session')
      if (!cookie) throw new Error(`sign in failed: ${response.statusCode} ${response.body}`)
      return cookie.value
    },

    // A second household member: a person and an account of their own, no refresh token. Nothing
    // here grants them any data, which is the point - the isolation tests need an account that
    // can sign in and must still see nothing of anybody else's.
    addPerson: async (input: { id: string, displayName: string, username: string }) => {
      await completeSetup()
      new PeopleStore(instance.db).create({
        id: input.id, displayName: input.displayName,
        timezone: 'Europe/Amsterdam', nowMs: clock.nowMs,
      })
      await new AccountStore(instance.db).create({
        id: `a-${input.id}`, personId: input.id, username: input.username,
        password: 'a good long password', isAdmin: false, nowMs: clock.nowMs,
      })
      return { personId: input.id, accountId: `a-${input.id}` }
    },

    mintMcpToken: (options = {}) => {
      // 'a1' by name, not accounts.list()[0]: that list is ordered by username, so the first
      // row stops being the admin's the moment a test adds an account sorting before 'robin'.
      // This harness creates the admin as a1/p1 itself, so naming it is both exact and stable.
      const accountId = options.accountId ?? 'a1'
      const { token, secret } = app.haelan.stores.mcpTokens.create({
        id: randomUUID(), accountId, label: options.label ?? 'a test machine',
        days: options.days ?? 90, nowMs: clock.nowMs,
      })
      return { secret, id: token.id }
    },

    cleanup: async () => {
      // A route or a callback may have left a run going. Closing the database under it turns
      // teardown into an unhandled error attributed to whichever test happened to be next.
      await app.haelan.runner.settle()
      await app.close()
      instance.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Every (method, url) pair this app registers whose url `matches`, as `${method} ${url}`. The
 * input to the route-coverage guards, which assert that no route was added without some test
 * noticing: v1-isolation.test.ts over the versioned surface, flat-surface-auth.test.ts over
 * everything outside it.
 *
 * Not printRoutes: it merges several methods on the same path onto one line, so a second method
 * added to an existing path is invisible to a line count, and it nests a route whose path extends
 * another registered route's path under that route's line rather than printing it in full, so a
 * route added under an existing one is invisible too. Both were confirmed against this exact route
 * set before ruling printRoutes out. ServerDeps.onRouteForTest instead observes fastify's own
 * onRoute hook, wired in by app.ts before any route is registered, which fires once per
 * (method, url) pair exactly as fastify's router sees it: no merging, no nesting.
 *
 * Every HEAD event is dropped, not only fastify's own auto-added ones (it re-enters route
 * registration to add one for every GET, which is what would otherwise show up as an entry nobody
 * declared): no route is HEAD only today, but a deliberately HEAD only route would be invisible to
 * the guards the same way, and this filter does not tell the two apart.
 *
 * webRoot is left unset, so the SPA's static handler is not in this set. It answers document
 * requests for the browser rather than the API, and the setup gate deliberately lets those past
 * (see setupGate.ts); a guard over it would be a guard over @fastify/static.
 *
 * Its own server, built and torn down before this returns, so a guard leaning on it runs the same
 * regardless of which test ran last. Registration is all it needs: the routes are declared during
 * ready(), which withServer has already awaited by the time it hands the harness back.
 */
export async function registeredRoutes(matches: (url: string) => boolean): Promise<Set<string>> {
  const routes = new Set<string>()
  const harness = await withServer({
    onRouteForTest: (route) => {
      if (route.method === 'HEAD') return
      if (matches(route.url)) routes.add(`${route.method} ${route.url}`)
    },
  })
  await harness.cleanup()
  return routes
}
