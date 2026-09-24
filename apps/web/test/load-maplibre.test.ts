import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Stand-ins for the two dynamic imports loadMapLibre makes. The worker URL module is what Vite's
// `?worker&url` answers at build time: a default export naming the emitted worker file.
const setWorkerUrl = vi.fn()
vi.mock('maplibre-gl', () => ({ setWorkerUrl, Map: class {} }))
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/assets/maplibre-gl-worker-test.js' }))
// A plain flag rather than a vi.fn(): the factory runs once per file, and the suite clears mock
// calls between tests, so a spy would forget the load by the time a later test asked about it.
const imported = vi.hoisted(() => ({ stylesheet: false }))
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => {
  imported.stylesheet = true
  return {}
})

const { loadMapLibre } = await import('../src/pages/activity/loadMapLibre.js')

/**
 * MapLibre 6 builds its worker's URL from strings at runtime, which Vite cannot see, so the build
 * emitted no worker, the browser got a 404, and a workout's map drew its tiles and never its route:
 * GeoJSON is parsed only in the worker. loadMapLibre points MapLibre at the worker Vite does emit.
 */
describe('loadMapLibre', () => {
  it('hands MapLibre the worker the build emitted before anything can build a map', async () => {
    const maplibre = await loadMapLibre()
    expect(setWorkerUrl).toHaveBeenCalledExactlyOnceWith('/assets/maplibre-gl-worker-test.js')
    expect(typeof maplibre.Map).toBe('function')
  })

  // MapLibre lays out its attribution control with its own stylesheet and inlines none of it, so
  // a map built without it credits OpenFreeMap in bare, unpositioned links.
  it('brings MapLibre\'s own stylesheet with it', async () => {
    await loadMapLibre()
    expect(imported.stylesheet).toBe(true)
  })
})

const WEB_SRC = join(import.meta.dirname, '..', 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

/**
 * A second `import('maplibre-gl')` somewhere else would build its map before setWorkerUrl ran, or
 * without it, and bring the missing route back with every unit test still green. Type-only
 * imports are fine: they name no worker and vanish from the bundle.
 */
describe('the one way into MapLibre', () => {
  it('reaches maplibre-gl as a value only through loadMapLibre.ts', () => {
    const offenders = sourceFiles(WEB_SRC)
      .filter((path) => !path.endsWith('loadMapLibre.ts'))
      .filter((path) => {
        const text = readFileSync(path, 'utf8')
        return /import\(\s*['"]maplibre-gl['"]\s*\)/.test(text)
          || /^import\s+(?!type\b)[^'"]*from\s+['"]maplibre-gl['"]/m.test(text)
      })
      .map((path) => relative(WEB_SRC, path))
    expect(offenders).toEqual([])
  })

  // MapLibre starts the worker as a module worker for any URL not ending in .cjs, and Vite's
  // default worker format is an IIFE. Both configs build WorkoutRoute, so both have to agree.
  it.each(['vite.config.ts', 'vite.demo.config.ts'])('%s emits workers as ES modules', (config) => {
    const text = readFileSync(join(import.meta.dirname, '..', config), 'utf8')
    expect(text).toMatch(/worker:\s*\{\s*format:\s*'es'\s*\}/)
  })
})
