import { describe, it, expect } from 'vitest'
import { renderPage } from '../build-site.mjs'

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

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseStamp } from '../build-site.mjs'

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
})
