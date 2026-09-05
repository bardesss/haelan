import type { FastifyInstance } from 'fastify'
import { ConfigError, DATA_TYPES, dataTypeById, supports } from '@haelan/core'
import { sendHashed } from './shared.ts'

interface PersonParams { personId: string }
interface ExcludedBody { excluded?: unknown }

/**
 * The screen this feeds is a picker, not an inventory: only the catalogue types Google Health
 * answers a `list` request for are things a person can recognise well enough to choose among.
 * `floors` and `total-calories`, for instance, are fetched through `rollUp`/`dailyRollUp` alone
 * (see catalogue.ts) and never appear here, though the exclusion still applies to them -
 * ExcludedDataTypeStore and the sync runner's own filtering (runner.ts's `#typesFor`) both work
 * over the whole catalogue, not this route's listable slice. A person can still turn `floors` off,
 * just not from this particular list; nothing about the store or the sync engine needed to change.
 *
 * On the asymmetry between the two routes below: ExcludedDataTypeStore.setFor accepts any id at
 * all, on purpose, so a row for a type later retired from DATA_TYPES survives as a harmless
 * orphan rather than blocking whatever migration removed it. This route's PUT is stricter than
 * its store, and deliberately so: a request naming an id the catalogue has never declared is not
 * history to preserve, it is a client sending nonsense, and refusing it here is what keeps that
 * distinction from being "fixed" into the store later by someone who assumes the two should agree.
 */
export function registerDataTypeRoutes(app: FastifyInstance): void {
  const store = () => app.haelan.instance.excludedDataTypes

  app.get<{ Params: PersonParams }>('/p/:personId/data-types', async (request, reply) => {
    const excluded = new Set(store().listFor(request.params.personId))
    const items = DATA_TYPES.filter((t) => supports(t, 'list')).map((t) => ({
      id: t.id,
      tier: t.tier,
      excluded: excluded.has(t.id),
    }))
    return sendHashed(reply, request, { items })
  })

  app.put<{ Params: PersonParams, Body: ExcludedBody }>('/p/:personId/data-types', async (request, reply) => {
    const { personId } = request.params
    const { excluded } = request.body ?? {}
    if (!Array.isArray(excluded) || !excluded.every((id) => typeof id === 'string')) {
      throw new ConfigError('excluded must be an array of strings')
    }
    for (const id of excluded) {
      if (dataTypeById(id) === undefined) throw new ConfigError(`no such data type '${id}'`)
    }
    store().setFor({ personId, dataTypeIds: excluded, nowMs: app.haelan.now() })
    // Read back rather than echoing the request body, the same reason sources.ts's alias routes
    // do: what setFor actually stored (deduplicated) is what the next GET will say, and the two
    // must never be able to drift apart.
    return reply.send({ excluded: store().listFor(personId) })
  })
}
