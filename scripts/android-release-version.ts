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

export function androidReleaseVersion(tag: string): { versionName: string, versionCode: number } {
  const found = TAG.exec(tag)
  if (!found) {
    throw new Error(
      `'${tag}' is not an android release tag. Expected android-v<major>.<minor>.<patch>, `
      + 'with minor and patch under 1000 so the version code keeps its ordering.',
    )
  }
  const [major, minor, patch] = [Number(found[1]), Number(found[2]), Number(found[3])]
  return {
    versionName: `${major}.${minor}.${patch}`,
    versionCode: major * 1_000_000 + minor * 1_000 + patch,
  }
}
