import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The background sync used to be scheduled only from the sync screen, so a person who signed in
// and never opened it was never synced. startMain is the one place the typed sign-in and the
// saved-session sign-in both pass through. Same idiom as android-session-name-placement.test.ts:
// read the real Kotlin source, and fail loudly when the function is not found.
const root = new URL('../../', import.meta.url)
const LOGIN_PATH = 'apps/android/app/src/main/java/com/haelan/android/LoginActivity.kt'
const source = readFileSync(new URL(LOGIN_PATH, root), 'utf8').replace(/\r\n/g, '\n')

const DECLARATION = '\n    (?:private |internal |public |override )?fun '

function functionBody(functionName: string): string {
  const declared = new RegExp(`${DECLARATION}${functionName}\\(`).exec(source)
  expect(declared, `${LOGIN_PATH}: '${functionName}' not found - has it moved or been renamed?`).not.toBeNull()
  const start = declared!.index
  const after = new RegExp(DECLARATION, 'g')
  after.lastIndex = start + 1
  const nextFun = after.exec(source)?.index ?? -1
  expect(nextFun, `${LOGIN_PATH}: could not find the end of '${functionName}'`).toBeGreaterThan(-1)
  return source.slice(start, nextFun)
}

describe('LoginActivity sign-in', () => {
  it('startMain enqueues the background sync, so a sign-in that never opens the sync screen still syncs', () => {
    expect(functionBody('startMain')).toMatch(/SyncSchedule\.enqueue\(this\)/)
  })
})
