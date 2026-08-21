import type { FastifyInstance } from 'fastify'
import { USER_HORIZON_CHOICES, DEFAULT_USER_HORIZON_DAYS, DATA_TYPES } from '@haelan/core'

interface HorizonBody { days?: unknown }

// Post-setup routes: reachable once the wizard finishes and answered with setup_incomplete
// before that, unlike /api/setup/*, which the gate closes the moment setup is done. The
// backfill horizon belongs here rather than under /api/setup/ because SetupApp shows this
// control on the /setup/backfill screen, which is itself the step after setup is 'done' —
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
  app.put<{ Body: HorizonBody }>('/api/settings/backfill-horizon', { preHandler: [app.requireSession] }, async (request, reply) => {
    const { days } = request.body ?? {}
    if (typeof days !== 'number' || !(USER_HORIZON_CHOICES as readonly number[]).includes(days)) {
      return reply.code(400).send({ error: `days must be one of ${USER_HORIZON_CHOICES.join(', ')}` })
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
          if (!type.listSupported || type.tier !== 'daily') continue
          stores().syncState.clearBackfillComplete(person.id, type.id)
        }
      }
    }
    return reply.send({ backfillHorizonDays: days })
  })
}
