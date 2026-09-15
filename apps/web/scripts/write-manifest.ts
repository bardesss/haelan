// The only thing that writes public/manifest.webmanifest. Kept separate from
// generate-manifest.ts so that file's renderManifest() export stays side-effect free and safe for
// test/manifest.test.ts to import - see that file's own header.
//
// Run with `pnpm --filter @haelan/web manifest`.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderManifest } from './generate-manifest.ts'

const out = fileURLToPath(new URL('../public/manifest.webmanifest', import.meta.url))
writeFileSync(out, renderManifest())
console.log('wrote', out)
