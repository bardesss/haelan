import { describe, it, expect } from 'vitest'
import { androidReleaseVersion } from '../android-release-version.ts'

describe('androidReleaseVersion', () => {
  it('reads the name from the tag and derives a code that only moves upward', () => {
    expect(androidReleaseVersion('android-v0.2.0')).toEqual({ versionName: '0.2.0', versionCode: 2000 })
    expect(androidReleaseVersion('android-v1.39.2')).toEqual({ versionName: '1.39.2', versionCode: 1039002 })
  })

  it('orders every version the scheme can express', () => {
    // The whole point of the code is that Android compares it to decide whether an APK is an
    // update, so the ordering is the property worth asserting rather than any single value.
    const ascending = ['android-v0.0.1', 'android-v0.1.0', 'android-v0.2.0', 'android-v1.0.0', 'android-v1.0.1', 'android-v1.39.2']
      .map((tag) => androidReleaseVersion(tag).versionCode)
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
