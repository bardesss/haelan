import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, renameSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { platform } from 'node:process'

const real = fileURLToPath(new URL('src/api/client.ts', import.meta.url))
const demo = fileURLToPath(new URL('src/demo/client.ts', import.meta.url))

/**
 * Normalises a module id to an absolute filesystem path for comparison.
 *
 * `this.resolve`'s result is a `file://` URL on some Vite versions and a plain path on others,
 * and a plain Windows path (`C:\Users\...`) is not valid input to the `URL` constructor at all -
 * its drive-letter colon parses as a scheme separator. So this checks for the `file://` prefix by
 * hand rather than routing everything through `new URL(...)`, and lower-cases the result on
 * Windows, where the same file can resolve with either drive-letter case depending on which
 * import triggered it.
 */
function normalizeId(id: string): string {
  const withoutQuery = id.split('?')[0] ?? id
  const asPath = withoutQuery.startsWith('file://') ? fileURLToPath(withoutQuery) : withoutQuery
  const normalized = normalize(asPath)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

const realId = normalizeId(real)

/**
 * Redirects the app's one transport module to the demo's.
 *
 * A resolveId plugin rather than resolve.alias: every importer names this module by a different
 * relative specifier ('../api/client.js', './api/client.js'), and aliasing runs on the raw
 * specifier before resolution, so an alias would have to enumerate them. Resolving first and
 * comparing the resolved id redirects all of them by the only thing they have in common.
 *
 * src/demo/client.ts imports ApiError from api/apiError.ts, never from api/client.ts, so this
 * cannot recurse.
 */
function demoTransport(): Plugin {
  return {
    name: 'haelan-demo-transport',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer === undefined || source.startsWith('\0')) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (resolved === null) return null
      return normalizeId(resolved.id) === realId ? demo : null
    },
  }
}

/**
 * Copies the recorder's capture into the bundle at `demo-api/`, the path the transport fetches
 * from (`${BASE_URL}demo-api/manifest.json`).
 *
 * Vite's `public/` copying would do this for free, but `public/` is shared with every other build
 * apps/web produces, including a real instance's - so Task 3 wrote the capture to
 * `demo/capture/out/` instead of `apps/web/public/`, and this plugin is what carries it into
 * `dist-demo/` in its place.
 *
 * Runs in `closeBundle`, after Vite has written `dist-demo/`, and fails loudly rather than
 * shipping a demo with no fixtures: a manifestless demo still builds and still deploys, and
 * answers "not in the demo" on every single page - a broken build that looks, from CI's exit
 * code alone, exactly like a successful one.
 */
function demoFixtures(): Plugin {
  const captureDir = fileURLToPath(new URL('../../demo/capture/out', import.meta.url))
  return {
    name: 'haelan-demo-fixtures',
    closeBundle() {
      if (!existsSync(captureDir)) {
        throw new Error(
          `demo:build needs a capture at ${captureDir}, and it does not exist. Run \`pnpm demo:capture\` first.`,
        )
      }
      const outDir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'dist-demo/demo-api')
      cpSync(captureDir, outDir, { recursive: true })
    },
  }
}

/**
 * Rollup names an html entry's emitted asset after its input file, so `index.demo.html` in ->
 * `index.demo.html` out. Task 8's `buildSite` copies `apps/web/dist-demo/index.html` (and that
 * same file again as `404.html`, since GitHub Pages has no SPA fallback) into the published
 * site, so the file the demo build ships has to be named `index.html` regardless of what its
 * source file is called - and the source can't just be named `index.html` itself, because that
 * name is the real app's entry.
 *
 * Renamed on disk in `closeBundle`, not by rewriting the emitted asset in `generateBundle`: the
 * html plugin that turns `index.demo.html` into a built asset emits it during its own
 * `generateBundle`, which runs after a plugin earlier in the array has already finished its -
 * `bundle['index.demo.html']` is not there yet to rename. `closeBundle` runs once every plugin,
 * this build's own html plugin included, has finished writing files to `dist-demo/`.
 */
function demoEntryFilename(): Plugin {
  return {
    name: 'haelan-demo-entry-filename',
    closeBundle() {
      const outDir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'dist-demo')
      const from = join(outDir, 'index.demo.html')
      const to = join(outDir, 'index.html')
      if (existsSync(from)) renameSync(from, to)
    },
  }
}

export default defineConfig({
  plugins: [react(), demoTransport(), demoEntryFilename(), demoFixtures()],
  // The prefix the demo is served under. One variable, so a custom domain later is a one-line
  // change: the site publishes the demo at <base>/demo/.
  base: process.env.DEMO_BASE ?? '/haelan/demo/',
  build: { outDir: 'dist-demo', emptyOutDir: true, rollupOptions: { input: 'index.demo.html' } },
})
