import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { setupStep, CONSENT_PATHS, SCOPES, USER_HORIZON_CHOICES, DEFAULT_USER_HORIZON_DAYS } from '@haelan/core'
import type { ConsentPath } from '@haelan/core'
import { setSessionCookie } from '../auth/cookie.ts'
import { candidateFor, loopbackCandidates, redirectUriFor } from '../oauth/redirectUri.ts'

interface AccountBody { username?: unknown, password?: unknown, displayName?: unknown, timezone?: unknown }
interface InstanceUrlBody { baseUrl?: unknown, consentPath?: unknown }
interface HorizonBody { days?: unknown }

export function registerSetup(app: FastifyInstance): void {
  const stores = () => app.haelan.stores
  const step = () => setupStep({
    accounts: stores().accounts, settings: stores().settings, credentials: stores().credentials,
  })

  app.post<{ Body: AccountBody }>('/api/setup/account', async (request, reply) => {
    if (step() !== 'account') return reply.code(409).send({ error: 'account_exists' })
    const { username, password, displayName, timezone } = request.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string'
      || typeof displayName !== 'string' || typeof timezone !== 'string') {
      return reply.code(400).send({ error: 'username, password, displayName and timezone are required' })
    }
    if (password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' })
    if (!isKnownTimezone(timezone)) return reply.code(400).send({ error: `unknown timezone ${timezone}` })

    const personId = randomUUID()
    const nowMs = app.haelan.now()
    // The person row must exist before the account's foreign key can point at it, and hashing
    // is async so this cannot be one better-sqlite3 transaction. The catch is the rollback:
    // an instance with a person and no account cannot be recovered through the wizard.
    stores().people.create({ id: personId, displayName, timezone, nowMs })
    try {
      const account = await stores().accounts.create({
        id: randomUUID(), personId, username, password, isAdmin: true, nowMs,
      })
      setSessionCookie(request, reply, stores().sessions.create(account.id, nowMs))
      return reply.code(201).send({ personId, step: step() })
    } catch (error) {
      stores().people.remove(personId)
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'could not create the account' })
    }
  })

  app.post<{ Body: InstanceUrlBody }>('/api/setup/instance-url', async (request, reply) => {
    if (step() !== 'instance-url') return reply.code(409).send({ error: 'wrong_step', step: step() })
    const { baseUrl, consentPath } = request.body ?? {}
    if (typeof baseUrl !== 'string' || typeof consentPath !== 'string'
      || !(CONSENT_PATHS as readonly string[]).includes(consentPath)) {
      return reply.code(400).send({ error: 'baseUrl and a known consentPath are required' })
    }
    const candidate = candidateFor(baseUrl)
    if (!candidate.registrable) {
      return reply.code(400).send({ error: candidate.reason ?? 'that URL cannot be registered with Google' })
    }
    const normalized = baseUrl.replace(/\/+$/, '')
    stores().settings.put({ baseUrl: normalized, consentPath: consentPath as ConsentPath, nowMs: app.haelan.now() })
    return reply.send({ step: step(), redirectUri: redirectUriFor(normalized) })
  })

  app.get<{ Querystring: { host?: string } }>('/api/setup/redirect-uris', async (request, reply) => {
    const candidates = [...loopbackCandidates(portOf(request.headers.host))]
    const host = request.query.host
    if (typeof host === 'string' && host.trim() !== '') candidates.push(candidateFor(host))
    return reply.send({ candidates })
  })

  // Served rather than restated in the browser bundle, so the list the wizard shows and the
  // list buildConsentUrl requests are the same array. A wizard that told somebody to declare
  // five scopes and then asked for six would fail at consent, having been the reason.
  app.get('/api/setup/scopes', async (_request, reply) => reply.send({ scopes: [...SCOPES] }))

  // Unlike scopes above, both of these carry requireSession: the horizon is an operator choice
  // made by a logged-in account, not something an unauthenticated visitor needs mid-wizard.
  app.get('/api/setup/backfill-horizon', { preHandler: [app.requireSession] }, async (_request, reply) =>
    reply.send({
      days: stores().settings.get()?.backfillHorizonDays ?? DEFAULT_USER_HORIZON_DAYS,
      choices: [...USER_HORIZON_CHOICES],
    }))

  // Constrained to the three offered values rather than any integer: the cost of a horizon is
  // not linear in it, and the wizard shows a measured disk figure beside each of the three.
  app.put<{ Body: HorizonBody }>('/api/setup/backfill-horizon', { preHandler: [app.requireSession] }, async (request, reply) => {
    const { days } = request.body ?? {}
    if (typeof days !== 'number' || !(USER_HORIZON_CHOICES as readonly number[]).includes(days)) {
      return reply.code(400).send({ error: `days must be one of ${USER_HORIZON_CHOICES.join(', ')}` })
    }
    stores().settings.putBackfillHorizon(days, app.haelan.now())
    return reply.send({ backfillHorizonDays: days })
  })
}

function portOf(hostHeader: string | undefined): number {
  const parsed = Number(hostHeader?.split(':')[1])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4235
}

function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}
