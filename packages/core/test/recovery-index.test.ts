import { describe, expect, it } from 'vitest'
import { recoveryWindowStart, zSeries, SLEEP_WEEK_DAYS, sleepWeekSeries, recoveryIndex, RECOVERY_WEIGHTS, RECOVERY_SCALE, bandOf } from '../src/api/recoveryIndex.ts'
import type { DayValue } from '../src/api/recoveryIndex.ts'
import type { RecoveryIndexInput } from '../src/api/recoveryIndex.ts'

/**
 * 60 days alternating one unit either side of `flat`, then one day that deviates sharply.
 *
 * The alternation matters: `zScoreOf` returns null for a literally constant baseline (spread
 * exactly zero is not a number of standard deviations), so a truly flat history could never
 * produce the finite "large z" this helper exists to test. Alternating keeps the baseline tight
 * -- nothing like the deviating day below -- while giving it a real, small, computable spread.
 */
function flatThenSpike(endDate: string, flat: number, spike: number): DayValue[] {
  const days: DayValue[] = []
  for (let back = 60; back >= 1; back -= 1) {
    days.push({ localDate: shift(endDate, -back), value: flat + (back % 2 === 0 ? 1 : -1) })
  }
  days.push({ localDate: endDate, value: spike })
  return days
}

function shift(date: string, by: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + by * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

describe('recoveryWindowStart', () => {
  it('reaches back far enough for a 60 day baseline whose oldest day needs its own sleep week', () => {
    // 60 baseline days ending the day before, and the oldest of those needs 6 days before it.
    expect(recoveryWindowStart('2026-09-14')).toBe('2026-07-10')
    expect(SLEEP_WEEK_DAYS).toBe(7)
  })
})

describe('zSeries', () => {
  it('withholds a day whose history never varied, because zero spread measures nothing', () => {
    const days: DayValue[] = []
    for (let back = 60; back >= 0; back -= 1) days.push({ localDate: shift('2026-09-14', -back), value: 50 })
    const z = zSeries(days, { from: '2026-09-14', to: '2026-09-14' }, 'up')
    // A flat history has zero spread, so there is no distance measurable in units of it.
    expect(z.get('2026-09-14')).toBeNull()
  })

  it('signs a deviation by direction, so positive always means better recovered', () => {
    const days = flatThenSpike('2026-09-14', 50, 60)
    // One differing day in an otherwise flat window gives a large but finite z.
    const up = zSeries(days, { from: '2026-09-14', to: '2026-09-14' }, 'up')
    const down = zSeries(days, { from: '2026-09-14', to: '2026-09-14' }, 'down')
    expect(up.get('2026-09-14')).toBeGreaterThan(0)
    expect(down.get('2026-09-14')).toBe(-(up.get('2026-09-14') as number))
  })

  it('withholds a day whose baseline is thin', () => {
    const days: DayValue[] = []
    for (let back = 10; back >= 0; back -= 1) days.push({ localDate: shift('2026-09-14', -back), value: 40 + back })
    const z = zSeries(days, { from: '2026-09-14', to: '2026-09-14' }, 'up')
    expect(z.get('2026-09-14')).toBeNull()
  })

  it('never lets a day contribute to the baseline it is judged against', () => {
    const days = flatThenSpike('2026-09-14', 50, 500)
    const z = zSeries(days, { from: '2026-09-14', to: '2026-09-14' }, 'up')
    // If day D leaked into its own window the spread would swallow the spike and z would be small.
    expect(z.get('2026-09-14')).toBeGreaterThan(10)
  })
})

describe('sleepWeekSeries', () => {
  const week = (end: string, values: number[]): DayValue[] =>
    values.map((value, index) => ({ localDate: shift(end, index - (values.length - 1)), value }))

  it('averages asleep minutes over the seven days ending on each date', () => {
    const asleep = week('2026-09-14', [400, 410, 420, 430, 440, 450, 460])
    const { duration } = sleepWeekSeries(asleep, [], { from: '2026-09-14', to: '2026-09-14' })
    expect(duration).toEqual([{ localDate: '2026-09-14', value: 430 }])
  })

  it('measures consistency as the spread of bedtimes, so a steady week is a small number', () => {
    const steady = week('2026-09-14', [1380, 1380, 1380, 1380, 1380, 1380, 1380])
    const erratic = week('2026-09-14', [1200, 1440, 1260, 1380, 1320, 1400, 1250])
    const range = { from: '2026-09-14', to: '2026-09-14' }
    const a = sleepWeekSeries([], steady, range).consistency[0]
    const b = sleepWeekSeries([], erratic, range).consistency[0]
    expect(a?.value).toBe(0)
    expect(b?.value).toBeGreaterThan(0)
  })

  it('omits a date whose week holds too few observed nights, rather than averaging two of seven', () => {
    const sparse: DayValue[] = [
      { localDate: '2026-09-13', value: 400 },
      { localDate: '2026-09-14', value: 420 },
    ]
    const { duration } = sleepWeekSeries(sparse, [], { from: '2026-09-14', to: '2026-09-14' })
    expect(duration).toEqual([])
  })
})

/** 67 days of flat history with a little noise, so baselines are neither thin nor zero-spread. */
function history(end: string, centre: number): DayValue[] {
  const days: DayValue[] = []
  for (let back = 66; back >= 0; back -= 1) {
    days.push({ localDate: shift(end, -back), value: centre + (back % 3) - 1 })
  }
  return days
}

function inputAt(end: string): RecoveryIndexInput {
  return {
    hrv: history(end, 40),
    restingHeartRate: history(end, 55),
    respiratoryRate: history(end, 14),
    asleepMinutes: history(end, 430),
    bedtimeMinutes: history(end, 1380),
  }
}

describe('recoveryIndex', () => {
  it('scores a day sitting on its own baseline at 50', () => {
    const end = '2026-09-14'
    const input = inputAt(end)
    // Put the final day of each autonomic series exactly on its own baseline centre, so each z is
    // 0. `history` cycles -1/0/+1 over a window of 60, which is a multiple of 3, so the centre is
    // the bare value.
    const flatten = (days: readonly DayValue[], centre: number): DayValue[] =>
      days.map((day) => day.localDate === end ? { ...day, value: centre } : day)
    // Sleep is handed an unvarying history on purpose. A constant series has zero spread, so its z
    // is null and the input drops out - which is the ONLY way to get a sleep contribution of
    // exactly zero, since a varying week never lands precisely on its own baseline. The weights
    // renormalise over the three that remain and the composite is still 0.
    const constant = (value: number): DayValue[] =>
      input.hrv.map((day) => ({ localDate: day.localDate, value }))
    const result = recoveryIndex({
      hrv: flatten(input.hrv, 40),
      restingHeartRate: flatten(input.restingHeartRate, 55),
      respiratoryRate: flatten(input.respiratoryRate, 14),
      asleepMinutes: constant(430),
      bedtimeMinutes: constant(1380),
    }, end)
    expect(result.enough).toBe(true)
    if (!result.enough) return
    expect(result.score).toBe(50)
    expect(result.degraded).toEqual(['sleep'])
  })

  it('withholds entirely when HRV is missing for the day', () => {
    const end = '2026-09-14'
    const input = inputAt(end)
    const result = recoveryIndex(
      { ...input, hrv: input.hrv.filter((day) => day.localDate !== end) },
      end,
    )
    expect(result.enough).toBe(false)
    if (result.enough) return
    expect(result.missing).toEqual(['hrv'])
  })

  it('withholds entirely when resting heart rate is missing for the day', () => {
    const end = '2026-09-14'
    const input = inputAt(end)
    const result = recoveryIndex(
      { ...input, restingHeartRate: input.restingHeartRate.filter((d) => d.localDate !== end) },
      end,
    )
    expect(result.enough).toBe(false)
    if (result.enough) return
    expect(result.missing).toEqual(['restingHeartRate'])
  })

  it('redistributes weight and names the gap when only an optional input is missing', () => {
    const end = '2026-09-14'
    const result = recoveryIndex({ ...inputAt(end), respiratoryRate: [] }, end)
    expect(result.enough).toBe(true)
    if (!result.enough) return
    expect(result.degraded).toEqual(['respiratoryRate'])
    const total = result.inputs.reduce((sum, i) => sum + i.weight, 0)
    expect(total).toBeCloseTo(1, 10)
    expect(result.inputs.some((i) => i.key === 'respiratoryRate')).toBe(false)
  })

  it('gives a breathing rate below baseline no credit, because low is not recovered', () => {
    const end = '2026-09-14'
    const input = inputAt(end)
    const lower = input.respiratoryRate.map((d) => d.localDate === end ? { ...d, value: 9 } : d)
    const result = recoveryIndex({ ...input, respiratoryRate: lower }, end)
    expect(result.enough).toBe(true)
    if (!result.enough) return
    const breathing = result.inputs.find((i) => i.key === 'respiratoryRate')
    expect(breathing?.z).toBe(0)
  })

  it('attributes points that sum exactly to the distance from 50 when every input pushes the same way', () => {
    const end = '2026-09-14'
    const input = inputAt(end)
    const worse = input.restingHeartRate.map((d) => d.localDate === end ? { ...d, value: 70 } : d)
    const result = recoveryIndex({ ...input, restingHeartRate: worse }, end)
    expect(result.enough).toBe(true)
    if (!result.enough) return
    const summed = result.inputs.reduce((sum, i) => sum + i.points, 0)
    expect(summed).toBeCloseTo(result.score - 50, 6)
    expect(result.score).toBeLessThan(50)
  })

  it('bounds every input\'s points by the distance from 50 even when inputs pull opposite ways', () => {
    const end = '2026-09-14'
    const input = inputAt(end)
    // HRV pulled well above its own baseline (good, direction 'up') and resting heart rate pulled
    // well above its own baseline too (bad, direction 'down') give roughly opposite z of about 3 and
    // -3: the two largest-weighted inputs mostly cancelling. Dividing an individual share by the
    // signed composite (rather than the total movement) would send that share far past the distance
    // whenever a day like this pulls the composite itself close to zero - this is the regression
    // guard for that: the existing "sum exactly" test above cannot see it, because it only ever
    // pushes one input away from baseline.
    const betterHrv = input.hrv.map((d) => d.localDate === end ? { ...d, value: 42.5 } : d)
    const worseRhr = input.restingHeartRate.map((d) => d.localDate === end ? { ...d, value: 57.5 } : d)
    const result = recoveryIndex({ ...input, hrv: betterHrv, restingHeartRate: worseRhr }, end)
    expect(result.enough).toBe(true)
    if (!result.enough) return
    const distance = Math.abs(result.score - 50)
    for (const i of result.inputs) {
      expect(Math.abs(i.points)).toBeLessThanOrEqual(distance)
    }
    // The honest statement that opposing inputs partly cancelled: the signed sum falls short of the
    // full distance rather than accounting for all of it.
    const summed = result.inputs.reduce((sum, i) => sum + i.points, 0)
    expect(Math.abs(summed)).toBeLessThan(distance)
  })

  it('keeps every score inside 0 and 100 however extreme the day', () => {
    const end = '2026-09-14'
    const input = inputAt(end)
    const absurd = input.hrv.map((d) => d.localDate === end ? { ...d, value: 100_000 } : d)
    const result = recoveryIndex({ ...input, hrv: absurd }, end)
    expect(result.enough).toBe(true)
    if (!result.enough) return
    expect(result.score).toBeGreaterThanOrEqual(0)
    expect(result.score).toBeLessThanOrEqual(100)
  })

  it('weights sum to one, so a redistribution has something to redistribute', () => {
    const total = Object.values(RECOVERY_WEIGHTS).reduce((sum, weight) => sum + weight, 0)
    expect(total).toBeCloseTo(1, 10)
  })

  it('scores a day whose sleep rows carry no coverage, because coverage is not the wear signal', () => {
    // DayValue has no coverage field at all. This test exists so that a future gate written
    // against coverage has to delete an assertion rather than silently drop every sleep row.
    const end = '2026-09-14'
    const result = recoveryIndex(inputAt(end), end)
    expect(result.enough).toBe(true)
  })

  it('gives sleep only half its weight when just one of duration and consistency is available', () => {
    const end = '2026-09-14'
    const input = inputAt(end)
    // A genuinely steady bedtime is the ordinary way to lose the consistency half: a constant week
    // has zero spread, so its z is null and duration alone is left standing in for sleep. Dropping
    // bedtime data entirely reaches the same state without relying on that zero-spread coincidence.
    const bothHalves = recoveryIndex(input, end)
    const durationOnly = recoveryIndex({ ...input, bedtimeMinutes: [] }, end)
    expect(bothHalves.enough).toBe(true)
    expect(durationOnly.enough).toBe(true)
    if (!bothHalves.enough || !durationOnly.enough) return
    expect(durationOnly.degraded).toContain('sleep')
    const fullWeight = bothHalves.inputs.find((i) => i.key === 'sleep')?.weight
    const halfWeight = durationOnly.inputs.find((i) => i.key === 'sleep')?.weight
    expect(fullWeight).toBeCloseTo(0.25, 10)
    expect(halfWeight).toBeLessThan(fullWeight as number)
  })

  it('uses its range: a one sigma composite is a visibly different score from 50', () => {
    // Guards the failure the probe exists to prevent - a scale that puts every real day near 50.
    const oneSigma = 100 / (1 + Math.exp(-RECOVERY_SCALE * 1))
    expect(oneSigma).toBeGreaterThan(60)
    expect(oneSigma).toBeLessThan(85)
  })
})

describe('bandOf', () => {
  it('names five comparative bands with 50 sitting in the middle one', () => {
    expect(bandOf(50)).toBe('usual')
    expect(bandOf(44)).toBe('usual')
    expect(bandOf(56)).toBe('usual')
    expect(bandOf(43)).toBe('below')
    expect(bandOf(57)).toBe('above')
    expect(bandOf(24)).toBe('low')
    expect(bandOf(76)).toBe('high')
  })

  it('covers 0 and 100, so no score is unlabelled', () => {
    expect(bandOf(0)).toBe('low')
    expect(bandOf(100)).toBe('high')
  })
})
