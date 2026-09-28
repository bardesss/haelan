import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPage, releaseStamp, galleryHtml, lightboxHtml, pngSize } from '../build-site.mjs'

describe('screenshot sizes', () => {
  const dir = fileURLToPath(new URL('../../assets/screenshots', import.meta.url))
  const sizes = (html: string) => new Map(
    [...html.matchAll(/src="screenshots\/([^"]+)"[^>]*width="(\d+)" height="(\d+)"/g)]
      .map(([, file, width, height]) => [file!, { width: Number(width), height: Number(height) }]),
  )

  it('reads a PNG header\'s width and height', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'haelan-png-'))
    try {
      const head = Buffer.alloc(24)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
      head.writeUInt32BE(13, 8)
      head.write('IHDR', 12, 'latin1')
      head.writeUInt32BE(1080, 16)
      head.writeUInt32BE(2400, 20)
      writeFileSync(join(tmp, 'phone.png'), head)
      expect(pngSize(join(tmp, 'phone.png'))).toEqual({ width: 1080, height: 2400 })
      writeFileSync(join(tmp, 'not.png'), 'GIF89a and then some more bytes')
      expect(() => pngSize(join(tmp, 'not.png'))).toThrow('not a PNG')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  // The phone composite is portrait; sized as 1440x900 like the rest, it reserved a landscape box.
  it('gives every gallery and full-size image its own file\'s size, the phone composite included', () => {
    for (const html of [galleryHtml(dir), lightboxHtml(dir)]) {
      const found = sizes(html)
      expect(found.get('android-glance.png')).toEqual(pngSize(join(dir, 'android-glance.png')))
      for (const [file, size] of found) expect(size).toEqual(pngSize(join(dir, file)))
    }
    const phone = pngSize(join(dir, 'android-glance.png'))
    expect(phone.height).toBeGreaterThan(phone.width)
  })
})

describe('renderPage', () => {
  it('substitutes every slot it is given a value for', () => {
    const out = renderPage('<p>haelan {{version}}, released {{releaseDate}}</p>', {
      version: '1.16.0',
      releaseDate: '2026-09-13',
    })
    expect(out).toBe('<p>haelan 1.16.0, released 2026-09-13</p>')
  })

  it('substitutes a slot used more than once', () => {
    expect(renderPage('{{version}}/{{version}}', { version: '1.16.0' })).toBe('1.16.0/1.16.0')
  })

  it('throws when the template has a slot nothing fills', () => {
    expect(() => renderPage('<p>{{version}} {{unknown}}</p>', { version: '1.16.0' }))
      .toThrow('no value for {{unknown}}')
  })

  it('throws when a value fills no slot', () => {
    expect(() => renderPage('<p>{{version}}</p>', { version: '1.16.0', stale: 'x' }))
      .toThrow('nothing uses: stale')
  })
})

describe('releaseStamp', () => {
  function fixture(changelog: string, version = '1.16.0'): string {
    const dir = mkdtempSync(join(tmpdir(), 'haelan-site-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog)
    return dir
  }

  it('reads the version from package.json and its date from the changelog', () => {
    const dir = fixture([
      '# Changelog',
      '',
      '## [1.16.0](https://github.com/bardesss/haelan/compare/v1.15.3...v1.16.0) (2026-09-13)',
      '',
      '## [1.15.3](https://github.com/bardesss/haelan/compare/v1.15.2...v1.15.3) (2026-09-02)',
    ].join('\n'))
    try {
      expect(releaseStamp(dir)).toEqual({ version: '1.16.0', releaseDate: '2026-09-13' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to guess when the changelog has no entry for the version', () => {
    const dir = fixture('# Changelog\n\n## [1.15.3](x) (2026-09-02)\n')
    try {
      expect(() => releaseStamp(dir)).toThrow('no CHANGELOG.md entry for 1.16.0')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('handles semver build metadata with + by escaping regex metacharacters', () => {
    const dir = fixture([
      '# Changelog',
      '',
      '## [1.16.0+build.5](https://github.com/bardesss/haelan/compare/v1.15.3...v1.16.0) (2026-09-13)',
      '',
      '## [1.15.3](https://github.com/bardesss/haelan/compare/v1.15.2...v1.15.3) (2026-09-02)',
    ].join('\n'), '1.16.0+build.5')
    try {
      expect(releaseStamp(dir)).toEqual({ version: '1.16.0+build.5', releaseDate: '2026-09-13' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
