import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitCss } from '../src/emit.js'

// Writes into this package and exports the path; a second app needs no change here.
const out = fileURLToPath(new URL('../dist/theme.css', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, emitCss())
console.log('wrote', out)
