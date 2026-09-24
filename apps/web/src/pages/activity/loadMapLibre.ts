/**
 * MapLibre, with its web worker pointed at a file the build actually emitted.
 *
 * MapLibre 6 finds its worker by building `new URL('./maplibre-gl-worker.mjs', import.meta.url)`
 * from strings at runtime, which no bundler can see. Vite never emitted the worker, the browser got
 * a 404 for it, and every map drew its raster tiles - which load on the main thread - and nothing
 * that needs the worker. A GeoJSON source is parsed and tiled only in the worker, so the route line
 * never appeared, on a map that otherwise looked finished. The basemap is vector tiles now, which
 * are decoded in the worker as well, so without it the map would draw nothing at all.
 *
 * `?worker&url` has Vite bundle the worker as its own entry, together with the shared chunk it
 * imports, and answer that entry's URL; setWorkerUrl has to hear it before the first Map is built.
 * vite.config.ts sets `worker.format: 'es'` because MapLibre starts the worker as a module worker
 * for any URL not ending in `.cjs`.
 *
 * The stylesheet rides along for the attribution line. MapLibre positions and lays out its
 * controls with its own CSS and ships none inline, so without it OpenFreeMap's credit would render
 * as bare unpositioned links rather than a line in the map's corner; app.css then recolours it in the page's tokens.
 *
 * All three imports are dynamic for the reason WorkoutRoute.tsx gives at its effect: a household
 * that never turns the basemap on never downloads any of them.
 */
export async function loadMapLibre(): Promise<typeof import('maplibre-gl')> {
  const [maplibre, worker] = await Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
    import('maplibre-gl/dist/maplibre-gl.css'),
  ])
  maplibre.setWorkerUrl(worker.default)
  return maplibre
}
