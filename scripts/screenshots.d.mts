// A declaration shim for screenshots.mjs, read by the tests in scripts/test that import it.
// TypeScript resolves a `.mjs` import against a same-named `.d.mts` beside it without needing
// `allowJs` anywhere in the program. Keep it in sync with what screenshots.mjs exports.
export interface Screenshot {
  file: string
  title: string
  alt: string
  role: 'hero' | 'gallery'
  readme: 'inline' | 'link'
}
export const SCREENSHOTS: readonly Screenshot[]
export function heroShot(): Screenshot
export function galleryShots(): Screenshot[]
