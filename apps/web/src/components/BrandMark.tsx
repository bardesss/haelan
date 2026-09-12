/**
 * The instance's own mark: an H whose crossbar is a pulse.
 *
 * Inline and stroked in currentColor for the same reason icons.tsx is — nothing is fetched at
 * runtime, and one definition serves the rail, the sign-in card and the setup column, each
 * painting it from its own theme. The first cut of this shipped two 1024px rasters with the
 * background baked in, which is a thing that can only ever sit on the one surface it was drawn
 * on; this can sit on any of them, and follows the in-app theme toggle that a
 * prefers-color-scheme asset cannot see.
 *
 * strokeWidth 2 against Icon's 1.7 on purpose: the brand reads a half step heavier than the nav
 * items underneath it in the rail, rather than as a tenth entry in the list.
 *
 * Geometry belongs to scripts/render-icons.mjs, which renders the raster icons from the same two
 * shapes. It is written out again here, and in public/favicon.svg and assets/brand/mark.svg,
 * because none of the three can read that script at runtime; brand-mark.test.tsx pins all four
 * together so they cannot drift.
 */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4v16M19 4v16" />
      <path d="M5 12h3.9l.9 1.5 1.4-6.2 1.8 8.6 1-3.9H19" />
    </svg>
  )
}
