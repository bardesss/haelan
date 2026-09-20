/**
 * The app's version, from the tag that released it.
 *
 * `versionCode` is the only thing Android consults when deciding whether an APK is an update, so it
 * has to move and it has to move upward. Deriving it from the name keeps one source of truth: the
 * tag. The multipliers give minor and patch a thousand each, which puts the ceiling at version 2099
 * against Android's own limit of 2100000000.
 *
 * Here rather than in `build.gradle.kts`, for two reasons. A Gradle build script is not on the
 * `src/test` classpath, so a derivation living there could not be tested at all. And the workflow
 * needs the name anyway, for the release title and the APK file, so computing it once out here
 * removes a second implementation rather than adding one.
 *
 * Throws rather than falling back. A tag nobody can parse is a mistake somebody should see before a
 * release exists, and a silent zero would publish an APK that no later version could update: every
 * later code must be greater, and zero is already the floor.
 */
const TAG = /^android-v(\d{1,4})\.(\d{1,3})\.(\d{1,3})$/

// Android refuses a versionCode at or above this. The regex above bounds major to four digits,
// which reaches versionCode 9999999999 at the top -- comfortably past the limit -- so the ceiling
// is enforced on the derived number instead of by narrowing the regex further. A regex tight
// enough to reject every over-ceiling combination on its own would also have to know that minor
// and patch matter to the total, which is arithmetic the regex has no business doing.
const ANDROID_VERSION_CODE_CEILING = 2_100_000_000

export function androidReleaseVersion(tag: string): { versionName: string, versionCode: number } {
  const found = TAG.exec(tag)
  if (!found) {
    throw new Error(
      `'${tag}' is not an android release tag. Expected android-v<major>.<minor>.<patch>, `
      + 'with minor and patch under 1000 so the version code keeps its ordering.',
    )
  }
  const [rawMajor, rawMinor, rawPatch] = found.slice(1, 4) as [string, string, string]

  // '02' parses to 2, so the regex alone would let android-v1.02.3 through as versionName
  // '1.2.3': the tag and the version it produces would disagree, silently, forever, since the tag
  // is immutable once pushed. Refusing the leading zero here keeps the tag the single source of
  // truth the rest of this module already assumes it is.
  for (const [label, raw] of [['major', rawMajor], ['minor', rawMinor], ['patch', rawPatch]] as const) {
    if (raw.length > 1 && raw.startsWith('0')) {
      throw new Error(
        `'${tag}' has a leading zero in its ${label} component ('${raw}'). Android does not see `
        + 'leading zeros, so the tag and the version it produces would disagree.',
      )
    }
  }

  const [major, minor, patch] = [Number(rawMajor), Number(rawMinor), Number(rawPatch)]
  const versionCode = major * 1_000_000 + minor * 1_000 + patch

  // Checked on the derived value rather than folded into the regex: this is the number Android
  // actually compares an install against, and the regex's four-digit major already admits tags
  // this rejects. A tag above the ceiling is a mistake somebody should see before a release
  // exists, the same reasoning the unparseable-tag branch above already applies.
  if (versionCode >= ANDROID_VERSION_CODE_CEILING) {
    throw new Error(
      `'${tag}' derives versionCode ${versionCode}, which is at or above Android's limit of `
      + `${ANDROID_VERSION_CODE_CEILING}. Keep major at or under 2099.`,
    )
  }

  return {
    versionName: `${major}.${minor}.${patch}`,
    versionCode,
  }
}
