import type { FastifyInstance, FastifyRequest } from 'fastify'
import { buildConsentUrl, exchangeAuthorizationCode, probeAccess, setupStep } from '@haelan/core'
import { redirectUriFor } from '../oauth/redirectUri.ts'
import { ConsumedStates, signState, verifyState } from '../oauth/state.ts'
import { SESSION_COOKIE } from '../auth/cookie.ts'
import { errorBody } from '../api/envelope.ts'

interface ClientBody { clientId?: unknown, clientSecret?: unknown }

export function registerOauth(app: FastifyInstance): void {
  const stores = () => app.haelan.stores
  // One slot per person, overwritten per attempt. The callback is reachable by anyone, so a single
  // shared slot let one caller write the message another reads. The wizard reads its own slot
  // right after a failed callback and nothing else does, so persisting it would outlive its reader.
  const lastErrors = new Map<string, { code: string, message: string }>()
  const consumed = new ConsumedStates()

  app.post<{ Body: ClientBody }>('/api/setup/google-client', { preHandler: [app.requireSession, app.requireAdmin] }, async (request, reply) => {
    const { clientId, clientSecret } = request.body ?? {}
    if (typeof clientId !== 'string' || typeof clientSecret !== 'string'
      || clientId.trim() === '' || clientSecret.trim() === '') {
      return reply.code(400).send(errorBody('config', 'config', 'clientId and clientSecret are required'))
    }
    if (!clientId.trim().endsWith('.apps.googleusercontent.com')) {
      // A cheap check that catches the commonest paste error while the owner is still in the
      // console. It is not validation: only the exchange can validate.
      return reply.code(400).send(errorBody('config', 'config', 'that does not look like a client ID. It ends in .apps.googleusercontent.com'))
    }
    stores().credentials.putClient({
      clientId: clientId.trim(), clientSecret: clientSecret.trim(), nowMs: app.haelan.now(),
    })
    return reply.send({ step: currentStep() })
  })

  app.get('/api/setup/last-error', { preHandler: [app.requireSession] }, async (request) => {
    const account = request.accountId ? stores().accounts.getById(request.accountId) : null
    return (account && lastErrors.get(account.personId)) ?? { code: 'none', message: '' }
  })

  app.get('/oauth/start', { preHandler: [app.requireSession] }, async (request, reply) => {
    const account = request.accountId ? stores().accounts.getById(request.accountId) : null
    const client = readableClient()
    const settings = stores().settings.get()
    if (!account || !client || !settings) {
      const step = currentStep()
      return reply.code(409).send(errorBody('setup_incomplete', 'wrong_step', `setup is at the ${step} step`))
    }

    const state = signState(app.haelan.instance.key, {
      personId: account.personId, issuedAtMs: app.haelan.now(),
    })
    return reply.redirect(buildConsentUrl({
      clientId: client.clientId,
      redirectUri: redirectUriFor(settings.baseUrl),
      state,
      authEndpoint: app.haelan.endpoints?.authEndpoint,
    }), 302)
  })

  app.get<{ Querystring: { code?: string, state?: string, error?: string } }>('/oauth/callback', async (request, reply) => {
    // Records nothing: a refusal is about a caller who is not the person the state names.
    const refuse = (code: string) => reply.redirect(`/setup/google?error=${encodeURIComponent(code)}`, 302)
    // Only reached once the state, the session and the single use have all checked out, so the
    // slot it writes belongs to the person who really started this round trip.
    const fail = (personId: string, code: string, message: string) => {
      lastErrors.set(personId, { code, message })
      return refuse(code)
    }

    const state = typeof request.query.state === 'string' ? request.query.state : null
    const payload = state !== null ? verifyState(app.haelan.instance.key, state, app.haelan.now()) : null
    if (!payload || state === null) return refuse('bad_state')
    // The state names a person; only that person's own browser may finish the round trip.
    // Otherwise a consent link opened by someone else stores their Google grant under the
    // person who started it.
    const sessionPerson = sessionPersonId(request)
    if (sessionPerson === null) return refuse('no_session')
    if (sessionPerson !== payload.personId) return refuse('wrong_person')
    if (!consumed.consume(state, payload.issuedAtMs, app.haelan.now())) {
      return refuse('bad_state')
    }
    if (typeof request.query.error === 'string' && request.query.error !== '') {
      return fail(payload.personId, request.query.error, `Google reported ${request.query.error}.`)
    }
    if (typeof request.query.code !== 'string' || request.query.code === '') {
      return fail(payload.personId, 'no_code', 'Google returned no authorization code.')
    }

    const client = readableClient()
    const settings = stores().settings.get()
    if (!client || !settings) return fail(payload.personId, 'wrong_step', 'The OAuth client is no longer configured.')

    // Read before this callback can change it: an invited member granting their own consent
    // reaches this route with setup already 'done' (the admin finished it long ago), and that has
    // to send them past the wizard rather than into it. markSetupComplete below runs unconditionally
    // (it is also how a revoked admin's own fresh grant clears the revocation), so checking after it
    // would find every caller 'done' and this distinction would never fire.
    const alreadySetUp = currentStep() === 'done'

    try {
      const exchanged = await exchangeAuthorizationCode({
        code: request.query.code,
        redirectUri: redirectUriFor(settings.baseUrl),
        client,
        deps: {
          fetch: app.haelan.fetch,
          now: app.haelan.now,
          tokenEndpoint: app.haelan.endpoints?.tokenEndpoint,
        },
      })
      // Before storing anything: a stored token on a project whose API is off produces an
      // instance that reports success and syncs nothing.
      await probeAccess({
        accessToken: exchanged.accessToken,
        deps: { fetch: app.haelan.fetch, apiRoot: app.haelan.endpoints?.apiRoot },
      })
      stores().credentials.putRefreshToken({
        personId: payload.personId,
        refreshToken: exchanged.refreshToken,
        scopes: exchanged.scopes,
        nowMs: app.haelan.now(),
      })
      stores().settings.markSetupComplete(app.haelan.now())
      lastErrors.delete(payload.personId)
      // The wizard's next screen says haelan is walking backwards through the history, so
      // something has to be. Without this the scheduler's first tick is a whole interval away
      // and the backfill screen truthfully reports that nothing has started, for an hour.
      app.haelan.runner.tryStart('setup')
      // A member invited after the admin's own setup finished has no wizard steps left to walk --
      // '/setup/backfill' shows Continue buttons that call an admin only route (PUT
      // /api/settings/backfill-horizon) and no way back to the Dashboard for anyone else. '/' is
      // reachable regardless of who is signed in, and setupGate.ts's own gate is already 'done' by
      // this point (this route runs unauthenticated, and stays open past 'done' by that file's own
      // design), so there is nothing this redirect needs to route around.
      return reply.redirect(alreadySetUp ? '/' : '/setup/backfill', 302)
    } catch (error) {
      return fail(payload.personId, 'exchange_failed', error instanceof Error ? error.message : 'the exchange failed')
    }
  })

  // touch: false because this is a read on the way to a decision, not a request the session is
  // being used for; the session's own routes keep lastSeen.
  function sessionPersonId(request: FastifyRequest): string | null {
    const raw = request.cookies[SESSION_COOKIE]
    if (!raw) return null
    const accountId = stores().sessions.resolve(raw, app.haelan.now(), { touch: false })
    if (!accountId) return null
    const account = stores().accounts.getById(accountId)
    return account && account.disabledAtMs === null ? account.personId : null
  }

  // A client sealed with a key this instance no longer holds is a client neither of these two
  // routes can spend: consent would be started with a secret the callback cannot read back to
  // exchange the code with. It reads as "not configured" here, which is the branch both routes
  // already have and which sends the caller to the step setupStep is already reporting, rather
  // than as a throw out of a handler that has a perfectly good 409 to give.
  function readableClient() {
    return stores().credentials.isClientUnreadable() ? null : stores().credentials.getClient()
  }

  function currentStep() {
    return setupStep({
      accounts: stores().accounts,
      settings: stores().settings,
      credentials: stores().credentials,
      people: stores().people,
    })
  }
}
