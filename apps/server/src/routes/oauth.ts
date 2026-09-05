import type { FastifyInstance } from 'fastify'
import { buildConsentUrl, exchangeAuthorizationCode, probeAccess, setupStep } from '@haelan/core'
import { redirectUriFor } from '../oauth/redirectUri.ts'
import { signState, verifyState } from '../oauth/state.ts'

interface ClientBody { clientId?: unknown, clientSecret?: unknown }

export function registerOauth(app: FastifyInstance): void {
  const stores = () => app.haelan.stores
  // One slot, overwritten per attempt. The wizard reads it immediately after a failed callback
  // and nothing else ever does, so persisting it would outlive its only reader.
  let lastError: { code: string, message: string } | null = null

  app.post<{ Body: ClientBody }>('/api/setup/google-client', { preHandler: [app.requireSession] }, async (request, reply) => {
    const { clientId, clientSecret } = request.body ?? {}
    if (typeof clientId !== 'string' || typeof clientSecret !== 'string'
      || clientId.trim() === '' || clientSecret.trim() === '') {
      return reply.code(400).send({ error: 'clientId and clientSecret are required' })
    }
    if (!clientId.trim().endsWith('.apps.googleusercontent.com')) {
      // A cheap check that catches the commonest paste error while the owner is still in the
      // console. It is not validation: only the exchange can validate.
      return reply.code(400).send({ error: 'that does not look like a client ID. It ends in .apps.googleusercontent.com' })
    }
    stores().credentials.putClient({
      clientId: clientId.trim(), clientSecret: clientSecret.trim(), nowMs: app.haelan.now(),
    })
    return reply.send({ step: currentStep() })
  })

  app.get('/api/setup/last-error', { preHandler: [app.requireSession] }, async () => lastError ?? { code: 'none', message: '' })

  app.get('/oauth/start', { preHandler: [app.requireSession] }, async (request, reply) => {
    const account = request.accountId ? stores().accounts.getById(request.accountId) : null
    const client = stores().credentials.getClient()
    const settings = stores().settings.get()
    if (!account || !client || !settings) return reply.code(409).send({ error: 'wrong_step', step: currentStep() })

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
    const fail = (code: string, message: string) => {
      lastError = { code, message }
      return reply.redirect(`/setup/google?error=${code}`, 302)
    }

    if (typeof request.query.error === 'string' && request.query.error !== '') {
      return fail(request.query.error, `Google reported ${request.query.error}.`)
    }
    const payload = typeof request.query.state === 'string'
      ? verifyState(app.haelan.instance.key, request.query.state, app.haelan.now())
      : null
    if (!payload) return fail('bad_state', 'The consent round trip could not be matched to this instance. Start the connect step again.')
    if (typeof request.query.code !== 'string' || request.query.code === '') {
      return fail('no_code', 'Google returned no authorization code.')
    }

    const client = stores().credentials.getClient()
    const settings = stores().settings.get()
    if (!client || !settings) return fail('wrong_step', 'The OAuth client is no longer configured.')

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
      lastError = null
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
      return fail('exchange_failed', error instanceof Error ? error.message : 'the exchange failed')
    }
  })

  function currentStep() {
    return setupStep({ accounts: stores().accounts, settings: stores().settings, credentials: stores().credentials })
  }
}
