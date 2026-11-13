import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { healthcheckUrl } from '../src/healthcheck.ts'

describe('healthcheckUrl', () => {
  it.each([
    [{ port: 4235, host: '0.0.0.0' }, 'http://127.0.0.1:4235/api/setup/state'],
    [{ port: 8080, host: '0.0.0.0' }, 'http://127.0.0.1:8080/api/setup/state'],
    [{ port: 4235, host: '192.168.1.20' }, 'http://192.168.1.20:4235/api/setup/state'],
    [{ port: 4235, host: '::' }, 'http://[::1]:4235/api/setup/state'],
    [{ port: 4235, host: 'fd00::5' }, 'http://[fd00::5]:4235/api/setup/state'],
  ])('%o probes %s', (config, url) => {
    expect(healthcheckUrl(config)).toBe(url)
  })
})

describe('the image healthcheck', () => {
  it('runs the script that reads the configured address', () => {
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const cmd = /^HEALTHCHECK [^\n]*\\\n\s+CMD (.+)$/m.exec(dockerfile)?.[1]
    expect(cmd).toBe('["node", "apps/server/src/healthcheck.ts"]')
  })
})
