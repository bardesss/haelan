import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The encrypted prefs are sealed with a Keystore key that never travels with a backup. A restored
// prefs file therefore cannot be opened on the new device. Excluding both prefs files from every
// backup path keeps that from happening; this guard reads the real files so the rules cannot drift
// from the file names in SessionStore.kt.
const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

const manifest = read('apps/android/app/src/main/AndroidManifest.xml')
const store = read('apps/android/app/src/main/java/com/haelan/android/SessionStore.kt')
const extraction = read('apps/android/app/src/main/res/xml/data_extraction_rules.xml')
const fullBackup = read('apps/android/app/src/main/res/xml/backup_rules.xml')

function constant(name: string, pattern: RegExp): string {
  const match = store.match(pattern)
  if (!match) throw new Error(`${name} not found in SessionStore.kt`)
  return match[1]
}

const secure = constant('FILE_SECURE', /const val FILE_SECURE = "([^"]+)"/)
const plain = constant('FILE_PLAIN', /const val FILE_PLAIN = "([^"]+)"/)
const excludes = [secure, plain].map((f) => `<exclude domain="sharedpref" path="${f}.xml"/>`)

function block(xml: string, tag: string): string {
  const match = xml.match(new RegExp(String.raw`<${tag}[\s>][\s\S]*?</${tag}>`))
  if (!match) throw new Error(`<${tag}> not found`)
  return match[0]
}

describe('android backup rules', () => {
  it('reads the two prefs file names', () => {
    expect([secure, plain]).toEqual(['haelan_secure', 'haelan'])
  })

  it('the manifest points at both backup rule files', () => {
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"')
    expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"')
  })

  it('every backup section excludes both prefs files', () => {
    for (const section of [
      block(extraction, 'cloud-backup'),
      block(extraction, 'device-transfer'),
      block(fullBackup, 'full-backup-content'),
    ]) {
      for (const line of excludes) expect(section).toContain(line)
    }
  })
})
