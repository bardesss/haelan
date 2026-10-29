import { expect, test } from 'vitest'
import {
  BODY_AGE_FACTORS,
  GOMPERTZ_SLOPE,
  ageYearsAt,
  bodyAgeHistory,
  lastScoredDay,
  type BodyAgeAvailable,
  type BodyAgeInput,
} from '../src/api/bodyAge.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'

const TODAY = '2026-06-30'
const BIRTH = '1986-06-30'
const SEX = 'male' as const

const empty: BodyAgeInput = {
  birthDate: BIRTH,
  sex: SEX,
  vo2Max: [],
  restingHeartRate: [],
  hrv: [],
  activityMinutes: [],
  bedtimeMinutes: [],
  strengthSessionDates: [],
}

/** `n` consecutive days from `from`, all with one value. */
function days(from: string, n: number, value: number) {
  return Array.from({ length: n }, (_, i) => ({ localDate: shiftLocalDate(from, i), value }))
}

/** The last day of each of `count` calendar months, starting at `firstMonth` (YYYY-MM). */
function monthEnds(firstMonth: string, count: number): string[] {
  const year = Number(firstMonth.slice(0, 4))
  const month = Number(firstMonth.slice(5, 7))
  return Array.from({ length: count }, (_, i) => {
    const end = new Date(Date.UTC(year, month - 1 + i + 1, 0))
    return end.toISOString().slice(0, 10)
  })
}

/**
 * A VO2 max reading that puts the VO2 factor, and so the whole gap, at `gap` years on `date`. Only the
 * VO2 factor moves: the other factors are missing or at their reference, and HRV rows only mark days.
 */
function vo2ForGap(gap: number, date: string) {
  const reference = BODY_AGE_FACTORS.find((f) => f.key === 'vo2Max')!.reference(ageYearsAt(BIRTH, date)!, SEX)
  return { localDate: date, value: reference + (gap * GOMPERTZ_SLOPE * 3.5) / Math.log(0.87) }
}

/** One scored day (an HRV row) and one VO2 reading at the end of each month, with the given gaps. */
function monthly(firstMonth: string, gaps: number[]): BodyAgeInput {
  const ends = monthEnds(firstMonth, gaps.length)
  return {
    ...empty,
    hrv: ends.map((localDate) => ({ localDate, value: 50 })),
    vo2Max: ends.map((date, i) => vo2ForGap(gaps[i]!, date)),
  }
}

test('lastScoredDay takes the latest resting heart rate or HRV row on or before the date', () => {
  const input: BodyAgeInput = {
    ...empty,
    restingHeartRate: [{ localDate: '2026-06-10', value: 60 }, { localDate: '2026-07-02', value: 60 }],
    hrv: [{ localDate: '2026-06-12', value: 50 }],
  }
  expect(lastScoredDay(input, '2026-06-30')).toBe('2026-06-12')
  expect(lastScoredDay(input, '2026-06-11')).toBe('2026-06-10')
  expect(lastScoredDay(input, '2026-06-30')).not.toBe('2026-07-02')
  expect(lastScoredDay(input, '2026-06-09')).toBeNull()
  expect(lastScoredDay(empty, TODAY)).toBeNull()
})

test('sync lag: current ends on the last scored day, not today', () => {
  const lastRow = shiftLocalDate(TODAY, -5)
  const input: BodyAgeInput = {
    ...empty,
    restingHeartRate: days(shiftLocalDate(lastRow, -29), 30, 60),
    vo2Max: [vo2ForGap(0, lastRow)],
  }
  const { current } = bodyAgeHistory(input, TODAY)
  expect(current?.endDate).toBe(lastRow)
  expect(current?.enough).toBe(true)
})

test('no scored day at all gives current null', () => {
  expect(bodyAgeHistory(empty, TODAY)).toEqual({
    current: null, previous: null, months: [], pace: null, youngest: null,
  })
  // A VO2 max reading alone is not a scored day.
  expect(bodyAgeHistory({ ...empty, vo2Max: [vo2ForGap(0, TODAY)] }, TODAY).current).toBeNull()
})

test('withheld months are absent from months', () => {
  // VO2 max readings 2025-10-01 and 2026-06-01: the 180-day carry-forward runs out on 2026-03-30 and
  // nothing is read again until June, so March (31st), April and May have no body age.
  const input: BodyAgeInput = {
    ...empty,
    hrv: days('2025-10-01', 273, 50),
    vo2Max: [vo2ForGap(-1, '2025-10-01'), vo2ForGap(-1, '2026-06-01')],
  }
  const { months, current } = bodyAgeHistory(input, TODAY)
  expect(months.map((m) => m.month)).toEqual(['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-06'])
  expect(current?.enough).toBe(true)
  expect(months[months.length - 1]!.endDate).toBe(TODAY)
})

test('a month is anchored on its last scored day, and rows after today are ignored', () => {
  const input: BodyAgeInput = {
    ...empty,
    hrv: [
      { localDate: '2026-05-03', value: 50 }, { localDate: '2026-05-20', value: 50 },
      { localDate: '2026-06-15', value: 50 }, { localDate: '2026-07-05', value: 50 },
    ],
    vo2Max: [vo2ForGap(-1, '2026-05-03')],
  }
  const { months, current } = bodyAgeHistory(input, TODAY)
  expect(months.map((m) => [m.month, m.endDate])).toEqual([['2026-05', '2026-05-20'], ['2026-06', '2026-06-15']])
  expect(current?.endDate).toBe('2026-06-15')
})

test('a month entry carries the anchor window\'s ages and gap', () => {
  const { months } = bodyAgeHistory(monthly('2026-06', [-2]), TODAY)
  expect(months).toHaveLength(1)
  const [m] = months
  expect(m!.gap).toBeCloseTo(-2, 9)
  expect(m!.bodyAge).toBeCloseTo(m!.calendarAge - 2, 9)
  expect(m!.calendarAge).toBeCloseTo(ageYearsAt(BIRTH, TODAY)!, 9)
})

test('youngest is the largest gap below calendar age, not the lowest age', () => {
  // A year apart, gaps -1 then -1.5: the earlier month has the lower body age, the later the larger gap.
  const input: BodyAgeInput = {
    ...empty,
    hrv: [{ localDate: '2025-06-30', value: 50 }, { localDate: '2026-06-30', value: 50 }],
    vo2Max: [vo2ForGap(-1, '2025-06-30'), vo2ForGap(-1.5, '2026-06-30')],
  }
  const { months, youngest } = bodyAgeHistory(input, TODAY)
  expect(months.map((m) => m.month)).toEqual(['2025-06', '2026-06'])
  expect(months[0]!.bodyAge).toBeLessThan(months[1]!.bodyAge)
  expect(youngest?.month).toBe('2026-06')
})

test('pace needs a month 12 months back', () => {
  // 11 months of history ends 2025-08 .. 2026-06: nothing 12 months before June 2026.
  expect(bodyAgeHistory(monthly('2025-08', Array(11).fill(-1)), TODAY).pace).toBeNull()

  // 13 months, 2025-06 .. 2026-06.
  const gaps = Array(13).fill(-1) as number[]
  gaps[0] = -1
  gaps[12] = -2.5
  const { months, pace } = bodyAgeHistory(monthly('2025-06', gaps), TODAY)
  expect(months).toHaveLength(13)
  const then = months[0]!
  const now = months[12]!
  expect(then.gap).toBeCloseTo(-1, 9)
  expect(now.gap).toBeCloseTo(-2.5, 9)
  // 2025-06-30 to 2026-06-30 is 365 days.
  expect(pace).toBeCloseTo(1 + (-2.5 - -1) / (365 / 365.25), 9)
})

test('pace is null when the month 12 months back is withheld', () => {
  const input = monthly('2025-06', Array(13).fill(-1) as number[])
  // Drop the VO2 readings around June 2025 so that month has a scored day but no body age.
  input.vo2Max = input.vo2Max.filter((r) => r.localDate > '2025-12-31')
  const { months, pace } = bodyAgeHistory(input, TODAY)
  expect(months.some((m) => m.month === '2025-06')).toBe(false)
  expect(pace).toBeNull()
})

test('previous is the window ending 30 days earlier', () => {
  const input: BodyAgeInput = {
    ...empty,
    hrv: days('2026-04-01', 91, 50),
    vo2Max: [vo2ForGap(-1, '2026-04-01'), vo2ForGap(-3, '2026-05-31'), vo2ForGap(-2, '2026-06-30')],
  }
  const { current, previous } = bodyAgeHistory(input, TODAY)
  expect(current?.endDate).toBe('2026-06-30')
  expect(previous?.endDate).toBe('2026-05-31')
  expect(previous?.window.to).toBe('2026-05-31')
  expect((current as BodyAgeAvailable).gap).toBeCloseTo(-2, 9)
  expect(previous?.gap).toBeCloseTo(-3, 9)
})

test('previous uses the last scored day on or before 30 days earlier', () => {
  const input: BodyAgeInput = {
    ...empty,
    hrv: [{ localDate: '2026-05-25', value: 50 }, { localDate: TODAY, value: 50 }],
    vo2Max: [vo2ForGap(-1, '2026-05-25')],
  }
  expect(bodyAgeHistory(input, TODAY).previous?.endDate).toBe('2026-05-25')
})

test('previous is null with no scored day that early, or when current is withheld', () => {
  const recent: BodyAgeInput = { ...empty, hrv: days('2026-06-21', 10, 50), vo2Max: [vo2ForGap(-1, TODAY)] }
  expect(bodyAgeHistory(recent, TODAY).previous).toBeNull()

  const noVo2: BodyAgeInput = { ...empty, hrv: days('2026-04-01', 91, 50) }
  const history = bodyAgeHistory(noVo2, TODAY)
  expect(history.current).toMatchObject({ enough: false, missing: ['vo2Max'] })
  expect(history.previous).toBeNull()
  expect(history.months).toEqual([])
  expect(history.pace).toBeNull()
  expect(history.youngest).toBeNull()
})

test('previous is null when the earlier window is withheld', () => {
  const input: BodyAgeInput = {
    ...empty,
    hrv: days('2026-04-01', 91, 50),
    vo2Max: [vo2ForGap(-1, '2026-06-30')],
  }
  const { current, previous } = bodyAgeHistory(input, TODAY)
  expect(current?.enough).toBe(true)
  // The reading dated 2026-06-30 does not exist yet on 2026-05-31.
  expect(previous).toBeNull()
})
