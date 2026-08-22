import { describe, expect, it } from 'vitest'
import { readEnvelope, BENIGN_SIBLINGS } from '../src/api/envelope.ts'

const read = (body: unknown, key = 'dataPoints') =>
  readEnvelope(typeof body === 'string' ? body : JSON.stringify(body), key)

describe('readEnvelope', () => {
  it('reads the points out of a body it knows', () => {
    const envelope = read({ dataPoints: [{ a: 1 }, { a: 2 }] })
    expect(envelope.readable).toBe(true)
    expect(envelope.readable && envelope.points).toHaveLength(2)
  })

  it('reads an explicitly empty array as an ordinary quiet day', () => {
    const envelope = read({ dataPoints: [] })
    expect(envelope.readable).toBe(true)
    expect(envelope.readable && envelope.points).toEqual([])
  })

  it('reads an empty object as an ordinary quiet day', () => {
    // proto3 JSON omits a repeated field that is empty, so `{}` is what a window with no data
    // is expected to look like. M2p never captured one, since every request it made returned
    // something, so this is reasoned from the encoding rather than measured. Treating it as
    // unreadable would fire drift on every quiet day, which is the worse way to be wrong.
    const envelope = read({})
    expect(envelope.readable).toBe(true)
    expect(envelope.readable && envelope.points).toEqual([])
  })

  it('reads a body carrying only a page token as quiet rather than broken', () => {
    const envelope = read({ nextPageToken: 'abc' })
    expect(envelope.readable).toBe(true)
    expect(envelope.readable && envelope.points).toEqual([])
  })

  it('refuses a body carrying data under a name it does not know', () => {
    // The whole point. A renamed envelope arrives as an object with content, just not content
    // we can find, and the old code counted that as zero points, which is what a quiet day
    // looks like too. Distinguishing them is what stops a rename scrolling the cursor past
    // days nobody ever read.
    const envelope = read({ dataPointList: [{ a: 1 }] })
    expect(envelope.readable).toBe(false)
    expect(envelope.readable === false && envelope.reason).toContain('dataPointList')
  })

  it('refuses a body that is not JSON at all', () => {
    const envelope = read('<html>502 Bad Gateway</html>')
    expect(envelope.readable).toBe(false)
  })

  it('refuses JSON that is not an object', () => {
    expect(read('[]').readable).toBe(false)
    expect(read('null').readable).toBe(false)
    expect(read('7').readable).toBe(false)
  })

  it('refuses a points key that is present but is not an array', () => {
    const envelope = read({ dataPoints: { 0: { a: 1 } } })
    expect(envelope.readable).toBe(false)
  })

  it('reads whichever key it was asked for, so both sync paths share it', () => {
    const rollup = read({ rollupDataPoints: [{ a: 1 }] }, 'rollupDataPoints')
    expect(rollup.readable && rollup.points).toHaveLength(1)
    // The same body is unreadable when the caller asked for the other key, which is what makes
    // a rollup response arriving on the list path visible instead of silently empty.
    expect(read({ rollupDataPoints: [{ a: 1 }] }, 'dataPoints').readable).toBe(false)
  })

  it('names every moved key in the reason, because that is what a person needs', () => {
    const envelope = read({ dataPointList: [{ a: 1 }], otherPoints: [{ b: 2 }], count: 3 })
    expect(envelope.readable === false && envelope.reason).toContain('dataPointList')
    expect(envelope.readable === false && envelope.reason).toContain('otherPoints')
    // `count` is a scalar, so it is a sibling rather than a candidate, and naming it would send
    // whoever reads this record looking in the wrong place.
    expect(envelope.readable === false && envelope.reason).not.toContain('count')
  })

  it('does not count a benign sibling as evidence of a rename', () => {
    // A page token beside a renamed field must not make the reason misleading, and a page token
    // on its own must not trip the guard at all.
    expect(BENIGN_SIBLINGS).toContain('nextPageToken')
    const envelope = read({ nextPageToken: 'abc', dataPointList: [{ value: 1 }] })
    expect(envelope.readable).toBe(false)
    expect(envelope.readable === false && envelope.reason).not.toContain('nextPageToken')
  })

  it('does not call a scalar sibling a rename', () => {
    // Google may add fields to a response whenever it likes, and the guard only ever fires on a
    // quiet day, when the points key is absent. A sibling that is not a list of points must not
    // stall the cursor: the cost of a false positive here is a sync that freezes silently.
    expect(read({ minStartTimeNs: '123', maxEndTimeNs: '456' }).readable).toBe(true)
  })

  it('does not call a list of ids a rename', () => {
    // Google Fit's Dataset carried dataSourceId beside its points. An echo of that shape is a
    // list of strings; a renamed points array is a list of structured points. That difference
    // is what separates a new sibling field from a field that moved.
    expect(read({ dataSourceIds: ['abc', 'def'] }).readable).toBe(true)
  })

  it('still calls a list of structured points under an unknown name a rename', () => {
    const envelope = read({ dataPointList: [{ value: 1 }] })
    expect(envelope.readable).toBe(false)
  })

  it('lets an empty list under an unknown name pass, because it carries nothing to lose', () => {
    // A rename that shows up on a day with no data costs nothing: there was no data to skip.
    // It is caught the first busy day, which is the first day anything is at stake.
    expect(read({ dataPointList: [] }).readable).toBe(true)
  })

  it('reads an explicitly null points key as no points rather than as broken', () => {
    // proto3 JSON does not emit this, but a transcoding proxy can, and null says no points
    // without ambiguity. Stalling a cursor on it would be a false positive nobody would call
    // a rename.
    expect(read({ dataPoints: null }).readable).toBe(true)
  })

})
