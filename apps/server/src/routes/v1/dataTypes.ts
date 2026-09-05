import type { FastifyInstance } from 'fastify'
import { ConfigError, DATA_TYPES, dataTypeById } from '@haelan/core'
import { sendHashed } from './shared.ts'

interface PersonParams { personId: string }
interface ExcludedBody { excluded?: unknown }

/**
 * GET lists every catalogue type with at least one action - the same `t.actions.length > 0`
 * predicate SyncStateStore.dueJobs (packages/core/src/store/syncState.ts) filters on before
 * grouping jobs by person. That predicate, not `supports(t, 'list')`, is what "fetchable"
 * means here: this screen exists so a person can turn off what the sync engine would otherwise
 * fetch for them, and a type with only `rollUp`/`dailyRollUp`/`reconcile` actions - `floors` and
 * `total-calories` - is still fetched, just never through a `list` call. `supports(t, 'list')`
 * answers a different question (does the runner's status() view have per-item backfill progress
 * to show for this type?) and is rightly narrower; reusing it here would silently make `floors`
 * and `total-calories` impossible for a person to ever turn off through this endpoint. The two
 * filters are deliberately not the same expression and must not be made to agree.
 *
 * On the asymmetry between the two routes below: ExcludedDataTypeStore.setFor accepts any id at
 * all, on purpose, so a row for a type later retired from DATA_TYPES survives as a harmless
 * orphan rather than blocking whatever migration removed it. This route's PUT is stricter than
 * its store, and deliberately so: a request naming an id the catalogue has never declared is not
 * history to preserve, it is a client sending nonsense, and refusing it here is what keeps that
 * distinction from being "fixed" into the store later by someone who assumes the two should agree.
 */
export function registerDataTypeRoutes(app: FastifyInstance): void {
  // app.haelan.stores.excludedDataTypes, not app.haelan.instance.excludedDataTypes: the same
  // object either way (app.ts wires Stores.excludedDataTypes straight from the instance), but
  // runner.ts's own #typesFor reads it through `stores`, and this route used to be the one place
  // reaching around that to the instance directly for no reason tied to what it does.
  const store = () => app.haelan.stores.excludedDataTypes

  app.get<{ Params: PersonParams }>('/p/:personId/data-types', async (request, reply) => {
    const excluded = new Set(store().listFor(request.params.personId))
    const items = DATA_TYPES.filter((t) => t.actions.length > 0).map((t) => ({
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
