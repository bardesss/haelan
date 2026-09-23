import type { FastifyInstance } from 'fastify'
import { localDateInZone } from '@haelan/core'
import type { Glance } from '@haelan/core'
import { personQueryOf, sendHashed } from './shared.ts'

interface PersonParams { personId: string }

/**
 * The glance (M9a): last night, today's recovery and today so far, for the dashboard and the
 * native app. No parameters, like /all-time: today is the person's own civil date in their own
 * zone, decided here, so the web page and the phone cannot disagree about which day it is.
 *
 * Source names are resolved here rather than in core, because an alias is instance state and
 * PersonQuery reads only what the person's rows say. Hashed rather than stamped: the body mixes
 * nights, samples and daily rows, and no single stamp covers all three.
 */
export function registerGlanceRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams }>('/p/:personId/glance', async (request, reply) => {
    const { personId } = request.params
    const nowMs = app.haelan.now()
    const person = app.haelan.stores.people.get(personId)
    const today = localDateInZone(nowMs, person?.timezone ?? 'UTC')
    const names = new Map(app.haelan.instance.sourceAliases.listNamed(personId).map((s) => [s.id, s.name]))
    const result: Glance = personQueryOf(request).glance({ today, nowMs, nameOf: (id) => names.get(id) ?? id })
    return sendHashed(reply, request, result)
  })
}
