import type { FastifyInstance } from 'fastify'
import { USER_HORIZON_CHOICES, DEFAULT_USER_HORIZON_DAYS } from '@haelan/core'

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
    stores().settings.putBackfillHorizon(days, app.haelan.now())
    return reply.send({ backfillHorizonDays: days })
  })
}
