import { describe, it, expect } from 'vitest'
import { androidReleaseVersion } from '../android-release-version.ts'

describe('androidReleaseVersion', () => {
  it('reads the name from the tag and derives a code that only moves upward', () => {
    expect(androidReleaseVersion('android-v0.2.0')).toEqual({ versionName: '0.2.0', versionCode: 2000 })
    expect(androidReleaseVersion('android-v1.39.2')).toEqual({ versionName: '1.39.2', versionCode: 1039002 })
  })

  it('orders these tags correctly, including the points where a component rolls over', () => {
    // The whole point of the code is that Android compares it to decide whether an APK is an
    // update, so ordering is the property worth asserting. A run of plain ascending versions is
    // not enough to prove it: a formula with an undersized coefficient for the higher component
    // can still agree with the two exact values above and still climb across widely spaced points,
    // by construction, and pass anyway. It only shows itself at a rollover, where a lower
    // component is at its ceiling and the next tag carries into the component above it instead.
    // 0.999.999 next to 1.0.0, and 1.999.999 next to 2.0.0, are exactly those points, and either
    // pair alone is enough to catch a minor or patch coefficient that is too small.
    const ascending = [
      'android-v0.0.1',
      'android-v0.1.0',
      'android-v0.2.0',
      'android-v0.999.999', // rollover: minor and patch both at their ceiling
      'android-v1.0.0', // ... and major carries
      'android-v1.0.1',
      'android-v1.39.2',
      'android-v1.999.999', // rollover again, one major higher
      'android-v2.0.0',
    ].map((tag) => androidReleaseVersion(tag).versionCode)
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b))
    expect(new Set(ascending).size).toBe(ascending.length)
  })

  it('stays inside the ceiling Android allows', () => {
    // Android refuses a versionCode above 2100000000, which this scheme reaches at version 2099.
    expect(androidReleaseVersion('android-v2099.999.999').versionCode).toBeLessThan(2_100_000_000)
  })

  it('refuses a tag it cannot parse rather than inventing a version', () => {
    // A silent fallback to zero would publish an APK that no later release could ever update,
    // because every later code would have to be greater and zero is already the floor.
    for (const bad of ['v0.2.0', 'android-v0.2', 'android-v0.2.0-rc1', 'android-vx.y.z', 'android-v1.1000.0', '']) {
      expect(() => androidReleaseVersion(bad)).toThrow()
    }
  })
})
