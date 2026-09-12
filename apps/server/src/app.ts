import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import type { FastifyInstance } from 'fastify'
import {
  AccountStore, CredentialStore, McpCallLog, McpTokenStore, PeopleStore, RawArchive, SessionStore,
  SettingsStore, SourceRegistry, SyncStateStore,
} from '@haelan/core'
import type { ExcludedDataTypeStore, Instance, RateLimiter } from '@haelan/core'
import { registerSetupGate } from './routes/setupGate.ts'
import { registerAuth } from './routes/auth.ts'
import { registerSetup } from './routes/setup.ts'
import { registerOauth } from './routes/oauth.ts'
import { registerSync } from './routes/sync.ts'
import { registerSettings } from './routes/settings.ts'
import { registerMaintenance } from './routes/maintenance.ts'
import { registerMemberRoutes } from './routes/members.ts'
import { registerProfile } from './routes/profile.ts'
import { registerInviteRoutes } from './routes/invite.ts'
import { registerV1 } from './routes/v1/index.ts'
import { registerStatic } from './static.ts'
import { SyncRunner } from './sync/runner.ts'
import { registerRequireAdmin } from './api/requireAdmin.ts'
import { registerRequireMcpToken } from './mcp/guard.ts'
import { registerMcp } from './mcp/http.ts'

/** Overrides for Google's endpoints. Tests point these at a stub; production leaves them unset. */
export interface EndpointOverrides {
  apiRoot?: string
  tokenEndpoint?: string
  authEndpoint?: string
}

export interface ServerDeps {
  instance: Instance
  now: () => number
  fetch: typeof globalThis.fetch
  endpoints?: EndpointOverrides
  /** Absolute path to the built web bundle. Unset in tests, which serve no static files. */
  webRoot?: string
  /**
   * The directory `openHaelan` was given. `Instance` does not expose it and `config.*` reaches
   * only `index.ts`, so the maintenance routes - which need it for `listBackups` and for the
   * vacuum's disk check - would otherwise have no honest way to learn it short of reading
   * `process.env` themselves, which would work in production and leave them with nothing a test
   * built from this file's own harness could ever point somewhere else.
   */
  dataDir: string
  /** How many completed backups `POST .../backup` keeps after pruning. Mirrors `config.backupKeep`. */
  backupKeep: number
  /** Reported by `GET .../maintenance` alongside `backupKeep`. Mirrors `config.backupIntervalHours`. */
  backupIntervalHours: number
  /**
   * True while a second connection to the database file might still exist - specifically, while
   * index.ts's boot rebuild worker holds its own. `routes/maintenance.ts` reads this before either
   * POST route touches the file: a `VACUUM` against a live write transaction the worker holds
   * blocks the event loop for the full `busy_timeout` and then 500s, and a `VACUUM INTO` can
   * succeed but get rejected by `verifyBackup` because the worker advanced the live database in
   * between the copy and the comparison. Both routes are reachable from `listen()`, which precedes
   * the rebuild, so this is not the theoretical case index.ts's own comment on the boot vacuum used
   * to claim it was.
   *
   * Unset (and so always false, via the `?.()` at each call site) in every test that never
   * rebuilds anyone, which is everything but index.ts's own production wiring - see
   * WithServerOptions.rebuildInFlight in harness.ts for the one test that sets it.
   */
  rebuildInFlight?: () => boolean
  /**
   * Overrides the runner's token bucket. Production leaves it unset and gets the real one; a
   * test that drove hundreds of stubbed windows through the real bucket would spend minutes
   * waiting on a refill that has nothing to do with what it is asserting.
   */
  limiter?: RateLimiter
  /**
   * Windows each data type walks per run before yielding. Unset in production, which takes
   * runBackfill's own default. Tests lower it: eighteen types at the real batch is several
   * hundred archived windows per trigger, which is minutes of gzip in a suite asserting that
   * a cursor moved at all.
   */
  backfillBatchDays?: number
  /**
   * How much history the first run sprints through before settling into the trickle. Unset in
   * production, which takes the runner's own SPRINT_DAYS (90). Tests lower it so a run that
   * merely completes consent, and so starts a sprint of its own, doesn't pay for a 90 day walk
   * in its cleanup; the tests that are actually about sprint depth pass the real 90 explicitly.
   */
  sprintDays?: number
  /**
   * Restricts which data types a run walks, by id. Unset in production, where a run walks the
   * whole catalogue minus whatever each person excluded.
   *
   * Exists for the same reason sprintDays above does, one axis over. A run's cost is depth times
   * breadth: sprintDays bounds the depth so a test that merely completes consent does not pay for
   * a 90 day walk, and this bounds the breadth so a test about the sprint's own mechanics does not
   * pay for 42 data types to prove something two would prove. The catalogue going from 20 types to
   * 42 doubled every such test and turned one of them red on CI.
   *
   * Deliberately not the per-person exclusions table, which would also have worked: an exclusion
   * means a person turned a type off, and borrowing that to make a test fast would conflate their
   * intent with a test's indifference. Deliberately opt-in, so a test only narrows its own breadth
   * by saying so - no test can lose coverage by inheriting a default.
   */
  dataTypeIdsForTest?: readonly string[]
  /**
   * Lets a test register an extra route inside the /api/v1 plugin scope, with no preHandler of
   * its own, to prove the versioned surface's guard hook covers a route nobody remembered to
   * guard rather than relying on a per-route list. Unset in production.
   */
  v1TestExtra?: (app: FastifyInstance) => void
  /**
   * Lets a test observe every route exactly as fastify registers it: one call per (method, url)
   * pair, in registration order, with neither of printRoutes' two distortions. printRoutes merges
   * several methods on the same path onto one line, and nests a route whose path extends another
   * registered route's path under that route's line rather than printing it in full - both of
   * which the isolation suite's route-coverage guard needs to not have (see v1-isolation.test.ts).
   * Set before any route is registered, so it also sees the routes this file adds directly.
   * Unset in production.
   */
  onRouteForTest?: (route: { method: string, url: string }) => void
}

export interface Stores {
  accounts: AccountStore
  people: PeopleStore
  sessions: SessionStore
  settings: SettingsStore
  credentials: CredentialStore
  syncState: SyncStateStore
  sources: SourceRegistry
  archive: RawArchive
  excludedDataTypes: ExcludedDataTypeStore
  mcpTokens: McpTokenStore
  mcpCalls: McpCallLog
}

export interface ServerContext extends ServerDeps {
  stores: Stores
  /** Assigned immediately after the context is built; the runner needs the context itself. */
  runner: SyncRunner
}

declare module 'fastify' {
  interface FastifyInstance { haelan: ServerContext }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false })
  if (deps.onRouteForTest) {
    const onRouteForTest = deps.onRouteForTest
    // Added before any route below is registered, so it also fires for the HEAD fastify adds
    // itself for every GET (a separate registration call, and so a separate event here) and for
    // routes registered through app.register's deferred plugins, since a child context inherits
    // whatever hooks its parent held at the point it was registered.
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) onRouteForTest({ method, url: route.url })
    })
  }
  const stores: Stores = {
    accounts: new AccountStore(deps.instance.db),
    people: new PeopleStore(deps.instance.db),
    sessions: new SessionStore(deps.instance.db),
    settings: new SettingsStore(deps.instance.db),
    credentials: deps.instance.credentials,
    syncState: new SyncStateStore(deps.instance.db),
    sources: new SourceRegistry(deps.instance.db),
    archive: deps.instance.archive,
    excludedDataTypes: deps.instance.excludedDataTypes,
    mcpTokens: new McpTokenStore(deps.instance.db),
    mcpCalls: new McpCallLog(deps.instance.db),
  }
  // The runner takes the context and the context holds the runner, so it is assigned rather
  // than passed. One object, so a route reaching app.haelan.runner reaches the same instance
  // the scheduler is driving.
  const context = { ...deps, stores } as ServerContext
  context.runner = new SyncRunner(context)
  app.decorate('haelan', context)

  // Not awaited: Fastify queues plugin registration and resolves it during ready(), which the
  // harness awaits and listen() reaches. Awaiting here would make buildServer async for no gain.
  void app.register(cookie)

  app.get('/api/health', async () => ({ ok: true }))
  registerAuth(app)
  registerRequireAdmin(app)
  registerRequireMcpToken(app)
  registerSetup(app)
  registerOauth(app)
  registerSync(app)
  registerSettings(app)
  registerMaintenance(app)
  registerMemberRoutes(app)
  registerProfile(app)
  registerInviteRoutes(app)
  registerSetupGate(app)
  // Registered through app.register, not called directly like the routes above: the /api/v1
  // prefix and Fastify's plugin encapsulation are what keep this surface's error handler and
  // its isolation rule from touching anything outside it.
  void app.register((instance) => registerV1(instance, deps.v1TestExtra), { prefix: '/api/v1' })
  // Outside /api/v1 and outside the setup gate alike: setupGate.ts returns early for any path that
  // does not start with /api/ or /oauth/, so an unconfigured instance answers this route's own 404
  // rather than the gate's 409. Registered before registerStatic so the SPA fallback never sees it.
  registerMcp(app)
  if (deps.webRoot !== undefined) registerStatic(app, deps.webRoot)

  return app
}
