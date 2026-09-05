import { describe, expect, it } from 'vitest'
import { dataTypesNamedIn } from '../src/api/discoveryDataTypes.ts'

// A fixture of the document's shape, not the document: the extraction is what is under test, and
// a test that needed the network would fail on a train, the same rule check-enum-drift.mjs states.
const DOC = {
  schemas: {
    RollupValue: {
      properties: {
        steps: { description: 'Returned by default when rolling up data points from the `steps` data type, or when requested explicitly using the `steps` rollup type identifier.' },
        bloodGlucose: { description: 'Returned by default when rolling up data points from the `blood-glucose` data type.' },
        swimLengths: { description: 'Returned by default when rolling up data points from the `swim-lengths-data` data type.' },
      },
    },
    Unrelated: { description: 'Mentions no data type at all.' },
  },
}

describe('dataTypesNamedIn', () => {
  it('finds every identifier a description names, sorted and deduplicated', () => {
    expect(dataTypesNamedIn(DOC)).toEqual(['blood-glucose', 'steps', 'swim-lengths-data'])
  })

  it('answers empty for a document naming none', () => {
    expect(dataTypesNamedIn({ schemas: { A: { description: 'nothing here' } } })).toEqual([])
  })

  it('does not throw on a document of an unexpected shape', () => {
    expect(dataTypesNamedIn(null)).toEqual([])
    expect(dataTypesNamedIn({})).toEqual([])
  })
})
