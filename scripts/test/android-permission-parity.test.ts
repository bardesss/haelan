import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// A permission has to be in TWO places to work: declared in the manifest, and asked for by the set
// the consent screen sends to Health Connect. Neither file mentions the other, nothing checked that
// they agreed, and the gap is silent in both directions - a permission the manifest declares but
// the set never requests is never granted, and one the set requests but the manifest omits is
// refused at the platform.
//
// This branch shipped exactly that. Routes were read, mapped, stored, served and drawn, with a
// comment arguing the route permission could not be declared at all; the permission exists
// (android.health.connect.HealthPermissions.READ_EXERCISE_ROUTES, android-36), and without it
// every GPS workout answers ConsentRequired and no route is ever sent. Every test stayed green
// because they all construct their own records and never cross this boundary.
//
// Same idiom as companion-stale-source-drift.test.ts: read both real files, compare them here, so
// the drift fails at the seam rather than on a phone.
const root = new URL('../../', import.meta.url)
const MANIFEST_PATH = 'apps/android/app/src/main/AndroidManifest.xml'
const ENGINE_PATH = 'apps/android/app/src/main/java/com/haelan/android/SyncEngine.kt'
const manifest = readFileSync(new URL(MANIFEST_PATH, root), 'utf8')
const engine = readFileSync(new URL(ENGINE_PATH, root), 'utf8')

/** Every `android.permission.health.*` the manifest declares, by its bare name. */
function declared(): Set<string> {
  const found = manifest.matchAll(/android:name="android\.permission\.health\.([A-Z_0-9]+)"/g)
  return new Set([...found].map((match) => match[1]!))
}

/**
 * Every health permission `readPermissions()` asks for, by the same bare name.
 *
 * Two spellings reach the same place and both have to be read. Most entries are
 * `getReadPermission(FooRecord::class)`, which Health Connect resolves to READ_FOO at runtime, so
 * the record class is mapped to the permission name via RECORD_PERMISSIONS below rather than
 * guessed from the class name - the two disagree often enough (HeartRateVariabilityRmssdRecord is
 * READ_HEART_RATE_VARIABILITY, Vo2MaxRecord is READ_VO2_MAX) that guessing would make this guard
 * lie. The rest are literals or HealthPermission constants, read straight.
 */
const RECORD_PERMISSIONS: Record<string, string> = {
  StepsRecord: 'READ_STEPS',
  HeartRateRecord: 'READ_HEART_RATE',
  WeightRecord: 'READ_WEIGHT',
  SleepSessionRecord: 'READ_SLEEP',
  ExerciseSessionRecord: 'READ_EXERCISE',
  ActiveCaloriesBurnedRecord: 'READ_ACTIVE_CALORIES_BURNED',
  BasalMetabolicRateRecord: 'READ_BASAL_METABOLIC_RATE',
  DistanceRecord: 'READ_DISTANCE',
  HeightRecord: 'READ_HEIGHT',
  BodyFatRecord: 'READ_BODY_FAT',
  HeartRateVariabilityRmssdRecord: 'READ_HEART_RATE_VARIABILITY',
  OxygenSaturationRecord: 'READ_OXYGEN_SATURATION',
  RespiratoryRateRecord: 'READ_RESPIRATORY_RATE',
  RestingHeartRateRecord: 'READ_RESTING_HEART_RATE',
  BodyTemperatureRecord: 'READ_BODY_TEMPERATURE',
  BloodGlucoseRecord: 'READ_BLOOD_GLUCOSE',
  HydrationRecord: 'READ_HYDRATION',
  Vo2MaxRecord: 'READ_VO2_MAX',
  ElevationGainedRecord: 'READ_ELEVATION_GAINED',
}

function readPermissionsBody(): string {
  const start = engine.indexOf('fun readPermissions()')
  expect(
    start,
    `${ENGINE_PATH}: 'readPermissions()' not found - has it moved or been renamed? This guard `
    + 'cannot compare a set it cannot find, and must say so rather than compare an empty one.',
  ).toBeGreaterThan(-1)
  const end = engine.indexOf('\n    )', start)
  expect(
    end,
    `${ENGINE_PATH}: could not find the end of 'readPermissions()' - its closing paren is no longer `
    + 'on its own line at the expected indent.',
  ).toBeGreaterThan(-1)
  return engine.slice(start, end)
}

function requested(): Set<string> {
  const body = readPermissionsBody()
  const names = new Set<string>()
  for (const match of body.matchAll(/getReadPermission\((\w+)::class\)/g)) {
    const record = match[1]!
    const permission = RECORD_PERMISSIONS[record]
    expect(
      permission,
      `${ENGINE_PATH}: readPermissions() asks for '${record}', which this guard has no permission `
      + 'name for. Add it to RECORD_PERMISSIONS with the name Health Connect resolves it to, taken '
      + 'from the manifest entry you added alongside it. Guessing the name from the class would '
      + 'make this guard agree with itself and prove nothing.',
    ).toBeDefined()
    names.add(permission!)
  }
  for (const match of body.matchAll(/"android\.permission\.health\.([A-Z_0-9]+)"/g)) names.add(match[1]!)
  // PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND carries its own READ_ already, so the constant's
  // name after the PERMISSION_ prefix is the permission name as the manifest spells it.
  for (const match of body.matchAll(/HealthPermission\.PERMISSION_([A-Z_0-9]+)/g)) names.add(match[1]!)
  // A bare constant reference, the shape READ_EXERCISE_ROUTES uses: resolved to its literal by
  // finding the `const val` it names, so the set is read as what it actually sends.
  for (const match of body.matchAll(/^\s+([A-Z][A-Z_0-9]+),$/gm)) {
    const literal = new RegExp(`const val ${match[1]!} = "android\\.permission\\.health\\.([A-Z_0-9]+)"`).exec(engine)
    expect(
      literal,
      `${ENGINE_PATH}: readPermissions() names '${match[1]!}', but no 'const val ${match[1]!}' with `
      + 'a health permission string was found to resolve it to.',
    ).not.toBeNull()
    names.add(literal![1]!)
  }
  return names
}

/**
 * What the two parity tests below CANNOT see, and why this third one exists.
 *
 * Parity catches asymmetry: one file naming a permission the other does not. The defect that
 * actually shipped was symmetric. Neither file named the route permission, both agreed perfectly,
 * and the app read routes it had never asked for. A guard written for that bug which only compares
 * the two files would have stayed green on it - this was confirmed by deleting both entries and
 * watching the parity tests pass.
 *
 * So the reading is tied to the asking. The subject is the code that consumes a route, not a
 * permission list, because that is the thing whose presence means the permission is needed.
 */
describe('Android health permissions: reading a route means asking for it', () => {
  it('requests READ_EXERCISE_ROUTES whenever the app reads exerciseRouteResult', () => {
    const readsRoutes = engine.includes('exerciseRouteResult')
    expect(
      readsRoutes,
      `${ENGINE_PATH}: no longer reads 'exerciseRouteResult'. If routes were removed on purpose, `
      + 'remove this test and the permission with them; if not, the route feature has lost its '
      + 'only source.',
    ).toBe(true)
    expect(
      requested().has('READ_EXERCISE_ROUTES'),
      `${ENGINE_PATH} reads 'exerciseRouteResult' but readPermissions() never asks for `
      + 'READ_EXERCISE_ROUTES. Health Connect answers ConsentRequired for every GPS workout to a '
      + 'reader without it, so routeJson returns null on its first line and no route is ever sent: '
      + 'a feature that ships, passes every test, and does nothing on a real phone. The permission '
      + 'is real - android.health.connect.HealthPermissions.READ_EXERCISE_ROUTES on android-36 - '
      + 'even though connect-client 1.1.0 has no constant for it, so it is asked for as a literal.',
    ).toBe(true)
  })
})

describe('Android health permissions: the manifest and the requested set agree', () => {
  it('declares every permission the app asks for', () => {
    const missing = [...requested()].filter((name) => !declared().has(name)).sort()
    expect(
      missing,
      `${MANIFEST_PATH} does not declare ${missing.join(', ')}, which readPermissions() asks for. `
      + 'The platform refuses an undeclared permission, so the consent screen cannot grant it and '
      + 'every read of that data is answered as though the household said no.',
    ).toEqual([])
  })

  it('asks for every permission it declares', () => {
    const unused = [...declared()].filter((name) => !requested().has(name)).sort()
    expect(
      unused,
      `${MANIFEST_PATH} declares ${unused.join(', ')}, which readPermissions() never asks for. A `
      + 'declared permission is never granted on its own: the consent screen only offers what the '
      + 'set sends. This is how routes shipped reading nothing - the data was mapped, stored and '
      + 'drawn, and the permission behind it was never requested.',
    ).toEqual([])
  })
})
