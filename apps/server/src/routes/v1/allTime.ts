import type { FastifyInstance } from 'fastify'
import type { AllTime } from '@haelan/core'
import { personQueryOf, sendHashed } from './shared.ts'

interface PersonParams { personId: string }

/**
 * Everything the all-time page shows, in one call.
 *
 * **It takes no parameters at all, and that is the route's whole character.** Every other read on
 * this surface is scoped to a range, because every other page renders one. These are the figures
 * a range cannot answer - the record, the Eddington number, the milestones - which is why M6
 * exists, and a `from` or a `to` here would be a parameter that either lies or does nothing.
 *
 * One route rather than four, for the same reason `PersonQuery.allTime` is one call: they are one
 * page, and four round trips for one screen is four chances to render it half built.
 *
 * The ETag is worth having even without polling. This body changes at most once a day for most
 * households - a record is not beaten often - so a reader moving between pages re-validates
 * rather than re-downloading.
 */
export function registerAllTimeRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams }>('/p/:personId/all-time', async (request, reply) => {
    const result: AllTime = personQueryOf(request).allTime()
    return sendHashed(reply, request, result)
  })
}
