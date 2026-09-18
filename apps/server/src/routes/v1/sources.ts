import type { FastifyInstance, FastifyReply } from 'fastify'
import { getSource, readSourceActivity, localDateInZone, DEFAULT_LIST, fallbackOrder } from '@haelan/core'
import { errorBody, statusFor } from '../../api/envelope.ts'
import { sendHashed } from './shared.ts'

interface PersonParams { personId: string }
interface SourceParams extends PersonParams { sourceId: string }
interface AliasBody { alias?: unknown }

/**
 * The listing this project has never had, and the rename it enables.
 *
 * A rename enqueues no re-derive and marks no day dirty: a name is not an input to any derived
 * value, which makes these the only write routes on this surface with no invalidation to think
 * about. Nothing here bumps DERIVATION_VERSION or MAPPING_VERSION.
 */
export function registerSourceRoutes(app: FastifyInstance): void {
  const aliases = () => app.haelan.instance.sourceAliases

  app.get<{ Params: PersonParams, Querystring: { activity?: string } }>('/p/:personId/sources', async (request, reply) => {
    const { personId } = request.params
    // Opt in, because this listing is not only the settings card's. useSourceNames backs
    // ControlRow and IntradayHeartRate too, so every page in the app hits this route for the
    // names alone - and computing staleness measured 19-60ms against a real archive, growing
    // with the daily row count and the number of people. One caller shows it; one caller asks.
    if (request.query.activity !== '1') {
      return sendHashed(reply, request, { items: aliases().listNamed(personId) })
    }
    // Composed here rather than inside the store: a name is stored state and an activity is
    // computed from `daily`, and NamedSource is shared with M4's tools, which want neither.
    //
    // Today is the person's own civil date, not the server's: a source is judged against the
    // household's day, which is the same reason every derived row is keyed by a local date.
    const person = app.haelan.stores.people.get(personId)
    const today = localDateInZone(app.haelan.now(), person?.timezone ?? 'UTC')
    const activity = new Map(
      readSourceActivity(app.haelan.instance.db, personId, { today }).map((a) => [a.sourceId, a]),
    )
    const items = aliases().listNamed(personId).map((source) => {
      // A source with no daily row at all is not left out and not crashed on: it is reported as
      // having never reported, which is a real state - the archive measured had a source row
      // with no rows behind it.
      const seen = activity.get(source.id)
      return {
        ...source,
        lastReportedDate: seen?.lastReportedDate ?? null,
        reportingDates: seen?.reportingDates ?? 0,
        medianGapDays: seen?.medianGapDays ?? null,
        status: seen?.status ?? 'unjudged',
        reportingNow: seen?.reportingNow ?? false,
      }
    })
    return sendHashed(reply, request, { items })
  })

  app.put<{ Params: SourceParams, Body: AliasBody }>('/p/:personId/sources/:sourceId/alias', async (request, reply) => {
    const { personId, sourceId } = request.params
    const { alias } = request.body ?? {}
    if (typeof alias !== 'string') {
      return reply.code(statusFor('config')).send(errorBody('config', 'config', 'alias must be a string'))
    }
    // Checked here so the answer is not_found rather than the store's ConfigError, and checked
    // against the person from the path, which the plugin's guard has already proved is the
    // caller's own. A source belonging to somebody else reads exactly like one that is not there.
    if (!getSource(app.haelan.instance.db, personId, sourceId)) return notThere(reply, sourceId)

    // A ConfigError from the store (empty, too long, already taken) propagates to registerV1's
    // error handler, which serialises it as a 400 with the store's own message.
    aliases().put({ personId, sourceId, alias, nowMs: app.haelan.now() })
    return reply.send({ name: currentName(app, personId, sourceId) })
  })

  app.delete<{ Params: SourceParams }>('/p/:personId/sources/:sourceId/alias', async (request, reply) => {
    const { personId, sourceId } = request.params
    if (!getSource(app.haelan.instance.db, personId, sourceId)) return notThere(reply, sourceId)
    aliases().clear({ personId, sourceId })
    return reply.send({ name: currentName(app, personId, sourceId) })
  })

  /**
   * The person's ranking, resolved. apps/web imports only core's browser-safe subpaths, never the
   * root export that pulls better-sqlite3 and drizzle into the browser bundle, and priorityFrom
   * and fallbackOrder both live in the root - so the browser has no way to work out where an
   * unconfigured source would fall. Resolving the fallback placement here, rather than shipping
   * the stored list alone, is the whole reason this route exists instead of a plain read of
   * source_priority.
   *
   * `configured` is answered twice on purpose: once for the list as a whole and once per source.
   * A person needs to see which sources they actually placed versus which are merely sitting
   * where the default put them, because the two behave differently the moment a new source shows
   * up - a placed source keeps its spot, an unplaced one moves.
   */
  app.get<{ Params: PersonParams }>('/p/:personId/source-priority', async (request, reply) => {
    const { personId } = request.params
    const stored = app.haelan.instance.sourcePriority.lists(personId)
      .find((list) => list.metric === DEFAULT_LIST)
    const configuredIds = stored?.sourceIds ?? []
    // fallbackOrder wants only id and kind; listNamed's rows carry both plus the display fields
    // the rest of this file already needs aliases() for, so this reuses the same call instead of
    // opening a second, narrower query onto the sources table.
    const rest = fallbackOrder(aliases().listNamed(personId)).filter((id) => !configuredIds.includes(id))
    return sendHashed(reply, request, {
      configured: stored !== undefined,
      order: [
        ...configuredIds.map((sourceId) => ({ sourceId, configured: true })),
        ...rest.map((sourceId) => ({ sourceId, configured: false })),
      ],
    })
  })
}

function notThere(reply: FastifyReply, sourceId: string): FastifyReply {
  return reply.code(statusFor('not_found')).send(errorBody('not_found', 'no_such_source', `no source ${sourceId}`))
}

/**
 * Read back rather than computed from the request, so the answer is what the next GET will say.
 * A caller that renamed a source gets the resolved name without a second round trip, and one that
 * cleared it gets the provider's name it fell back to.
 */
function currentName(app: FastifyInstance, personId: string, sourceId: string): string {
  const found = app.haelan.instance.sourceAliases.listNamed(personId).find((s) => s.id === sourceId)
  return found?.name ?? sourceId
}
