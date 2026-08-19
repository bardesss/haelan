import { writeFileSync, mkdirSync } from 'node:fs'
import { api } from './lib.mjs'

mkdirSync(new URL('./samples/', import.meta.url), { recursive: true })

// v4 has no data type discovery endpoint, so this only proves the token works and captures
// the two account-shaped payloads M1 needs for the people and sources tables.
for (const [label, path] of [
  ['profile', '/users/me/profile'],
  ['pairedDevices', '/users/me/pairedDevices'],
]) {
  try {
    const { raw, url } = await api(path)
    writeFileSync(new URL(`./samples/_${label}.json`, import.meta.url), raw)
    console.log(`${label}: ok, ${(raw.length / 1024).toFixed(1)} kB, ${url}`)
  } catch (e) {
    console.log(`${label}: FAILED ${e.message}`)
  }
}
