import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { androidColorFiles } from '../src/android.js'

// The Android app's generated resource directory, inside the module's build/, so the palette is
// an output like any other and a clean removes it. The Gradle build does not run this: it fails
// with the command to run when the two files are missing, because an Android build should not need
// a Node toolchain to assemble (T7.1). A second Android surface would change this one path.
const res = fileURLToPath(
  new URL('../../../apps/android/app/build/haelan-tokens/res/', import.meta.url),
)

for (const file of androidColorFiles()) {
  const out = join(res, file.path)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, file.xml)
  console.log('wrote', out)
}
