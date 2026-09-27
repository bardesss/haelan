import type { FastifyInstance } from 'fastify'
import {
  ConfigError, localDateInZone, localDateOf, quickLogInstant, quickLogPresetsOf, readDayLog,
  requireDate, shiftLocalDate,
} from '@haelan/core'
import type { PersonRow } from '@haelan/core'
import { oneNightPerDate } from '@haelan/core/nights'
import {
  personIdOf, personQueryOf, requireDateRange, sendHashed, textField,
} from './shared.ts'

interface PersonParams { personId: string }
interface DayParams extends PersonParams { localDate: string }
interface PresetsBody { kinds?: unknown }
interface QuickLogBody { kind?: unknown, day?: unknown }
interface MoodBody { score?: unknown }
interface DateRangeQuery { from?: string, to?: string }

/**
 * The chips, the caffeine-tap button and the day's own log (M9c): a person's presets, a POST that
 * files an event under a day rather than only "now", and the moods that ride alongside it. Follows
 * annotations.ts's idiom (manual validation, ConfigError for a 400, sendHashed on the GETs) since
 * this is that file's sibling, one door down: the same plugin, the same guard, the same envelope.
 */
export function registerQuickLogRoutes(app: FastifyInstance): void {
  // The person's zone and today, as the glance route reads them, so the panel and the glance
  // cannot disagree about which day it is.
  function personAndToday(personId: string): { person: PersonRow, nowMs: number, today: string } {
    const person = app.haelan.stores.people.get(personId)
    if (person === null) throw new ConfigError('no such person')
    const nowMs = app.haelan.now()
    return { person, nowMs, today: localDateInZone(nowMs, person.timezone) }
  }

  // `field` names the caller's own parameter in the 400 (`day` for the POST body, `localDate` for
  // the two path params), the same way requiredNumberField names an event's `startedAtMs`: a
  // malformed `day` must not be reported back to the caller as a problem with `localDate`, a name
  // that appears nowhere in that request.
  function notAfterToday(field: string, value: string, today: string): void {
    requireDate(field, value)
    if (value > today) throw new ConfigError(`${value} is after today`)
  }

  app.get<{ Params: PersonParams }>('/p/:personId/quick-log/presets', async (request, reply) => {
    const { person } = personAndToday(personIdOf(request))
    return sendHashed(reply, request, { kinds: quickLogPresetsOf(person) })
  })

  app.put<{ Params: PersonParams, Body: PresetsBody }>('/p/:personId/quick-log/presets', async (request, reply) => {
    const personId = personIdOf(request)
    const kinds = app.haelan.stores.people.setQuickLogPresets(personId, (request.body ?? {}).kinds)
    return reply.send({ kinds })
  })

  app.post<{ Params: PersonParams, Body: QuickLogBody }>('/p/:personId/quick-log', async (request, reply) => {
    const personId = personIdOf(request)
    const body = request.body ?? {}
    const kind = textField(body.kind, 'kind')
    const day = textField(body.day, 'day')
    const { person, nowMs, today } = personAndToday(personId)
    notAfterToday('day', day, today)

    // The main night that followed `day` (mapSessions.ts:55: a night is filed under the morning
    // it ended in, so the night that followed day D is filed under D+1), not one on `day` itself.
    // Today skips the lookup entirely: quickLogInstant only reads nightStartMs on a past day.
    const following = shiftLocalDate(day, 1)
    const night = day === today ? null
      : oneNightPerDate(personQueryOf(request).sleepNights({ from: following, to: following }))[0] ?? null
    const at = quickLogInstant({
      day, today, nowMs, timeZone: person.timezone, nightStartMs: night?.startMs ?? null,
    })
    const id = app.haelan.instance.events.add({ personId, kind, ...at })
    // localDate resolved the same way EventStore.listFor resolves every row's own (localDateOf on
    // the instant and offset just computed), not merely echoed back as `day`: quickLogInstant
    // clamps its instant to stay inside `day`, so the two agree, but this is what makes them agree
    // by construction rather than by coincidence a future change to either could quietly break.
    const localDate = localDateOf(at.startedAtMs, at.startedAtOffsetMinutes)
    return reply.send({
      id, kind, ...at, endedAtMs: null, endedAtOffsetMinutes: null, value: null, note: null, localDate,
    })
  })

  app.get<{ Params: DayParams }>('/p/:personId/quick-log/day/:localDate', async (request, reply) => {
    const { person, today } = personAndToday(personIdOf(request))
    notAfterToday('localDate', request.params.localDate, today)
    return sendHashed(reply, request, readDayLog(app.haelan.instance, person, request.params.localDate))
  })

  app.get<{ Params: PersonParams, Querystring: DateRangeQuery }>('/p/:personId/moods', async (request, reply) => {
    const personId = personIdOf(request)
    const { from, to } = requireDateRange(request.query)
    const items = app.haelan.instance.moods.listFor(personId, from, to)
    return sendHashed(reply, request, { items })
  })

  app.put<{ Params: DayParams, Body: MoodBody }>('/p/:personId/moods/:localDate', async (request, reply) => {
    const personId = personIdOf(request)
    const { today } = personAndToday(personId)
    const localDate = request.params.localDate
    notAfterToday('localDate', localDate, today)
    const body = request.body ?? {}
    // Narrowed here rather than left to MoodStore.put's own Number.isInteger check, which throws
    // the same ConfigError for a non-number and for a fractional or out-of-range one alike: this
    // route's own message names `score` specifically, the same way requiredNumberField does for an
    // event's startedAtMs, before the value ever reaches the store.
    if (typeof body.score !== 'number') throw new ConfigError('score must be a number')
    const score = body.score
    app.haelan.instance.moods.put({ personId, localDate, score, nowMs: app.haelan.now() })
    return reply.send({ localDate, score })
  })

  app.delete<{ Params: DayParams }>('/p/:personId/moods/:localDate', async (request, reply) => {
    const personId = personIdOf(request)
    const { today } = personAndToday(personId)
    const localDate = request.params.localDate
    // The same shape the PUT above validates with, for consistency: a malformed date is refused
    // the same way on either verb, and a future date is refused rather than silently removing a
    // mood that could never have been written through this route in the first place.
    notAfterToday('localDate', localDate, today)
    app.haelan.instance.moods.remove({ personId, localDate })
    return reply.send({ localDate })
  })
}
