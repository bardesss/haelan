import type { FastifyInstance } from 'fastify'
import { ConfigError } from '@haelan/core'
import type { SeriesResult } from '@haelan/core'
import { metricsFrom, personQueryOf, requireString } from './shared.ts'

interface PersonParams { personId: string }

interface ExportQuery {
  format?: string
  metric?: string | string[]
  agg?: string
  from?: string
  to?: string
  source?: string
  // Accepted for parity with the read this covers (Ruling R15), never read.
  points?: string
}

// Ruling R18: sourceMix earns its own column rather than being dropped. coverage and sourceMix
// both state the basis of a merged number, and sourceMix is real JSON on every merged row (see
// merge.ts's encodeMix), so it is what makes the quoting below load bearing on real data: none
// of the other columns can ever hold a comma, a quote or a newline.
const CSV_HEADER = 'localDate,metric,agg,source,value,coverage,sourceMix'

/** RFC 4180: a field needing no quoting is written bare; one with a comma, a quote or a
 *  newline is wrapped in double quotes, with an inner quote doubled. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(',')
}

/** A null coverage, value or sourceMix is an empty field, not the text 'null': the CSV has to
 *  say nothing happened to be measured, not lie that the measurement itself was the word null. */
function orEmpty(value: string | number | null): string {
  return value === null ? '' : String(value)
}

/** One row per point, points in the range's own order, metrics grouped in the order they were
 *  requested. Metric and agg are stamped onto every row rather than read off DailyPoint, since
 *  a plain series() answer carries neither: it is this route that is asking about several
 *  metrics and one agg at once, not the row itself. */
function toCsv(byMetric: Readonly<Record<string, SeriesResult>>, metrics: readonly string[], agg: string): string {
  const lines = [CSV_HEADER]
  for (const metric of metrics) {
    for (const point of byMetric[metric]!.points) {
      lines.push(csvRow([
        point.localDate, metric, agg, point.source,
        orEmpty(point.value), orEmpty(point.coverage), orEmpty(point.sourceMix),
      ]))
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Downloads a `daily` backed read (Ruling R16: this covers that read only, not intraday,
 * sessions or sleep) as csv or json, under the same query parameters `/series` takes.
 *
 * Ruling R15: an export exists to be kept, so `points` is accepted here but never honoured.
 * Every metric answers its whole range and carries `reduction: null`, the same value a caller
 * of `/series` sees when it asks for no thinning; silently thinning what somebody downloads to
 * keep would defeat the reason to export at all.
 *
 * A parameter check, one core call per metric and a serialiser: no try/catch, because
 * registerV1's setErrorHandler turns whatever PersonQuery throws, and the ConfigError below for
 * an unrecognised format, into the right response.
 */
export function registerExportRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams, Querystring: ExportQuery }>('/p/:personId/export', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const format = requireString(request.query.format, 'format')
    if (format !== 'csv' && format !== 'json') {
      throw new ConfigError(`format must be 'csv' or 'json', got '${format}'`)
    }
    const metrics = metricsFrom(request.query.metric)
    const agg = requireString(request.query.agg, 'agg')
    const from = requireString(request.query.from, 'from')
    const to = requireString(request.query.to, 'to')
    const source = request.query.source

    const body: Record<string, SeriesResult> = {}
    for (const metric of metrics) {
      body[metric] = personQuery.series({ metric, agg, from, to, source })
    }

    if (format === 'json') return body

    // Ruling R17: several metrics join in request order with a hyphen, one file, distinguished
    // by the metric column rather than one file per metric.
    const filename = `haelan-${metrics.join('-')}-${from}-${to}.csv`
    reply.header('content-type', 'text/csv; charset=utf-8')
    reply.header('content-disposition', `attachment; filename="${filename}"`)
    return toCsv(body, metrics, agg)
  })
}
