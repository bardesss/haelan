import { expect, test } from 'vitest'
import {
  BODY_AGE_FACTORS,
  BODY_AGE_TOTAL_CAP,
  GOMPERTZ_SLOPE,
  MIN_FACTOR_DAYS,
  ageYearsAt,
  bodyAgeAt,
  type BodyAgeAvailable,
  type BodyAgeInput,
} from '../src/api/bodyAge.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'

const END = '2026-06-30'
const BIRTH = '1986-06-30'
const SEX = 'male' as const
const AGE = ageYearsAt(BIRTH, END)!
const START = shiftLocalDate(END, -29)

/** `n` consecutive days from `from`, all with one value. */
function days(from: string, n: number, value: number) {
  return Array.from({ length: n }, (_, i) => ({ localDate: shiftLocalDate(from, i), value }))
}

/**
 * Four 7-day blocks ending on END, in each of which the bedtimes are a, -a, a, -a, a, -a, 0. Each
 * block's sample SD is exactly `a` (sum of squares 6a² over 6 degrees of freedom), whatever the
 * block's mean. The two days before the first block are left out.
 */
function bedtimes(a: number, blockMeans: readonly number[] = [0, 0, 0, 0]) {
  return blockMeans.flatMap((mean, k) => {
    const blockStart = shiftLocalDate(END, -(6 + 7 * k))
    return [a, -a, a, -a, a, -a, 0].map((v, i) => ({ localDate: shiftLocalDate(blockStart, i), value: mean + v }))
  })
}

const ref = (key: string) => BODY_AGE_FACTORS.find((f) => f.key === key)!.reference(AGE, SEX)

const full: BodyAgeInput = {
  birthDate: BIRTH,
  sex: SEX,
  vo2Max: [{ localDate: END, value: ref('vo2Max') }],
  restingHeartRate: days(START, 30, ref('restingHeartRate')),
  hrv: days(START, 30, 50),
  activityMinutes: days(START, 30, ref('activity') / 7),
  bedtimeMinutes: bedtimes(ref('sleepRegularity')),
  strengthSessionDates: [],
}

const available = (input: BodyAgeInput) => bodyAgeAt(input, END) as BodyAgeAvailable
const factor = (r: BodyAgeAvailable, key: string) => r.factors.find((f) => f.key === key)!

test('a person at every reference scores their calendar age', () => {
  const r = available(full)
  expect(r.enough).toBe(true)
  expect(r.bodyAge).toBeCloseTo(r.calendarAge, 9)
  expect(r.gap).toBeCloseTo(0, 9)
  expect(r.factors.map((f) => f.key)).toEqual(BODY_AGE_FACTORS.map((f) => f.key))
  expect(r.factors.some((f) => f.key === 'hrv')).toBe(false)
  expect(r.window).toEqual({ from: START, to: END })
})

test('missing birth date, sex and VO2 max each name themselves', () => {
  expect(bodyAgeAt({ ...full, birthDate: null, sex: null, vo2Max: [] }, END))
    .toEqual({ enough: false, endDate: END, missing: ['birthDate', 'sex', 'vo2Max'] })
})

test('a nonsense birth date counts as a missing birth date', () => {
  expect(bodyAgeAt({ ...full, birthDate: '1988-13-45' }, END))
    .toEqual({ enough: false, endDate: END, missing: ['birthDate'] })
})

test('VO2 max carries forward up to 180 days', () => {
  expect(bodyAgeAt({ ...full, vo2Max: [{ localDate: shiftLocalDate(END, -180), value: 45 }] }, END).enough).toBe(true)
  expect(bodyAgeAt({ ...full, vo2Max: [{ localDate: shiftLocalDate(END, -181), value: 45 }] }, END))
    .toMatchObject({ enough: false, missing: ['vo2Max'] })
})

test('the latest VO2 reading is used, with its fitness age and date', () => {
  const r = available({
    ...full,
    vo2Max: [{ localDate: shiftLocalDate(END, -3), value: 42.4 }, { localDate: shiftLocalDate(END, -40), value: 30 }],
  })
  expect(r.vo2MaxDate).toBe(shiftLocalDate(END, -3))
  expect(r.fitnessAge).toBeCloseTo(35, 9)
  expect(factor(r, 'vo2Max').value).toBe(42.4)
})

test('a factor at MIN_FACTOR_DAYS - 1 days is missing and contributes zero', () => {
  const few = available({ ...full, restingHeartRate: days(START, MIN_FACTOR_DAYS - 1, 90) })
  expect(factor(few, 'restingHeartRate')).toMatchObject({
    missing: 'tooFewDays', years: 0, value: null, days: MIN_FACTOR_DAYS - 1,
  })
  const none = available({ ...full, restingHeartRate: [] })
  expect(factor(none, 'restingHeartRate')).toMatchObject({ missing: 'noReading', years: 0, days: 0 })
  const enough = available({ ...full, restingHeartRate: days(START, MIN_FACTOR_DAYS, 90) })
  expect(factor(enough, 'restingHeartRate').missing).toBeNull()
})

test('days outside the window are not counted', () => {
  const r = available({ ...full, restingHeartRate: days(shiftLocalDate(START, -30), 30, 90) })
  expect(factor(r, 'restingHeartRate').missing).toBe('noReading')
})

test('activity is the mean per present day times seven', () => {
  const r = available({ ...full, activityMinutes: days(START, 12, 30) })
  expect(factor(r, 'activity').value).toBe(210)
})

test('bedtimes either side of midnight spread by minutes, not by a day', () => {
  const bed = bedtimes(20)
  const f = factor(available({ ...full, bedtimeMinutes: bed }), 'sleepRegularity')
  expect(f.value).toBeGreaterThan(15)
  expect(f.value).toBeLessThan(25)
})

test('a steady pattern that drifts from week to week has no spread', () => {
  const drifting = bedtimes(0, [0, 60, 120, 180])
  const f = factor(available({ ...full, bedtimeMinutes: drifting }), 'sleepRegularity')
  expect(f.value).toBeCloseTo(0, 9)
})

test('the sleep spread is the mean of the weekly SDs', () => {
  const mixed = [...bedtimes(10, [0, 0]), ...bedtimes(30, [0, 0, 0, 0]).filter((b) => b.localDate <= shiftLocalDate(END, -14))]
  // Blocks 0 and 1 at SD 10, then blocks 2 and 3 at SD 30 (the later bedtimes(30) rows overwrite nothing).
  const f = factor(available({ ...full, bedtimeMinutes: mixed }), 'sleepRegularity')
  expect(f.value).toBeCloseTo(20, 9)
})

test('the sleep spread needs two weeks with at least four nights each', () => {
  const week = (k: number, nights: number) => bedtimes(20, [0, 0, 0, 0])
    .filter((b) => b.localDate >= shiftLocalDate(END, -(6 + 7 * k)) && b.localDate <= shiftLocalDate(END, -7 * k))
    .slice(0, nights)
  const one = [...week(0, 7), ...week(1, 3)]
  expect(factor(available({ ...full, bedtimeMinutes: one }), 'sleepRegularity'))
    .toMatchObject({ missing: 'tooFewDays', value: null, years: 0, days: 10 })
  const two = [...week(0, 7), ...week(1, 4)]
  expect(factor(available({ ...full, bedtimeMinutes: two }), 'sleepRegularity').missing).toBeNull()
  expect(factor(available({ ...full, bedtimeMinutes: [] }), 'sleepRegularity').missing).toBe('noReading')
})

test('the total cap binds', () => {
  const r = available({
    ...full,
    vo2Max: [{ localDate: END, value: 10 }],
    restingHeartRate: days(START, 30, 110),
    activityMinutes: days(START, 30, 0),
    bedtimeMinutes: bedtimes(200),
  })
  expect(r.factors.reduce((t, f) => t + f.years, 0)).toBeGreaterThan(BODY_AGE_TOTAL_CAP)
  expect(r.bodyAge - r.calendarAge).toBeCloseTo(BODY_AGE_TOTAL_CAP, 9)
  expect(r.totalCapped).toBe(true)
})

test('zero strength sessions is a value', () => {
  expect(factor(available(full), 'strength')).toMatchObject({ missing: null, value: 0 })
})

test('strength counts sessions inside the window as a weekly rate', () => {
  const dates = [START, END, shiftLocalDate(START, -1), shiftLocalDate(END, 1)]
  expect(factor(available({ ...full, strengthSessionDates: dates }), 'strength').value).toBeCloseTo(14 / 30, 9)
})

test('carriedBy names the dominant factor and none on a split', () => {
  const dominant = available({
    ...full,
    vo2Max: [{ localDate: END, value: ref('vo2Max') - 10 }],
    restingHeartRate: days(START, 30, ref('restingHeartRate') + 3),
  })
  expect(dominant.gap).toBeGreaterThan(0)
  expect(dominant.carriedBy).toBe('vo2Max')

  // A resting heart rate 5 bpm high, and a VO2 max low by exactly as many years: a tie names nobody.
  const years = (Math.log(1.09) * 5) / 10 / GOMPERTZ_SLOPE
  const tie = available({
    ...full,
    vo2Max: [{ localDate: END, value: ref('vo2Max') + (years * GOMPERTZ_SLOPE * 3.5) / Math.log(0.87) }],
    restingHeartRate: days(START, 30, ref('restingHeartRate') + 5),
  })
  expect(factor(tie, 'vo2Max').years).toBeCloseTo(years, 9)
  expect(factor(tie, 'restingHeartRate').years).toBeCloseTo(years, 9)
  expect(tie.carriedBy).toBeNull()

  expect(available(full).carriedBy).toBeNull()
})

test('mostRoom never names a factor at or better than its reference', () => {
  const better = available({
    ...full,
    vo2Max: [{ localDate: END, value: ref('vo2Max') + 8 }],
    restingHeartRate: days(START, 30, ref('restingHeartRate') - 8),
    strengthSessionDates: days(START, 30, 0).map((d) => d.localDate),
  })
  expect(better.factors.every((f) => f.years <= 0)).toBe(true)
  expect(better.mostRoom).toBeNull()
  expect(available(full).mostRoom).toBeNull()

  const worse = available({ ...full, restingHeartRate: days(START, 30, ref('restingHeartRate') + 10) })
  expect(worse.mostRoom).toEqual({ key: 'restingHeartRate', years: factor(worse, 'restingHeartRate').years })
})
