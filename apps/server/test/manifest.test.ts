import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { withServer } from './harness.ts'

// The real, checked-in public/ directory rather than a synthetic copy: the point of this test is
// that the files this repository actually ships resolve, not that some fixture the test invented
// does. index.html need not be there for this - static.ts's not-found fallback is the only thing
// that reads it, and nothing here exercises a missing route.
const WEB_PUBLIC = fileURLToPath(new URL('../../web/public', import.meta.url))

describe('the manifest and the icons it names', () => {
  it('is served as application/manifest+json, and every icon it names actually resolves', async () => {
    const harness = await withServer({ webRoot: WEB_PUBLIC })

    const manifestResponse = await harness.app.inject({ method: 'GET', url: '/manifest.webmanifest' })
    expect(manifestResponse.statusCode).toBe(200)
    // Not toContain: a manifest served as text/plain or application/json still opens in a
    // browser's network tab and still parses as JSON, so a content-type regression here would
    // pass every check that only looks at the body.
    expect(manifestResponse.headers['content-type']).toBe('application/manifest+json')

    const manifest = JSON.parse(manifestResponse.body) as { icons: { src: string, type: string }[] }
    expect(manifest.icons.length).toBeGreaterThan(0)

    for (const icon of manifest.icons) {
      const response = await harness.app.inject({ method: 'GET', url: `/${icon.src}` })
      expect(response.statusCode, `${icon.src} should resolve`).toBe(200)
      expect(response.headers['content-type'], `${icon.src}'s content type`).toBe(icon.type)
    }

    await harness.cleanup()
  })

  // The failure mode this whole task exists to catch: a manifest naming a file that is not
  // actually there installs an app with a broken icon and nothing says so. Proven here by
  // asserting the negative directly, not merely trusting the positive loop above - if every icon
  // in the manifest happened to be renamed at once, that loop would still pass by iterating over
  // nothing meaningful.
  it('would fail this same check if an icon file were missing', async () => {
    const harness = await withServer({ webRoot: WEB_PUBLIC })
    const response = await harness.app.inject({ method: 'GET', url: '/icon-does-not-exist.png' })
    expect(response.statusCode).toBe(404)
    await harness.cleanup()
  })
})
