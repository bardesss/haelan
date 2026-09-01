import type { FastifyInstance } from 'fastify'
import { ConfigError } from '@haelan/core'
import type { SeriesResult } from '@haelan/core'
import { metricsFrom, personQueryOf, requireString, roundSeriesResult, sendHashed } from './shared.ts'

interface PersonParams { personId: string }

interface ExportQuery {
  format?: string
  metric?: string | string[]
  agg?: string
  from?: string
  to?: string
  source?: string
  // Declared so the handler can refuse it by name rather than let it fall through as an unknown
  // parameter. See the refusal below for why this route has no thinning to offer.
  points?: string
}

// Ruling R18: sourceMix earns its own column rather than being dropped. coverage and sourceMix
// both state the basis of a merged number, and sourceMix is real JSON on every merged row (see
// merge.ts's encodeMix), so it is what makes the quoting below load bearing on real data: none
// of the other columns can ever hold a comma, a quote or a newline.
const CSV_HEADER = 'localDate,metric,agg,source,value,coverage,sourceMix'

/** RFC 4180: a field needing no quoting is written bare; one with a comma, a quote, a line feed
 *  or a carriage return is wrapped in double quotes, with an inner quote doubled. daily.source_mix
 *  is an unconstrained text column, so a lone \r is not merely theoretical. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(',')
}

/** A null coverage, value or sourceMix is an empty field, not the text 'null': the CSV has to
 *  say nothing happened to be measured, not lie that the measurement itself was the word null. */
function orEmpty(value: string | number | null): string {
  return value === null ? '' : String(value)
}

/**
 * coverage is always k/24 for an integer k in [0, 24] (coverageOf, packages/core/src/derive/
 * coverage.ts, counts distinct observed hours out of a day), which makes the sixteen digit float
 * a spreadsheet sees today (23 hours observed writes as 0.9583333333333334) a binary
 * representation artefact of a twenty five value scale, not real precision: those 25 values are
 * already 1/24 (~0.0417) apart, so three decimal places distinguishes every one of them with room
 * to spare. Not a catalogue precision: coverage names no metric, and METRICS has nothing to say
 * about it, so this is a fixed constant chosen for what this column actually holds rather than a
 * guessed precision for someone's health data (that distinction is the whole reason
 * roundMetricValue in shared.ts refuses to invent one). Applied to the csv only, not the json
 * export: the json export deliberately still answers the exact body /series does
 * (v1-export.test.ts's "answers json as the same shape the read route returns" holds the two to
 * byte-for-byte equality), and unlike `value`, coverage was never one of the numbers the
 * precision audit found a reader actually looking at.
 */
const COVERAGE_PRECISION = 3

function roundCoverage(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(COVERAGE_PRECISION))
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
        orEmpty(point.value), orEmpty(roundCoverage(point.coverage)), orEmpty(point.sourceMix),
      ]))
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Downloads a `daily` backed read (Ruling R16: this covers that read only, not intraday,
 * sessions or sleep) as csv or json, under the same query parameters `/series` takes.
 *
 * Ruling R15: an export exists to be kept, so this route never thins. Every metric answers its
 * whole range and carries `reduction: null`, the same value a caller of `/series` sees when it
 * asks for no thinning; silently thinning what somebody downloads to keep would defeat the reason
 * to export at all.
 *
 * `points` is therefore refused rather than ignored. Accepting it and quietly dropping it left a
 * caller who asked for five points and received twenty eight with no signal that their request
 * had been reinterpreted, and every other parameter on this surface refuses what it cannot
 * honour, `points=0` on `/series` included.
 *
 * A parameter check, one core call per metric and a serialiser: no try/catch, because
 * registerV1's setErrorHandler turns whatever PersonQuery throws, and the ConfigError below for
 * an unrecognised format, into the right response.
 *
 * Both formats download rather than render: same naming, same attachment disposition, only the
 * extension and the content type differ.
 *
 * Both formats answer a content hashed ETag and honour If-None-Match, the same as every other
 * read here. The hash base rather than the stamp plus count one, because the csv body is a
 * serialisation the row stamps do not determine: two ranges can share a stamp pair and produce
 * different files.
 */
export function registerExportRoutes(app: FastifyInstance): void {
  app.get<{ Params: PersonParams, Querystring: ExportQuery }>('/p/:personId/export', async (request, reply) => {
    const personQuery = personQueryOf(request)
    const format = requireString(request.query.format, 'format')
    if (format !== 'csv' && format !== 'json') {
      throw new ConfigError(`format must be 'csv' or 'json', got '${format}'`)
    }
    if (request.query.points !== undefined) {
      throw new ConfigError(
        'points is not accepted here: an export answers its whole range, since thinning what '
        + 'somebody downloads to keep would defeat the reason to export. Ask /series for a thinned read',
      )
    }
    const metrics = metricsFrom(request.query.metric)
    const agg = requireString(request.query.agg, 'agg')
    const from = requireString(request.query.from, 'from')
    const to = requireString(request.query.to, 'to')
    const source = request.query.source

    const body: Record<string, SeriesResult> = {}
    for (const metric of metrics) {
      // Rounded the same way /series rounds its own points, and through the same helper, so a
      // file kept from this route and a read from /series can never disagree about the same day:
      // a kept export is read by a person too, and a raw many-decimal float belongs in neither.
      body[metric] = roundSeriesResult(metric, personQuery.series({ metric, agg, from, to, source }))
    }

    // Ruling R17: several metrics join in request order with a hyphen, one file, distinguished
    // by the metric column rather than one file per metric. Both formats, not only csv: json set
    // neither header, so a browser rendered it in a tab while its sibling downloaded, and the
    // reader had to name the file themselves. An export exists to be kept.
    const filename = `haelan-${metrics.join('-')}-${from}-${to}.${format}`
    reply.header('content-disposition', `attachment; filename="${filename}"`)

    if (format === 'json') {
      reply.header('content-type', 'application/json; charset=utf-8')
      return sendHashed(reply, request, body)
    }
    reply.header('content-type', 'text/csv; charset=utf-8')
    return sendHashed(reply, request, toCsv(body, metrics, agg))
  })
}
