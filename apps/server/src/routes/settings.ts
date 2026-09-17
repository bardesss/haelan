import type { FastifyInstance } from 'fastify'
import { USER_HORIZON_CHOICES, DEFAULT_USER_HORIZON_DAYS, DATA_TYPES, supports } from '@haelan/core'
import { errorBody } from '../api/envelope.ts'
import { candidateFor, redirectUriFor } from '../oauth/redirectUri.ts'
import { checkForUpdate } from '../updates.ts'

interface HorizonBody { days?: unknown }
interface InstanceUrlBody { baseUrl?: unknown }
interface UpdateCheckBody { enabled?: unknown }

// Post-setup routes: reachable once the wizard finishes and answered with setup_incomplete
// before that, unlike /api/setup/*, which the gate closes the moment setup is done. The
// backfill horizon belongs here rather than under /api/setup/ because SetupApp shows this
// control on the /setup/backfill screen, which is itself the step after setup is 'done',
// putting the route under the gate that gets closed at exactly that step would make it
// unreachable in production.
export function registerSettings(app: FastifyInstance): void {
  const stores = () => app.haelan.stores

  app.get('/api/settings/backfill-horizon', { preHandler: [app.requireSession] }, async (_request, reply) =>
    reply.send({
      days: stores().settings.get()?.backfillHorizonDays ?? DEFAULT_USER_HORIZON_DAYS,
      choices: [...USER_HORIZON_CHOICES],
    }))

  // Constrained to the three offered values rather than any integer: the cost of a horizon is
  // not linear in it, and the wizard shows a measured disk figure beside each of the three.
  //
  // requireAdmin, not requireSession alone: this setting is instance-wide (it drives every
  // person's backfill, not just the caller's own), the exact thing requireAdmin's own comment
  // says it exists to gate. The GET above stays on requireSession - reading the current horizon
  // leaks nothing an ordinary member should not see.
  app.put<{ Body: HorizonBody }>('/api/settings/backfill-horizon', { preHandler: [app.requireSession, app.requireAdmin] }, async (request, reply) => {
    const { days } = request.body ?? {}
    if (typeof days !== 'number' || !(USER_HORIZON_CHOICES as readonly number[]).includes(days)) {
      return reply.code(400).send(errorBody('config', 'config', `days must be one of ${USER_HORIZON_CHOICES.join(', ')}`))
    }
    const previousDays = stores().settings.get()?.backfillHorizonDays ?? DEFAULT_USER_HORIZON_DAYS
    stores().settings.putBackfillHorizon(days, app.haelan.now())
    // A raise must re-aim any daily-tier type that already finished under the old, shallower
    // floor, or the change would do nothing for it - runBackfill returns immediately once a
    // type is marked complete and nothing else ever clears that mark. Intraday types are left
    // alone: horizonDaysFor pins them to INTRADAY_HORIZON_DAYS regardless of this setting, so
    // clearing their mark would only spend a no-op runBackfill call confirming what was already
    // true. A lower or equal value needs no clearing - the walk already reached at least that
    // far, and nothing here deletes what is on disk.
    if (days > previousDays) {
      for (const person of stores().people.list()) {
        for (const type of DATA_TYPES) {
          if (!supports(type, 'list') || type.tier !== 'daily') continue
          stores().syncState.clearBackfillComplete(person.id, type.id)
        }
      }
    }
    return reply.send({ backfillHorizonDays: days })
  })

  // POST /api/setup/instance-url writes this value once and then 409s forever, which left moving
  // an instance - the homelab this was written for - with no supported route at all. Ongoing sync
  // survives a stale value (the refresh grant in packages/core/src/api/tokens.ts sends no
  // redirect_uri), so nothing appears to be wrong; what breaks is every later consent, because
  // those build their redirect from this. A household finds that out the day they add a member.
  //
  // The GET stays on requireSession alone, like the horizon's: this is the address the member
  // already typed into their own browser, and the redirect beside it is a public OAuth parameter.
  app.get('/api/settings/instance-url', { preHandler: [app.requireSession] }, async (_request, reply) => {
    // The setup gate answers setup_incomplete for this whole family until the wizard is done, and
    // a wizard that got to done wrote this row, so the fallback is for the type rather than for a
    // state this route can be reached in.
    const baseUrl = stores().settings.get()?.baseUrl ?? ''
    return reply.send({ baseUrl, redirectUri: redirectUriFor(baseUrl) })
  })

  // requireAdmin for the reason the horizon above gives: one value the whole instance consents
  // against, not the caller's own. Stronger here than there, in fact - a wrong value costs every
  // member their next consent, including the admin's own recovery from a revoked token.
  app.put<{ Body: InstanceUrlBody }>('/api/settings/instance-url', { preHandler: [app.requireSession, app.requireAdmin] }, async (request, reply) => {
    const { baseUrl } = request.body ?? {}
    if (typeof baseUrl !== 'string') {
      return reply.code(400).send(errorBody('config', 'config', 'baseUrl is required'))
    }
    // candidateFor rather than a check of this route's own: it carries Google's rules quoted from
    // the console, and it is what the wizard refused the same value with. A second, looser opinion
    // here would accept an address the console then rejects, which is the failure this route
    // exists to prevent rather than relocate.
    const candidate = candidateFor(baseUrl)
    if (!candidate.registrable) {
      return reply.code(400).send(errorBody('config', 'config', candidate.reason ?? 'that URL cannot be registered with Google'))
    }
    // candidate.origin, not the trimmed input: candidateFor reads a bare host as https and
    // accepts it, so storing what was typed would keep `homelab.example.com` and send Google a
    // redirect with no scheme at all. What was validated is what gets stored.
    const normalized = candidate.origin
    stores().settings.putBaseUrl(normalized, app.haelan.now())
    // The stored value put through redirectUriFor, which is the same call every consent makes, so
    // what the panel tells somebody to register is the string Google will actually be sent.
    return reply.send({ baseUrl: normalized, redirectUri: redirectUriFor(normalized) })
  })

  /**
   * Whether a newer release exists, and whether this instance is allowed to ask.
   *
   * requireSession rather than requireAdmin: knowing the version behind the one you are running is
   * not an instance secret, and the reader who most needs to know is whoever notices something is
   * broken. Only turning the check on is an admin's to do, which is the PUT below.
   *
   * Switched off, this answers immediately with nothing known and never touches the network -
   * which is also what makes the disabled state honest rather than merely hidden: there is no
   * cached answer sitting behind the flag from before it was turned off.
   */
  app.get('/api/settings/update', { preHandler: [app.requireSession] }, async (_request, reply) => {
    if (!stores().settings.updateCheckEnabled()) {
      return reply.send({ enabled: false, latest: null, checkedAtMs: null, reachable: true })
    }
    // Never throws: updates.ts turns every failure into `reachable: false`, so an instance with no
    // outbound network answers this route as fast as one that is up to date.
    const result = await checkForUpdate(app.haelan.now())
    return reply.send({ enabled: true, ...result })
  })

  // requireAdmin for the reason the two settings above give, with one of its own: this is the
  // switch that decides whether this instance talks to a third party at all, which is a household
  // decision rather than a reader's preference.
  app.put<{ Body: UpdateCheckBody }>('/api/settings/update', { preHandler: [app.requireSession, app.requireAdmin] }, async (request, reply) => {
    const { enabled } = request.body ?? {}
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send(errorBody('config', 'config', 'enabled must be true or false'))
    }
    stores().settings.putUpdateCheckEnabled(enabled, app.haelan.now())
    // The new state read back through the same shape the GET answers with, so the page that just
    // switched this on can show the answer without a second request. Turning it on asks GitHub
    // straight away, which is what a reader who just pressed the switch is waiting to see.
    if (!enabled) return reply.send({ enabled: false, latest: null, checkedAtMs: null, reachable: true })
    const result = await checkForUpdate(app.haelan.now())
    return reply.send({ enabled: true, ...result })
  })
}
