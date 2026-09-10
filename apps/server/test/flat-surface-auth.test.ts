import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { registeredRoutes, withServer } from './harness.ts'
import type { Harness } from './harness.ts'

/**
 * The companion to v1-isolation.test.ts's route-coverage guard, over the surface that guard does
 * not see. That one filters on '/api/v1', which leaves every flat family - /api/auth, /api/setup,
 * /api/sync, /api/settings, /api/members, /api/invite, /api/health and /oauth - invisible to it. A
 * route added to any of them without a preHandler would have reached production with no test
 * noticing, on a surface that includes instance-wide settings.
 *
 * Nothing had actually slipped through when this was written: every /api/settings route was
 * admin-gated bar the deliberate GET below. The gap was that nothing would have said so.
 *
 * Three tests, because a declaration nobody checks is worth as little as no declaration. The first
 * asserts the table below names every registered route and no route it does not, so a new route
 * cannot ship without an entry. The other two call each route and assert the guard the table claims
 * for it is the guard it actually has - anonymously, and then as a member who is not an admin.
 */

/**
 * What a route asks of its caller, as its preHandler chain actually enforces it - and, for
 * anything short of an admin, why it asks for less.
 *
 * 'admin' is what a new route on this surface is expected to want, and needs no defence here.
 * Anything weaker is the allow-list, and the shape of this type makes its one-line reason
 * mandatory rather than optional: a route that ships without a guard has to be argued for in this
 * table first, which is the whole point of the two guards below.
 */
type FlatRoute =
  /** requireSession then requireAdmin: instance-wide, so only an admin gets through. */
  | { route: string, auth: 'admin' }
  /** 'session' is requireSession alone - any signed-in member, admin or not. 'open' is neither. */
  | { route: string, auth: 'session' | 'open', why: string }

// `${METHOD} ${url}` in the exact form fastify registers, params included, matching what
// registeredRoutes observes. Grouped by family, not by auth level, so a family's entries stay
// next to each other when one is added.
const FLAT_ROUTES: readonly FlatRoute[] = [
  {
    route: 'GET /api/health',
    auth: 'open',
    why: 'a container health probe carries no cookie, and the setup gate holds it open both ways',
  },

  {
    route: 'POST /api/auth/login',
    auth: 'open',
    why: 'signing in is how a session is obtained in the first place',
  },
  {
    route: 'POST /api/auth/logout',
    auth: 'open',
    why: 'it destroys whatever cookie arrived and answers 204 regardless, so a guard would only make signing out fail',
  },
  {
    route: 'GET /api/auth/me',
    auth: 'session',
    why: 'it reports the caller their own account and nobody else\'s',
  },

  {
    route: 'GET /api/setup/state',
    auth: 'open',
    why: 'the wizard has to ask which step it is on before an account exists to sign in to',
  },
  {
    route: 'POST /api/setup/account',
    auth: 'open',
    why: 'it mints the first session, so there is none to require; it 409s the moment an account exists',
  },
  {
    route: 'POST /api/setup/instance-url',
    auth: 'session',
    why: 'a wizard step behind the account step that minted the session, and the gate shuts it once setup is done',
  },
  {
    route: 'GET /api/setup/redirect-uris',
    auth: 'session',
    why: 'the same wizard window: a session from the account step, and closed by the gate afterwards',
  },
  {
    route: 'GET /api/setup/scopes',
    auth: 'session',
    why: 'the same wizard window; it returns this build\'s scope list, which is not instance state',
  },
  {
    route: 'POST /api/setup/google-client',
    auth: 'session',
    why: 'the same wizard window; re-running it on a finished instance is what the gate\'s 409 exists to stop',
  },
  {
    route: 'GET /api/setup/last-error',
    auth: 'session',
    why: 'the same wizard window; it reports the last consent failure to whoever is walking the wizard',
  },

  {
    route: 'GET /oauth/start',
    auth: 'session',
    why: 'consent outlives setup (setupGate.ts), so the session is its only guard - it signs state for the account it resolves',
  },
  {
    route: 'GET /oauth/callback',
    auth: 'open',
    why: 'Google redirects a browser here with no cookie; it accepts only state this instance signed',
  },

  {
    route: 'GET /api/sync/status',
    auth: 'session',
    why: 'it answers about the one person the session resolves to and no other (sync.ts)',
  },
  {
    route: 'POST /api/sync/run',
    auth: 'session',
    why: 'a member may trigger their own sync; the run is scoped to the person their session resolves to',
  },
  {
    route: 'GET /api/sync/events',
    auth: 'session',
    why: 'the same stream as the status above, filtered to the caller\'s own person',
  },

  {
    route: 'GET /api/settings/backfill-horizon',
    auth: 'session',
    why: 'reading the horizon tells a member how far their own history reaches; the PUT beside it is admin',
  },
  { route: 'PUT /api/settings/backfill-horizon', auth: 'admin' },

  {
    route: 'GET /api/settings/maintenance',
    auth: 'admin',
    why: 'reports what the database is costing and what backups exist, which is the shape of the instance rather than anybody\'s data',
  },
  { route: 'POST /api/settings/maintenance/backup', auth: 'admin' },
  {
    route: 'POST /api/settings/maintenance/reclaim',
    auth: 'admin',
    why: 'rewrites the whole database file and stalls every request while it runs',
  },

  { route: 'GET /api/members', auth: 'admin' },
  { route: 'POST /api/members', auth: 'admin' },
  { route: 'POST /api/members/:accountId/disable', auth: 'admin' },
  { route: 'POST /api/members/:accountId/enable', auth: 'admin' },
  { route: 'DELETE /api/members/invites/:id', auth: 'admin' },

  {
    route: 'GET /api/invite/:token',
    auth: 'open',
    why: 'the invited member has no account yet; the unguessable token is the credential',
  },
  {
    route: 'POST /api/invite/:token',
    auth: 'open',
    why: 'redeeming that token is how they get their first session',
  },
]

// The five verbs this surface uses. Narrower than fastify's own HTTPMethods, which inject does not
// accept in full; a route registered on anything else would reach inject as an unhandled method and
// fail there, loudly, which is the answer this file wants for a verb nobody has thought about.
type InjectableMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const MUTATING = new Set<InjectableMethod>(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The setup gate answers /api/setup/* with 409 setup_complete once the wizard has finished, ahead
 * of any route's own preHandler (setupGate.ts). So the only state in which those routes reach
 * their session guard at all is the one they exist for: an instance mid-wizard. Derived from the
 * path rather than declared per entry, because that is precisely the rule the gate itself applies,
 * so a new /api/setup route lands on the right side of it without a second edit here.
 *
 * /api/setup/state is in the gate's ALWAYS_OPEN and passes in both states; taking the mid-wizard
 * harness for it is harmless, since it is open either way.
 */
const onlyReachableDuringSetup = (route: string): boolean => route.includes(' /api/setup/')

/**
 * A request aimed at the pattern fastify registered. Every guard on this surface runs as a
 * preHandler, before the handler looks at a param, so what a `:segment` is filled with does not
 * matter - only that there is one.
 */
async function call(app: Harness['app'], route: string, headers: Record<string, string> = {}) {
  const [method, url] = route.split(' ') as [InjectableMethod, string]
  return await app.inject({
    method,
    url: url.replace(/:[^/]+/g, 'x'),
    headers,
    // An empty JSON body rather than none, because fastify parses the body before it runs any
    // preHandler: a POST arriving with no content-type would be refused during parsing and the
    // guard this file is about would never run, which would read here as a route that refuses
    // everyone. Origin is left off on purpose - auth.ts's origin hook passes a mutating request
    // that carries none, so omitting it reaches the guard without this file having to agree with
    // the harness about the host.
    ...(MUTATING.has(method) ? { payload: {} } : {}),
  })
}

function errorOf(response: { body: string }): unknown {
  try {
    return (JSON.parse(response.body) as { error?: unknown }).error
  } catch {
    return undefined
  }
}

/**
 * Both shapes a refused session comes back as. The older flat families answer { error: 'no_session' }
 * and the newer ones answer the envelope's { error: { kind, code } } - see UnauthorizedResponder in
 * auth.ts for why the two coexist. A check that knew only one shape would read every route in the
 * other family as unguarded, which is the failure this file exists to prevent rather than cause.
 */
function refusedForNoSession(response: { statusCode: number, body: string }): boolean {
  if (response.statusCode !== 401) return false
  const error = errorOf(response)
  if (error === 'no_session') return true
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'no_session'
}

/** requireAdmin's one refusal: a resolved session whose account is not an admin. */
function refusedForNotAdmin(response: { statusCode: number, body: string }): boolean {
  if (response.statusCode !== 403) return false
  const error = errorOf(response)
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'not_admin'
}

describe('the flat surface outside /api/v1 is guarded', () => {
  // Two instances, because the setup gate makes "which routes are reachable" a property of the
  // instance rather than of the request: mid-wizard it 409s everything that is not a setup route,
  // and once finished it 409s the setup routes instead. duringSetup is never signed in to and
  // never has completeSetup called on it, which is what keeps it mid-wizard.
  let duringSetup: Harness
  let afterSetup: Harness
  let memberToken: string

  beforeAll(async () => {
    duringSetup = await withServer()
    afterSetup = await withServer()
    // A second household member with an account of their own and isAdmin false - the caller the
    // admin sweep below needs, and the one a session-only check cannot tell from an admin.
    await afterSetup.addPerson({ id: 'p2', displayName: 'Wilma', username: 'wilma' })
    memberToken = await afterSetup.signIn('wilma', 'a good long password')
  })

  afterAll(async () => {
    await duringSetup.cleanup()
    await afterSetup.cleanup()
  })

  // Compared as a set in both directions, not a count, so a mismatch names the offending route
  // rather than failing with an opaque "expected 26 to be 25" that means nothing to whoever trips
  // it next. `missing` is the case this file was written for: a route registered and never
  // declared. `stale` is its mirror, a declaration left behind by a route that was removed.
  it('declares every route registered outside the versioned surface', async () => {
    const registered = await registeredRoutes((url) => !url.startsWith('/api/v1'))

    // Both halves are hand written from separate sources - one from fastify's own router, one
    // from the table above - so neither can go empty without the other noticing. Asserted anyway
    // rather than left to that, since this project has shipped a vacuous guard once already.
    expect(registered.size).toBeGreaterThan(0)

    const declared = new Set(FLAT_ROUTES.map((entry) => entry.route))
    // A duplicated entry collapses into the set silently and would hide whichever of the two
    // declarations is wrong; the table is the thing under review here, so it has to be exact.
    expect(declared.size).toBe(FLAT_ROUTES.length)

    const missing = [...registered].filter((entry) => !declared.has(entry))
    const stale = [...declared].filter((entry) => !registered.has(entry))
    expect({ missing, stale }).toEqual({ missing: [], stale: [] })
  })

  // Every route in one test rather than a case each, so a failure lists all of them at once: the
  // way this guard is met is by reading the whole table, and a run that stops at the first
  // offender hides how many there are.
  it('turns away a caller with no session, everywhere the table says it should', async () => {
    const wrong: string[] = []
    for (const entry of FLAT_ROUTES) {
      const harness = onlyReachableDuringSetup(entry.route) ? duringSetup : afterSetup
      const response = await call(harness.app, entry.route)
      const refused = refusedForNoSession(response)
      if (entry.auth === 'open') {
        // Not "answered 200": /api/auth/login answers 401 invalid_credentials to the empty body
        // this sends, and /api/invite/:token answers 404. What makes a route open is that it does
        // not refuse for want of a session, which is narrower than any status check.
        if (refused) wrong.push(`${entry.route} is declared open but refused an anonymous caller for no_session`)
      } else if (!refused) {
        wrong.push(`${entry.route} is declared ${entry.auth} but answered an anonymous caller ${response.statusCode} ${response.body}`)
      }
    }
    expect(wrong).toEqual([])
  })

  // Only the admin entries are called with the member's session. Sweeping the session-only routes
  // the same way would prove the mirror image - that none of them secretly wants an admin - but
  // it would do so by running their handlers with a valid session, and POST /api/sync/run means
  // it: it would start a real sync. Over-protection surfaces as that route's own tests failing;
  // under-protection is what has nothing else watching it, and is what this sweep is for.
  it('and turns away a member who is not an admin, everywhere the table says admin', async () => {
    const wrong: string[] = []
    for (const entry of FLAT_ROUTES) {
      if (entry.auth !== 'admin') continue
      if (onlyReachableDuringSetup(entry.route)) {
        // No state has both a signed-in member and an open /api/setup/*: the gate shuts those the
        // moment setup completes, and before that there is no account to sign in as. A route
        // declared admin here could not be proven either way, so the declaration would be a claim
        // rather than a fact - which is the one thing this file is not willing to hold.
        wrong.push(`${entry.route} is declared admin, but the setup gate closes /api/setup/* once setup is done, so no session ever reaches its guard`)
        continue
      }
      const response = await call(afterSetup.app, entry.route, { authorization: `Bearer ${memberToken}` })
      if (!refusedForNotAdmin(response)) {
        wrong.push(`${entry.route} is declared admin but answered a non-admin member ${response.statusCode} ${response.body}`)
      }
    }
    expect(wrong).toEqual([])
  })
})
