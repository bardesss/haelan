import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCapture } from '../capture-demo.mjs'

describe('writeCapture', () => {
  it('writes one file per response and a manifest keyed by canonical url', () => {
    const out = mkdtempSync(join(tmpdir(), 'haelan-capture-out-'))
    try {
      const report = writeCapture(out, new Map<string, unknown>([
        ['/api/v1/p/demo/data-types', { items: [] }],
        ['/api/v1/p/demo/series?agg=sum&metric=steps', { series: { steps: { points: [] } } }],
      ]))

      const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Record<string, string>
      expect(Object.keys(manifest).sort()).toEqual([
        '/api/v1/p/demo/data-types',
        '/api/v1/p/demo/series?agg=sum&metric=steps',
      ])

      // Every manifest value names a file that exists and parses.
      for (const file of Object.values(manifest)) {
        expect(JSON.parse(readFileSync(join(out, file), 'utf8'))).toBeTypeOf('object')
      }

      expect(report.files).toBe(2)
      expect(report.bytes).toBeGreaterThan(0)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('refuses to write an empty capture', () => {
    const out = mkdtempSync(join(tmpdir(), 'haelan-capture-out-'))
    try {
      // A sweep that recorded nothing is a broken sweep, and writing its manifest would publish
      // a demo where every page answers "not in the demo".
      expect(() => writeCapture(out, new Map())).toThrow('recorded nothing')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('names files without letting a url become a path', () => {
    const out = mkdtempSync(join(tmpdir(), 'haelan-capture-out-'))
    try {
      const report = writeCapture(out, new Map([['/api/v1/p/demo/sleep/nights?range=week', { items: [] }]]))
      expect(report.files).toBe(1)
      // A slash in the key must not create a directory, and two different urls must not collide.
      const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Record<string, string>
      expect(Object.values(manifest)[0]).not.toContain('/')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
