import type { FastifyInstance } from 'fastify'
import { setupStep } from '@haelan/core'
import type { SetupStep } from '@haelan/core'
import { errorBody } from '../api/envelope.ts'

// Open in both directions: during setup there is nobody to authenticate, and afterwards a
// container health probe still has no cookie.
const ALWAYS_OPEN = new Set(['/api/health', '/api/setup/state'])

export function registerSetupGate(app: FastifyInstance): void {
  // The wizard's backfill step does not apply to a phone path, so the state names
  // the mode next to the step: one fetch tells SetupApp whether to offer a horizon to
  // walk or a history start that is a fact rather than a choice.
  app.get('/api/setup/state', async () => ({
    step: currentStep(app),
    companionMode: app.haelan.stores.settings.get()?.companionMode ?? false,
  }))

  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    if (ALWAYS_OPEN.has(path)) return
    // The gate governs the API, not the browser. A document request for /setup/google is how
    // the wizard is reached in the first place, and answering it with a 409 JSON body makes
    // an unconfigured instance impossible to configure.
    if (!path.startsWith('/api/') && !path.startsWith('/oauth/')) return

    const step = currentStep(app)
    const isConsentRoute = path.startsWith('/oauth/')
    const isSetupRoute = path.startsWith('/api/setup/') || isConsentRoute
    // Signing in is part of the wizard from the account step onwards. That step mints a session
    // as a side effect, so a wizard walked in one sitting never notices; every other way of
    // arriving at an unfinished one does. A reload after the cookie expired, a second admin
    // picking it up, and - the case this was found through - a database restored without its
    // instance.key, which lands a finished instance back on 'google-client' with accounts that
    // already exist and no session anywhere. Every remaining step requires a session, and
    // /api/setup/account answers 'account_exists', so closing this left the wizard behind a
    // session with no way left to obtain one. /api/auth/me stays closed: its 409 is what tells
    // the browser to show the wizard rather than the dashboard at all.
    const isSignIn = path === '/api/auth/login'

    if (step !== 'done' && !isSetupRoute && !isSignIn) {
      // One shape for every family. This used to branch on whether the path was versioned, because
      // the older families answered a flat string and a client narrowing on error.kind could not read
      // it. With one shape there is nothing to choose between, and the first thing a client ever sees
      // on a fresh instance is the same thing every later refusal will be.
      return reply.code(409).send(errorBody('setup_incomplete', 'setup_incomplete', `setup is at the ${step} step`))
    }
    // Consent outlives setup; the rest of the wizard does not. A grant can die after setup is
    // long finished - the owner revokes haelan in their Google account, or Google invalidates it
    // - and consent is the only thing that revives it, because putRefreshToken clearing
    // revoked_at_ms is the sole path back. Closing /oauth/* here left hand-editing SQLite as the
    // only recovery, and would have blocked a second member's first consent too (M5 invites).
    // The wizard's own API stays closed: those routes build an instance that already exists, and
    // re-running one silently rewrites what a working install depends on. /oauth/* is safe to
    // leave open because it does not rely on this gate for its protection - /oauth/start takes a
    // session, and /oauth/callback only accepts state this instance signed, for the person named
    // inside it.
    if (step === 'done' && isSetupRoute && !isConsentRoute) {
      // Two named exceptions, and only on the phone path: see opensForCompanion below. They are
      // what keeps "no Google" a choice rather than a door that only closes.
      if (opensForCompanion(app, path)) return
      // `setup_incomplete` as the kind for a refusal that means the opposite, because the kind is
      // the family a client branches on and both 409s here mean the same thing to it: this is a
      // wizard route and the wizard is not where you are. The code carries which of the two it was.
      return reply.code(409).send(errorBody('setup_incomplete', 'setup_complete', 'setup is already finished'))
    }
  })
}

function currentStep(app: FastifyInstance): SetupStep {
  const { accounts, settings, credentials, people } = app.haelan.stores
  return setupStep({ accounts, settings, credentials, people })
}

/**
 * The two wizard routes the phone path still needs after it has finished, and the reason it needs
 * them: closing without Google (POST /api/setup/companion) records companionMode and the completion
 * stamp, which is exactly what makes setupStep answer 'done' - and at 'done' the branch above shuts
 * every /api/setup/ route. POST /api/setup/google-client is the only writer of an OAuth client in
 * the server (oauth.ts), and /oauth/start needs a readable one (it 409s wrong_step without it), so
 * without this the phone choice could never be undone: no client was ever pasted, and pasting one
 * was refused. That is a one-way door, and it was found as one.
 *
 * Two paths, on purpose, and both only on a completed companion instance:
 *
 * - the client itself, and only while nobody has connected Google here. That condition is what
 *   keeps the refusal above alive on a mixed instance, where rewriting the client silently
 *   repoints an existing grant and the admin walking this path is the one who would not notice.
 *   listTokenPeople counts revoked rows too - "has anybody ever chosen the Google path" - which is
 *   the reading that matters here, because a revoked grant's way back is reconsent through the
 *   client it was granted against.
 * - the last error, unconditionally. A failed callback redirects to /setup/google?error=<code> and
 *   the screen fetches the reason from here (SetupApp.tsx), and on a mixed instance the condition
 *   above has already turned the client's exemption off. The person who needs the message is the
 *   invited member whose own consent just failed, and this route is a read-only GET over an
 *   in-memory slot that rewrites nothing: refusing it protects nothing and costs the only
 *   explanation of the failure.
 *
 * Neither exception is an unauthenticated door. Both routes keep their own requireSession, which
 * this hook runs ahead of and does not replace; what opens here is the gate, not the guard.
 */
function opensForCompanion(app: FastifyInstance, path: string): boolean {
  const settings = app.haelan.stores.settings.get()
  if (settings?.companionMode !== true || settings.setupCompletedAtMs === null) return false
  if (path === '/api/setup/last-error') return true
  return path === '/api/setup/google-client' && app.haelan.stores.credentials.listTokenPeople().length === 0
}
