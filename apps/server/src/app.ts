import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import type { FastifyInstance } from 'fastify'
import {
  AccountStore, CredentialStore, PeopleStore, RawArchive, SessionStore, SettingsStore, SourceRegistry,
  SyncStateStore,
} from '@haelan/core'
import type { Instance, RateLimiter } from '@haelan/core'
import { registerSetupGate } from './routes/setupGate.ts'
import { registerAuth } from './routes/auth.ts'
import { registerSetup } from './routes/setup.ts'
import { registerOauth } from './routes/oauth.ts'
import { registerSync } from './routes/sync.ts'
import { registerSettings } from './routes/settings.ts'
import { registerV1 } from './routes/v1/index.ts'
import { registerStatic } from './static.ts'
import { SyncRunner } from './sync/runner.ts'

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
  registerSetup(app)
  registerOauth(app)
  registerSync(app)
  registerSettings(app)
  registerSetupGate(app)
  // Registered through app.register, not called directly like the routes above: the /api/v1
  // prefix and Fastify's plugin encapsulation are what keep this surface's error handler and
  // its isolation rule from touching anything outside it.
  void app.register((instance) => registerV1(instance, deps.v1TestExtra), { prefix: '/api/v1' })
  if (deps.webRoot !== undefined) registerStatic(app, deps.webRoot)

  return app
}
