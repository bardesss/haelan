import { appendFileSync } from 'node:fs'
import { loadTokens, refresh } from './lib.mjs'

const log = new URL('./findings/token-log.jsonl', import.meta.url)
const issued = loadTokens().obtained_at
const ageDays = (Date.now() - Date.parse(issued)) / 864e5

let entry
try {
  await refresh()
  entry = { at: new Date().toISOString(), issued, ageDays: +ageDays.toFixed(2), ok: true }
} catch (e) {
  entry = { at: new Date().toISOString(), issued, ageDays: +ageDays.toFixed(2), ok: false, status: e.status, error: e.body?.error }
}
appendFileSync(log, JSON.stringify(entry) + '\n')
console.log(entry)
