import { describe, expect, it } from 'vitest'
import { DATA_TYPES, USER_HORIZON_CHOICES, dataTypeById, horizonDaysFor, supports } from '../src/api/catalogue.ts'
import { mapSamples } from '../src/api/mapSamples.ts'
import { samplePoint, intervalPoint, dailyPoint, body } from '../src/testing/payloads.ts'

// A valuePath naming a leaf that does not exist maps to nothing and says nothing. This drives a
// synthetic payload shaped from the field map through each entry and asserts a row comes out.
//
// The payload is built from the catalogue's own valuePath, so a valuePath that is wrong in the
// same way the builder would be wrong (a typo shared by both) slips past this test. What it does
// catch is a path that cannot resolve at all, a payloadKey that disagrees with the mapper, and a
// type that silently produces no rows. Do not read a pass here as proof the path matches Google's
// actual field.
const shapeFor = (id: string) => {
  const t = dataTypeById(id)!
  if (t.filterMember === 'date') {
    return dailyPoint({ payloadKey: t.payloadKey, valuePath: t.valuePath, value: 7, date: { year: 2026, month: 8, day: 18 } })
  }
  if (t.filterMember === 'sample_time.physical_time') {
    return samplePoint({ payloadKey: t.payloadKey, valuePath: t.valuePath, value: 7, physicalTime: '2026-08-18T10:00:00Z' })
  }
  return intervalPoint({
    payloadKey: t.payloadKey, valuePath: t.valuePath, value: 7,
    physicalTime: '2026-08-18T10:00:00Z', endTime: '2026-08-18T10:01:00Z',
  })
}

describe('the catalogue tells the truth about where a value lives', () => {
  // A sub-dimension type has no single valuePath to build shapeFor from, and a durationMinutes
  // type (sedentary-period) has no valuePath at all - its value is the interval's own length, not
  // a leaf shapeFor could plant a 7 at. Both shapes are exercised separately, in
  // map-samples-duration.test.ts and catalogue-group-b.test.ts instead.
  const mappable = DATA_TYPES.filter((t) =>
    supports(t, 'list') && t.target === 'samples' && !t.mappingDeferred && !t.subDimension && !t.durationMinutes)

  it('covers every mappable type, so this test cannot quietly shrink', () => {
    // Pinned exactly: a looser floor would not notice the set losing an entry.
    expect(mappable.length).toBe(18)
  })

  for (const t of mappable) {
    it(`maps a ${t.id} point through its declared valuePath`, () => {
      const rows = mapSamples({
        dataType: t, personId: 'p1', resolveSource: () => 's1', rawPayloadId: 'r1',
        body: body([shapeFor(t.id)]),
      })
      expect(rows, `${t.id} valuePath ${t.valuePath} resolved to nothing`).toHaveLength(1)
      expect(rows[0]?.value).toBe(7)
      expect(rows[0]?.metric).toBe(t.metric)
    })
  }
})

describe('the catalogue claims nothing about retention that M0 did not measure', () => {
  it('never resolves a horizon longer than the longest choice offered', () => {
    // A longer horizon would be a claim that Google keeps that type further back than five
    // years, and nothing in probe/findings/ measured retention at all. The longest choice is
    // already an assumption; resolving past it for any type would be an unsourced one.
    const longest = Math.max(...USER_HORIZON_CHOICES)
    for (const type of DATA_TYPES) {
      expect(horizonDaysFor(type, longest), type.id).toBeLessThanOrEqual(longest)
    }
  })
})
