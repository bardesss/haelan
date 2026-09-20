// Prints the version an android-v tag derives, as GitHub Actions step outputs.
//
// A .mjs entry point importing the .ts module directly, run with --experimental-strip-types, is
// how this repo already reaches TypeScript from a raw node process: generate-tools-doc.mjs
// statically imports three .ts modules the same way, and package.json's "start" script runs a
// whole .ts entry point under the same flag. The alternative considered for the release
// workflow's version step was `node -e` with a dynamic `import()` of a template string, and that
// was dropped unproven: `-e` does not go through the module resolver the same way a real file
// does, and it is not the route vitest or vite take to load a .ts file either. A file on disk is.
//
// Usage: node --experimental-strip-types scripts/print-android-release-version.mjs <tag>
import { androidReleaseVersion } from './android-release-version.ts'

const tag = process.argv[2]
if (!tag) {
  console.error('usage: node --experimental-strip-types scripts/print-android-release-version.mjs <tag>')
  process.exit(1)
}

try {
  const { versionName, versionCode } = androidReleaseVersion(tag)
  console.log(`name=${versionName}`)
  console.log(`code=${versionCode}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
