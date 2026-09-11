import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { DataType } from '@haelan/core'
import {
  SCOPES, body, dailyPoint, dailyRollupBody, dataTypeById, intervalPoint, samplePoint,
  sleepPoint, supports,
} from '@haelan/core'

export interface StubGoogle {
  origin: string
  requests: string[]
  /** Authorization headers seen, so a test can prove nothing went out unauthenticated. */
  authHeaders: Array<string | undefined>
  close: () => Promise<void>
}

// Fixed instants rather than anything derived from the clock. Every window the backfill walks
// asks for the same day, so the upsert key is stable and a second run writes no new rows,
// which is what makes the idempotency assertion mean something.
const PHYSICAL_TIME = '2026-02-28T10:00:00Z'
const END_TIME = '2026-02-28T10:01:00Z'
const DATE = { year: 2026, month: 2, day: 28 }

// A sub-dimension type has no single valuePath; its point is shaped from subDimension instead,
// using whichever key metricByKey names first. Taken from the catalogue rather than hardcoded,
// so a level or zone this stub sends is always one the mapper actually recognises.
function subDimensionPoint(type: DataType): Record<string, unknown> {
  const sub = type.subDimension!
  const key = Object.keys(sub.metricByKey)[0]!
  const interval = {
    startTime: PHYSICAL_TIME, startUtcOffset: '7200s',
    endTime: END_TIME, endUtcOffset: '7200s',
  }
  const element = { [sub.keyPath]: key, [sub.valuePath]: '7' }
  const inner = sub.arrayPath
    ? { interval, [sub.arrayPath]: [element] }
    : { interval, ...element }
  return {
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    [type.payloadKey]: inner,
  }
}

// One point shaped the way the catalogue says this type's value is shaped. Built from the
// catalogue's own valuePath, or subDimension when it has one, exactly as catalogue-truth.test.ts
// and map-samples.test.ts do, so the stub cannot drift from what the mappers expect.
function pointFor(id: string): Record<string, unknown> | null {
  const type = dataTypeById(id)
  if (!type || !supports(type, 'list') || type.mappingDeferred) return null
  if (type.subDimension) return subDimensionPoint(type)
  if (type.target === 'sessions') {
    return sleepPoint({
      startTime: '2026-02-27T23:00:00Z', endTime: '2026-02-28T06:30:00Z',
      stages: [{ type: 'DEEP', startTime: '2026-02-27T23:00:00Z', endTime: '2026-02-28T01:00:00Z' }],
    })
  }
  if (type.filterMember === 'date') {
    return dailyPoint({ payloadKey: type.payloadKey, valuePath: type.valuePath, value: 7, date: DATE })
  }
  if (type.filterMember === 'sample_time.physical_time') {
    return samplePoint({
      payloadKey: type.payloadKey, valuePath: type.valuePath, value: 7, physicalTime: PHYSICAL_TIME,
    })
  }
  return intervalPoint({
    payloadKey: type.payloadKey, valuePath: type.valuePath, value: 7,
    physicalTime: PHYSICAL_TIME, endTime: END_TIME,
  })
}

// The rollup endpoint answers a different envelope: rollupDataPoints, not dataPoints. Answering
// it with a list shaped body maps to nothing, which the walk now records as schema drift, and
// leaves the end to end run with no provider rows to assert against. Built from the catalogue's
// own payloadKey and valuePath for the same reason pointFor is.
function rollupBodyFor(id: string): string | null {
  const type = dataTypeById(id)
  if (!type || !supports(type, 'dailyRollUp')) return null
  const value = type.valuePath.split('.')
    .reduceRight<unknown>((acc, key) => ({ [key]: acc }), 7) as Record<string, unknown>
  return dailyRollupBody(type.payloadKey, [{ date: DATE, value }])
}

const typeIdFrom = (url: string): string =>
  url.match(/\/dataTypes\/([^/]+)\/dataPoints/)?.[1] ?? ''

export async function startStubGoogle(): Promise<StubGoogle> {
  const requests: string[] = []
  const authHeaders: Array<string | undefined> = []

  const server: Server = createServer((request, response) => {
    const url = request.url ?? ''
    requests.push(url)
    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }

    if (url.startsWith('/token')) {
      return json(200, {
        refresh_token: 'stub-refresh-token', access_token: 'stub-access-token',
        expires_in: 3599, scope: SCOPES.join(' '),
      })
    }

    authHeaders.push(request.headers.authorization)
    if (url.startsWith('/v4/users/me/profile')) return json(200, { displayName: 'Robin' })
    if (url.includes('/dataPoints:dailyRollUp')) {
      const rollup = rollupBodyFor(typeIdFrom(url))
      return response.writeHead(200, { 'content-type': 'application/json' })
        && response.end(rollup ?? JSON.stringify({ rollupDataPoints: [] }))
    }
    if (url.includes('/dataPoints')) {
      const point = pointFor(typeIdFrom(url))
      return response.writeHead(200, { 'content-type': 'application/json' })
        && response.end(body(point ? [point] : []))
    }
    return json(404, { error: 'the stub does not serve that' })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the stub did not get a port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    authHeaders,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))),
  }
}
