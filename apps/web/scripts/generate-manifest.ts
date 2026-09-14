// Decides manifest.webmanifest's content from the same design tokens index.html's two
// theme-color metas are hand-copied from, so a token change updates every place the colour
// appears instead of drifting the third time somebody has to type it out. renderManifest() is
// the single function that decides the manifest's content; test/manifest.test.ts calls it and
// fails the suite when the checked-in file disagrees, the same device tools-doc-drift.test.ts
// already uses for TOOLS.md. write-manifest.ts is the only thing that writes the checked-in file
// - a pure module here, deliberately, so a test can import renderManifest without that import
// itself rewriting the file it is about to compare against.
//
// Run `pnpm --filter @haelan/web manifest` to write it.
//
// This needs @haelan/tokens, a workspace package whose own source imports itself by `.js`
// specifiers that only resolve to their sibling `.ts` files under a bundler-aware loader (Vite's,
// here) - plain node's type stripping erases type syntax but does not rewrite extensions, so it
// cannot follow that import at all. That is why write-manifest.ts runs through vite-node rather
// than bare node, unlike render-icons.mjs, which needs no package and stays dependency-free
// instead. See packages/tokens/scripts/build-css.ts for the same vite-node device solving the
// identical problem for that package's own build step.
import { resolveSemantic } from '@haelan/tokens'

// The app's declared fallback theme: index.html's own comment says dark is what a browser gets
// with no data-theme forced, and app.css's unconditional rule paints the dark palette, with light
// applied only inside `@media (prefers-color-scheme: light)`. A web app manifest has exactly one
// theme_color and one background_color - there is no media feature for either - so both take the
// value the app itself falls back to rather than whichever theme happens to be on screen when the
// icon is tapped.
const FALLBACK_THEME = 'dark'

export function renderManifest(): string {
  const themeColor = resolveSemantic(FALLBACK_THEME)['surface-page']
  const manifest = {
    name: 'Hælan',
    short_name: 'Hælan',
    description: 'A self-hosted dashboard and local mirror for your own health data, built on '
      + 'the Google Health API v4. One household, one instance, no telemetry.',
    // Relative, not "/": this file ships unmodified from public/ under whatever base the build
    // gives it - "/" for a real instance (apps/web/vite.config.ts sets no base), "/haelan/demo/"
    // for the published demo (vite.demo.config.ts's DEMO_BASE). Both start_url and scope resolve
    // against the manifest's own URL rather than the document's, so "." always lands back on
    // whichever of those actually served this file - an absolute "/" here would send an installed
    // demo's icon back to the site root instead of the demo it was installed from.
    start_url: '.',
    scope: '.',
    // No service worker: this app cannot do anything useful without its server, so an offline
    // promise would be a lie and a cache of stale health data is a hazard. Installability earns
    // its place by reclaiming the browser chrome a phone viewport otherwise loses to it.
    display: 'standalone',
    theme_color: themeColor,
    background_color: themeColor,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // See render-icons.mjs's scaleForSafeZone for why this is a genuinely different render
      // rather than icon-512.png with a different `purpose` string.
      { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}
