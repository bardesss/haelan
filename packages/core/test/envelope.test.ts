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

  it('names every unrecognised key in the reason, because that is what a person needs', () => {
    const envelope = read({ dataPointList: [], somethingElse: 1 })
    expect(envelope.readable === false && envelope.reason).toContain('dataPointList')
    expect(envelope.readable === false && envelope.reason).toContain('somethingElse')
  })

  it('does not count a benign sibling as evidence of a rename', () => {
    // A page token beside a renamed field must not make the reason misleading, and a page token
    // on its own must not trip the guard at all.
    expect(BENIGN_SIBLINGS).toContain('nextPageToken')
    const envelope = read({ nextPageToken: 'abc', dataPointList: [] })
    expect(envelope.readable).toBe(false)
    expect(envelope.readable === false && envelope.reason).not.toContain('nextPageToken')
  })
})
