// Builds the static demo's fixture set: seeds a throwaway instance, mounts every page of the real
// app against it through demo/capture/record.tsx, and writes what each page asked for into
// demo/capture/out/ as a manifest plus one JSON file per response.
//
// A script rather than a test, for the same reason build-site.mjs and seed-demo.mjs are: this
// writes real files to a real (throwaway) directory and takes minutes to run, neither of which is
// what a test suite's temp-and-delete-per-case discipline is for. scripts/test/capture-demo.test.ts
// covers the one pure function here (writeCapture) directly, with a synthetic Map; the sweep
// itself has no unit test; running it for real is what `pnpm demo:capture` (this file's own main
// flow, below) is for. See demo/capture/vitest.config.ts's own comment for why the sweep is kept
// out of `pnpm test` entirely rather than merely untested.
//
// Usage: pnpm demo:capture [days]

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Measured 2026-09-13, seeding the default 365 days, after the final review round widened the
 * sweep a second time: two anchor steps back per range preset instead of one (the critical finding
 * that the ControlRow back chevron reached a nothing-recorded anchor in exactly two clicks), and
 * every night and session the default Week and Month lists actually show instead of a hardcoded
 * five of each. 680 files, 7 380 571 bytes (7.0 MB), 79.9s wall clock (seed + rebuild + the whole
 * sweep) - up from the prior widening's measurement (496 files, 6 732 996 bytes, 59.1s), and still
 * comfortably inside the spec's under-40 MB bracket, so the demo keeps the full 365 day span
 * rather than trimming intraday to 90 days or cutting the seed to 180.
 *
 * MAX_CAPTURE_BYTES is roughly 1.5x that measurement (7 380 571 * 1.5 = 11 070 856.5, rounded up):
 * a ceiling that catches a runaway (a route that starts recording every source separately, say, or
 * a metric catalogue that grows sharply), not one that trips on the ordinary growth a new card or
 * a new day of seeded data adds.
 */
const MAX_CAPTURE_BYTES = 11_070_857

/**
 * Writes one JSON file per recorded response into `outDir`, plus a manifest mapping each response's
 * canonical URL to the file that holds it. Returns the file count and the total bytes written,
 * including the manifest itself - the number Step 5's measurement is about is the capture's whole
 * footprint on disk, not just the response bodies.
 *
 * The file name is a hash of the URL rather than the URL itself: a URL is not a filename. A slash
 * in it would create a directory nobody asked for (`/sleep/nights?range=week` has one before the
 * query even starts), and truncating or escaping it by hand risks two different urls colliding on
 * the same name - a hash of the whole string does not.
 *
 * Refuses an empty capture rather than writing a manifest with nothing in it: that manifest would
 * still exist, still parse, and would publish a demo where every single page answers "not in the
 * demo" - a broken sweep that looks, from the file system, exactly like a successful one.
 *
 * Clears `outDir` first. Every file name is a hash of its url, so a rerun that still asks the same
 * questions overwrites the same names - but a sweep that asks fewer or different questions than
 * last time (a route renamed, a page that stopped fetching something) would otherwise leave last
 * run's files behind, unreferenced by the new manifest.json and invisible to it, while Task 5's
 * build still copies the whole directory and the byte count this file measures counts them too.
 */
export function writeCapture(outDir, recorded) {
  if (recorded.size === 0) {
    throw new Error('writeCapture refuses to write an empty capture: the sweep recorded nothing')
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const manifest = {}
  let bytes = 0
  for (const [url, body] of recorded) {
    const name = `${createHash('sha256').update(url).digest('hex').slice(0, 24)}.json`
    const json = JSON.stringify(body)
    writeFileSync(join(outDir, name), json)
    bytes += Buffer.byteLength(json)
    manifest[url] = name
  }

  const manifestJson = JSON.stringify(manifest)
  writeFileSync(join(outDir, 'manifest.json'), manifestJson)
  bytes += Buffer.byteLength(manifestJson)

  return { files: recorded.size, bytes }
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Run directly (pnpm demo:capture), not imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootDir = fileURLToPath(new URL('..', import.meta.url))
  const outDir = join(rootDir, 'demo/capture/out')
  const days = process.argv[2] === undefined ? 365 : Number(process.argv[2])
  if (!Number.isInteger(days) || days <= 0) {
    console.error(`days must be a positive whole number, got ${process.argv[2]}`)
    process.exit(1)
  }

  const workDir = mkdtempSync(join(tmpdir(), 'haelan-demo-capture-'))
  const dataDir = join(workDir, 'data')
  // Where record.tsx leaves its report, read back once the recorder process has exited. Not a
  // marked stdout line (an earlier version of this file used one): a pipe's stdout is written
  // asynchronously on Windows, and vitest's own process teardown right after the last test can
  // exit before that final console.log's bytes actually reach the parent's pipe, which loses the
  // line silently on a slow enough run without ever failing loudly. A synchronous file write has
  // no such race. Outside outDir on purpose: outDir is exactly the directory Task 5 copies into
  // the demo bundle, and a stray report file sitting beside manifest.json would ship in it.
  const reportFile = join(workDir, 'report.json')
  const startedMs = performance.now()

  try {
    console.log(`seeding ${days} days into ${dataDir}...`)
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/seed-demo.mjs', dataDir, String(days)],
      { cwd: rootDir, stdio: 'inherit' },
    )

    console.log('running the recorder (mounts every page against the seeded instance - this can take several minutes)...')
    try {
      execFileSync(
        process.execPath,
        [join(rootDir, 'node_modules/vitest/vitest.mjs'), 'run', '-c', 'demo/capture/vitest.config.ts'],
        {
          cwd: rootDir,
          stdio: 'inherit',
          env: {
            ...process.env,
            HAELAN_DEMO_DATA_DIR: dataDir,
            HAELAN_DEMO_OUT_DIR: outDir,
            HAELAN_DEMO_DAYS: String(days),
            HAELAN_DEMO_REPORT_FILE: reportFile,
          },
        },
      )
    } catch (error) {
      throw new Error(`the recorder failed - see its own output above for which page and why: ${error.message}`)
    }

    if (!existsSync(reportFile)) {
      throw new Error(
        'the recorder exited without writing a report - it should have written one at '
        + `${reportFile} as its very last step, so either it never reached that step or something `
        + 'removed the file after; see its own output above for what actually ran',
      )
    }
    const report = JSON.parse(readFileSync(reportFile, 'utf8'))

    const elapsedMs = Math.round(performance.now() - startedMs)
    console.log(
      `wrote ${report.files} files, ${formatMb(report.bytes)} (${report.bytes} bytes), `
      + `in ${(elapsedMs / 1000).toFixed(1)}s`,
    )

    if (report.bytes > MAX_CAPTURE_BYTES) {
      console.error(
        `the capture is ${formatMb(report.bytes)}, over the ${formatMb(MAX_CAPTURE_BYTES)} ceiling `
        + `(MAX_CAPTURE_BYTES in this file) - this is the runaway guard, not an ordinary size bump; `
        + 're-measure and update the ceiling only after checking why the capture grew this much.',
      )
      process.exit(1)
    }
  } finally {
    // Deliberately after the recorder subprocess has exited: it closes the instance (and so the
    // SQLite handle) in its own afterAll before that process's own exit, so by the time
    // execFileSync above returns, nothing still holds `dataDir` open. Removing it any earlier -
    // or from a still-running child - is exactly the EPERM-over-a-real-error trap this
    // repository's rmSync-in-a-finally note describes.
    rmSync(workDir, { recursive: true, force: true })
  }
}
