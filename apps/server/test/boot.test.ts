import { describe, it, expect, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let child: ChildProcess | null = null
let dir: string | null = null

async function stopChild(): Promise<void> {
  // Windows keeps the SQLite file locked until the child has actually gone, so the exit is
  // awaited rather than assumed: removing the directory a millisecond after kill() fails with
  // EPERM and reports as a test failure that has nothing to do with the test.
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child?.once('exit', () => resolve()))
    child.kill()
    await exited
  }
  child = null
}

afterEach(async () => {
  await stopChild()
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  dir = null
})

/** A port nothing is listening on, found by briefly listening on one and letting go. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const { port } = address
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())))
  return port
}

/**
 * The command `pnpm start` actually runs, read from package.json rather than restated, so a
 * change to the dev script has to come here and be considered rather than silently escaping
 * this test.
 */
function devCommand(): string[] {
  const pkg = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as {
    scripts: { dev: string }
  }
  const parts = pkg.scripts.dev.split(/\s+/)
  expect(parts[0], 'the dev script must invoke node directly').toBe('node')
  return parts.slice(1)
}

/** The node flags each entry script passes, so the two cannot drift apart unnoticed. */
function flagsOf(command: string): string[] {
  return command.split(/\s+/).filter((part) => part.startsWith('--'))
}

interface BootOutcome {
  ok: boolean
  output: string
  health?: unknown
  setupState?: unknown
}

async function bootOnce(dataDir: string): Promise<BootOutcome> {
  const port = await freePort()
  child = spawn(process.execPath, devCommand(), {
    cwd: SERVER_ROOT,
    env: { ...process.env, HAELAN_DATA_DIR: dataDir, HAELAN_PORT: String(port), HAELAN_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

  let exited = false
  child.once('exit', () => { exited = true })

  for (let attempt = 0; attempt < 100 && !exited; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (response.ok) {
        const health: unknown = await response.json()
        const state = await fetch(`http://127.0.0.1:${port}/api/setup/state`)
        return { ok: true, output, health, setupState: await state.json() as unknown }
      }
    } catch {
      // Not up yet. The exit flag is what turns a crash into a prompt failure rather than
      // letting this loop spin for ten seconds and report nothing useful.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  await stopChild()
  return { ok: false, output }
}

describe('the entry point boots', () => {
  // Every other server test builds the app in process, where vitest has already compiled the
  // TypeScript. That is why the whole suite passed while `pnpm start` could not start at all:
  // Node's type stripping is strip-only and rejects syntax vitest accepts, so nothing short of
  // running the real command finds out. Spawning it is the only assertion that would have.
  it('runs the real command against a real data directory and answers a health check', async () => {
    dir = mkdtempSync(join(tmpdir(), 'haelan-boot-'))

    // freePort finds a port by letting one go, so another test binding port 0 in the same run
    // can take it in between. Retrying on a fresh port keeps that race from reading as a boot
    // failure, which is the one thing this test exists to report accurately.
    let lastFailure = ''
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await bootOnce(dir)
      if (outcome.ok) {
        expect(outcome.health).toEqual({ ok: true })
        // A fresh volume boots straight into the wizard, which is the state a first run is in.
        expect(outcome.setupState).toEqual({ step: 'account' })
        return
      }
      lastFailure = outcome.output
      if (!/EADDRINUSE|address already in use/i.test(outcome.output)) break
    }
    throw new Error(`the server did not boot:\n${lastFailure}`)
  })

  it('starts the same way from the repository root as it does from the package', () => {
    // pnpm start and pnpm dev:server are two doors into one process. Only the first is spawned
    // above, so this pins the second: a flag added to one and not the other means the command
    // the documentation gives people is not the command this test proved.
    const root = JSON.parse(readFileSync(join(SERVER_ROOT, '../../package.json'), 'utf8')) as {
      scripts: { start: string }
    }
    const server = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as {
      scripts: { dev: string }
    }
    expect(flagsOf(root.scripts.start)).toEqual(flagsOf(server.scripts.dev))

    // And it runs node itself rather than delegating, so its working directory is the
    // repository root and a relative HAELAN_DATA_DIR lands where the README says it does.
    expect(root.scripts.start.startsWith('node ')).toBe(true)
  })
})
