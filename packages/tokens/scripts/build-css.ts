import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitCss } from '../src/emit.js'

const out = fileURLToPath(new URL('../../../apps/web/src/theme.generated.css', import.meta.url))
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, emitCss())
console.log('wrote', out)
