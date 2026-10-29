import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  BODY_AGE_FACTORS,
  BODY_AGE_TOTAL_CAP,
  BODY_AGE_WINDOW_DAYS,
  GOMPERTZ_SLOPE,
  MIN_FACTOR_DAYS,
  VO2_LOOKBACK_DAYS,
  ageYearsAt,
  fitnessAgeOf,
  yearsOf,
} from '../src/api/bodyAge.ts'

test('a value at its reference is zero years', () => {
  for (const f of BODY_AGE_FACTORS) {
    for (const sex of ['male', 'female'] as const) {
      for (const age of [25, 40, 63, 80]) {
        const ref = f.reference(age, sex)
        expect(yearsOf(f.logHazard(ref, ref), f.cap)).toEqual({ years: 0, capped: false })
      }
    }
  }
})

test('one MET of VO2 max above reference is ln(0.87)/slope years', () => {
  const vo2 = BODY_AGE_FACTORS.find((f) => f.key === 'vo2Max')!
  const ref = vo2.reference(40, 'male')
  expect(yearsOf(vo2.logHazard(ref + 3.5, ref), 99).years).toBeCloseTo(Math.log(0.87) / GOMPERTZ_SLOPE, 6)
})

test('10 bpm of resting heart rate above reference is ln(1.09)/slope years', () => {
  const rhr = BODY_AGE_FACTORS.find((f) => f.key === 'restingHeartRate')!
  const ref = rhr.reference(40, 'male')
  expect(yearsOf(rhr.logHazard(ref + 10, ref), 99).years).toBeCloseTo(Math.log(1.09) / GOMPERTZ_SLOPE, 6)
})

test('a cap binds at the cap and not before', () => {
  expect(yearsOf(GOMPERTZ_SLOPE * 2.999, 3)).toEqual({ years: expect.closeTo(2.999, 9), capped: false })
  expect(yearsOf(GOMPERTZ_SLOPE * 5, 3)).toEqual({ years: 3, capped: true })
  expect(yearsOf(-GOMPERTZ_SLOPE * 5, 3)).toEqual({ years: -3, capped: true })
})

test('every factor carries a citation', () => {
  for (const f of BODY_AGE_FACTORS) expect(f.citation.trim().length).toBeGreaterThan(20)
})

test('factors appear in the order of the key union', () => {
  const order = ['vo2Max', 'restingHeartRate', 'hrv', 'activity', 'sleepRegularity', 'strength']
  const keys = BODY_AGE_FACTORS.map((f) => f.key)
  expect(keys).toEqual(order.filter((k) => keys.includes(k as never)))
  expect(keys).toContain('vo2Max')
})

test('HRV cap never exceeds the smallest other cap', (ctx) => {
  const hrv = BODY_AGE_FACTORS.find((f) => f.key === 'hrv')
  if (hrv === undefined) {
    ctx.skip()
    return
  }
  const others = BODY_AGE_FACTORS.filter((f) => f.key !== 'hrv').map((f) => f.cap)
  expect(hrv.cap).toBeLessThanOrEqual(Math.min(...others))
})

test('the window constants are the spec values', () => {
  expect(BODY_AGE_WINDOW_DAYS).toBe(30)
  expect(VO2_LOOKBACK_DAYS).toBe(180)
  expect(MIN_FACTOR_DAYS).toBe(10)
  expect(BODY_AGE_TOTAL_CAP).toBeGreaterThan(0)
})

test('ageYearsAt is fractional and handles leap-day birthdays', () => {
  expect(ageYearsAt('1988-10-28', '2026-10-28')).toBeCloseTo(38, 6)
  expect(ageYearsAt('1988-04-28', '2026-10-28')).toBeCloseTo(38.5, 1)
  expect(ageYearsAt('2000-02-29', '2026-02-28')).toBeLessThan(26)
  expect(ageYearsAt('2000-02-29', '2026-03-01')).toBeGreaterThanOrEqual(26)
  expect(ageYearsAt('2030-01-01', '2026-10-28')).toBeNull()
  expect(ageYearsAt('2012-01-01', '2026-10-28')).toBeNull()
  expect(ageYearsAt('not-a-date', '2026-10-28')).toBeNull()
  expect(ageYearsAt('1988-13-45', '2026-10-28')).toBeNull()
})

test('fitness age inverts the VO2 reference', () => {
  const vo2 = BODY_AGE_FACTORS.find((f) => f.key === 'vo2Max')!
  expect(fitnessAgeOf(vo2.reference(45, 'female'), 'female')).toBeCloseTo(45, 1)
  expect(fitnessAgeOf(vo2.reference(33, 'male'), 'male')).toBeCloseTo(33, 1)
})

test('fitness age is null outside the reference table', () => {
  const vo2 = BODY_AGE_FACTORS.find((f) => f.key === 'vo2Max')!
  expect(fitnessAgeOf(vo2.reference(25, 'male') + 10, 'male')).toBeNull()
  expect(fitnessAgeOf(vo2.reference(85, 'male') - 5, 'male')).toBeNull()
})

// The page reads these constants in the browser, so the subpath may import only browser-safe modules:
// one that pulled the barrel or the database in would drag better-sqlite3 into the web bundle while
// every Node test stays green.
test('the @haelan/core/body-age subpath is published and imports only browser-safe modules', () => {
  const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
  const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, string> }
  expect(pkg.exports['./body-age']).toBe('./src/api/bodyAge.ts')
  const code = read('../src/api/bodyAge.ts')
  const imports = [...code.matchAll(/^import\s+(type\s+)?[^'"]*from\s*['"]([^'"]+)['"]/gm)]
    .map((m) => `${m[1] ? 'type ' : ''}${m[2]}`)
  const allowed = ['../derive/localDay.ts', 'type ./recoveryIndex.ts']
  expect(imports.filter((i) => !allowed.includes(i))).toEqual([])
  // No dynamic import, require or re-export can hide from the scan above.
  expect(code).not.toMatch(/\bimport\s*\(|\brequire\s*\(|^export\s[^\n]*\sfrom\s/m)
})
