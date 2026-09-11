import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { setupStep, CONSENT_PATHS, SCOPES } from '@haelan/core'
import type { ConsentPath } from '@haelan/core'
import { setSessionCookie } from '../auth/cookie.ts'
import { candidateFor, loopbackCandidates, redirectUriFor } from '../oauth/redirectUri.ts'
import { errorBody } from '../api/envelope.ts'

interface AccountBody { username?: unknown, password?: unknown, displayName?: unknown, timezone?: unknown }
interface InstanceUrlBody { baseUrl?: unknown, consentPath?: unknown }

export function registerSetup(app: FastifyInstance): void {
  const stores = () => app.haelan.stores
  const step = () => setupStep({
    accounts: stores().accounts, settings: stores().settings, credentials: stores().credentials,
  })

  // The account step is the only open one, because it mints the session every step after it
  // presents. Leaving the rest open let an unauthenticated caller set the base URL that consent
  // is then required to match.
  app.post<{ Body: AccountBody }>('/api/setup/account', async (request, reply) => {
    if (step() !== 'account') return reply.code(409).send(errorBody('setup_incomplete', 'account_exists', 'an account already exists'))
    const { username, password, displayName, timezone } = request.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string'
      || typeof displayName !== 'string' || typeof timezone !== 'string') {
      return reply.code(400).send(errorBody('config', 'config', 'username, password, displayName and timezone are required'))
    }
    if (password.length < 8) return reply.code(400).send(errorBody('config', 'config', 'password must be at least 8 characters'))
    if (!isKnownTimezone(timezone)) return reply.code(400).send(errorBody('config', 'config', `unknown timezone ${timezone}`))

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
      return reply.code(400).send(errorBody('config', 'config', error instanceof Error ? error.message : 'could not create the account'))
    }
  })

  app.post<{ Body: InstanceUrlBody }>('/api/setup/instance-url', { preHandler: [app.requireSession] }, async (request, reply) => {
    if (step() !== 'instance-url') {
      const current = step()
      return reply.code(409).send(errorBody('setup_incomplete', 'wrong_step', `setup is at the ${current} step`))
    }
    const { baseUrl, consentPath } = request.body ?? {}
    if (typeof baseUrl !== 'string' || typeof consentPath !== 'string'
      || !(CONSENT_PATHS as readonly string[]).includes(consentPath)) {
      return reply.code(400).send(errorBody('config', 'config', 'baseUrl and a known consentPath are required'))
    }
    const candidate = candidateFor(baseUrl)
    if (!candidate.registrable) {
      return reply.code(400).send(errorBody('config', 'config', candidate.reason ?? 'that URL cannot be registered with Google'))
    }
    // The validated origin rather than the trimmed input, for the reason the settings route's
    // twin gives: a bare host is accepted as https and must be stored that way, or every consent
    // built from this row carries a redirect with no scheme.
    const normalized = candidate.origin
    stores().settings.put({ baseUrl: normalized, consentPath: consentPath as ConsentPath, nowMs: app.haelan.now() })
    return reply.send({ step: step(), redirectUri: redirectUriFor(normalized) })
  })

  app.get<{ Querystring: { host?: string } }>('/api/setup/redirect-uris', { preHandler: [app.requireSession] }, async (request, reply) => {
    const candidates = [...loopbackCandidates(portOf(request.headers.host))]
    const host = request.query.host
    if (typeof host === 'string' && host.trim() !== '') candidates.push(candidateFor(host))
    return reply.send({ candidates })
  })

  // Served rather than restated in the browser bundle, so the list the wizard shows and the
  // list buildConsentUrl requests are the same array. A wizard that told somebody to declare
  // five scopes and then asked for six would fail at consent, having been the reason.
  app.get('/api/setup/scopes', { preHandler: [app.requireSession] }, async (_request, reply) => reply.send({ scopes: [...SCOPES] }))
}

function portOf(hostHeader: string | undefined): number {
  const parsed = Number(hostHeader?.split(':')[1])
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4235
}

export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}
