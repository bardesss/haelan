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
