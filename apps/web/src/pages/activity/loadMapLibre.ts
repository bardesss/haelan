/**
 * MapLibre, with its web worker pointed at a file the build actually emitted.
 *
 * MapLibre 6 finds its worker by building `new URL('./maplibre-gl-worker.mjs', import.meta.url)`
 * from strings at runtime, which no bundler can see. Vite never emitted the worker, the browser got
 * a 404 for it, and every map drew its raster tiles - which load on the main thread - and nothing
 * that needs the worker. A GeoJSON source is parsed and tiled only in the worker, so the route line
 * never appeared, on a map that otherwise looked finished.
 *
 * `?worker&url` has Vite bundle the worker as its own entry, together with the shared chunk it
 * imports, and answer that entry's URL; setWorkerUrl has to hear it before the first Map is built.
 * vite.config.ts sets `worker.format: 'es'` because MapLibre starts the worker as a module worker
 * for any URL not ending in `.cjs`.
 *
 * Both imports are dynamic for the reason WorkoutRoute.tsx gives at its effect: a household that
 * never turns the basemap on never downloads either.
 */
export async function loadMapLibre(): Promise<typeof import('maplibre-gl')> {
  const [maplibre, worker] = await Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
  ])
  maplibre.setWorkerUrl(worker.default)
  return maplibre
}
