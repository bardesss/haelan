import { describe, expect, it } from 'vitest'
import { SAMPLE_AGGS, SAMPLE_AGG_REFS, sampleAggOf } from '../src/db/schema/derived.ts'
import type { SampleAgg } from '../src/db/schema/derived.ts'

/**
 * `SAMPLE_AGG_REFS`'s own comment says why this map is dangerous to touch: its six numbers are
 * written into 1.6 million rows, and nothing on disk records which number meant which name at the
 * time a row was written, so swapping two of them relabels every historical row - a minute's
 * minimum becomes its maximum - with no constraint violated. And every test in this suite writes
 * and reads through the same map, against a database created that second, so a renumber and the
 * suite's own misreading of it cancel out: the whole suite stays green while the guarantee the
 * comment names is gone.
 *
 * The literal below is a second, independent record of the six numbers, not derived from
 * `SAMPLE_AGG_REFS` by import - comparing the map to itself would always pass. If this test
 * fails, the numbers moved in derived.ts. The fix is almost always to restore them there, not to
 * update this file: a genuinely new aggregate takes the next unused number, and a retired one
 * leaves its number behind unused rather than freeing it for reuse.
 */
const PERMANENT_REFS: Record<SampleAgg, number> = {
  raw: 1, min: 2, mean: 3, max: 4, sum: 5, count: 6,
}

describe('SAMPLE_AGG_REFS', () => {
  it('assigns exactly the permanent numbers recorded here, not whatever derived.ts currently says', () => {
    expect(SAMPLE_AGG_REFS).toEqual(PERMANENT_REFS)
  })

  it('is inverted by sampleAggOf for every one of the permanent numbers', () => {
    for (const [agg, ref] of Object.entries(PERMANENT_REFS)) {
      expect(sampleAggOf(ref), `ref ${ref}`).toBe(agg)
    }
  })

  it('has no extra or missing entries against SAMPLE_AGGS itself', () => {
    // Checked against SAMPLE_AGGS, not against PERMANENT_REFS a second time: this is what catches
    // a name added to SAMPLE_AGGS with no number assigned to it (or the reverse), independently of
    // whether the two tests above happen to still agree.
    expect(Object.keys(SAMPLE_AGG_REFS).sort()).toEqual([...SAMPLE_AGGS].sort())
    // And this is what catches a number assigned twice: six distinct aggregates claiming six
    // distinct numbers means the sorted values are exactly 1 through 6, nothing repeated and
    // nothing skipped.
    expect(Object.values(SAMPLE_AGG_REFS).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
  })
})
