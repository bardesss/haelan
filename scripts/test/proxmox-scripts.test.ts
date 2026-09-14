import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { readConfig } from '../../apps/server/src/config.js'

// The Community Scripts installer is three files that restate things the rest of the repository
// already decides: the port the server binds, the Node major the image runs, the pnpm version the
// workspace pins. Nothing imports them, no CI job runs them, and they live one `git mv` away from
// the code they describe, so every one of those restatements is free to rot silently. A tester on
// a Proxmox host is the only thing that would notice, and by then the number is already published
// in a catalogue.
//
// So this asserts the restatements against their sources rather than against themselves. It does
// not - and cannot - say the scripts work: that needs a real PVE host.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const ct = read('../../proxmox/ct/haelan.sh')
const install = read('../../proxmox/install/haelan-install.sh')
const json = JSON.parse(read('../../proxmox/json/haelan.json'))
const pkg = JSON.parse(read('../../package.json'))
const dockerfile = read('../../Dockerfile')
const readme = read('../../README.md')

// The same call the server makes at boot with an empty environment, so these are the defaults a
// container actually gets rather than the defaults someone remembered.
const defaults = readConfig({})

// CLEAN_INSTALL=1 fetch_and_deploy_gh_release wipes this directory on every update.
const DEPLOY_DIR = '/opt/haelan'

const nodeMajorIn = (script: string) => /NODE_VERSION="(\d+)"/.exec(script)?.[1]
const pnpmFallbackIn = (script: string) => /pnpm@\$\{PNPM_VERSION:-([\d.]+)\}/.exec(script)?.[1]

describe('the Proxmox LXC installer', () => {
  // Without this every assertion below would pass just as happily against an empty string, which
  // is what a renamed directory would hand it.
  it.each([
    ['ct/haelan.sh', ct],
    ['install/haelan-install.sh', install],
  ])('has %s to read, so the assertions below are not passing over nothing', (_name, script) => {
    expect(script).toContain('haelan')
    expect(script.split('\n').length).toBeGreaterThan(20)
  })

  it('sends people to the port the server actually binds', () => {
    // Two copies of the port: the line the install prints on the host, and the field the public
    // catalogue renders. HAELAN_PORT is not set anywhere in the container, so both are only ever
    // right by agreeing with the default.
    expect(ct).toContain(`http://\${IP}:${defaults.port}`)
    expect(json.interface_port).toBe(defaults.port)
  })

  it('keeps the data directory out of the tree an update deletes', () => {
    const dataDir = /Environment=HAELAN_DATA_DIR=(\S+)/.exec(install)?.[1]

    expect(dataDir).toBeDefined()
    // The trailing slash is the whole point. /opt/haelan-data starts with /opt/haelan, so the
    // obvious form of this check passes on a path that is fine and would keep passing on
    // /opt/haelan/data, which is a database deleted on the first update.
    expect(dataDir).not.toBe(DEPLOY_DIR)
    expect(dataDir?.startsWith(`${DEPLOY_DIR}/`)).toBe(false)
  })

  it('installs the Node major the shipped image runs', () => {
    // engines is a floor and the Dockerfile is the verified runtime, so the floor is the weaker
    // claim of the two. The container gets what the image gets.
    //
    // The tag suffix is matched loosely on purpose. What the container has to agree with is the
    // Node major, not the base distribution: the image moved from -slim to -alpine and the LXC
    // stays Debian, which is fine, while a silent disagreement about the major is not. Pinning
    // the suffix here meant this read `undefined` the moment the base changed, and `undefined`
    // is what the assertion below exists to catch.
    const image = /^FROM node:(\d+)-[a-z0-9.]+/m.exec(dockerfile)?.[1]
    const floor = Number(/(\d+)/.exec(pkg.engines.node)?.[1])

    expect(image).toBeDefined()
    expect(nodeMajorIn(install)).toBe(image)
    expect(nodeMajorIn(ct)).toBe(image)
    expect(Number(image)).toBeGreaterThanOrEqual(floor)
  })

  it('falls back to the pnpm version the workspace pins', () => {
    // Both scripts read packageManager out of the deployed tree first, so the literal only runs
    // when that sed finds nothing. That is exactly when it matters and exactly when nobody looks.
    const pinned = /^pnpm@([\d.]+)/.exec(pkg.packageManager)?.[1]

    expect(pinned).toBeDefined()
    expect(pnpmFallbackIn(install)).toBe(pinned)
    expect(pnpmFallbackIn(ct)).toBe(pinned)
  })

  it('declares the resources the container script asks for', () => {
    // The catalogue page and the script are two answers to the same question, and the person
    // sizing a node reads the one that is not executed.
    const varIn = (name: string) =>
      new RegExp(`^${name}="\\$\\{${name}:-([^}]+)\\}"`, 'm').exec(ct)?.[1]
    const { resources } = json.install_methods[0]

    expect(String(resources.cpu)).toBe(varIn('var_cpu'))
    expect(String(resources.ram)).toBe(varIn('var_ram'))
    expect(String(resources.hdd)).toBe(varIn('var_disk'))
    expect(String(resources.version)).toBe(varIn('var_version'))
    expect(resources.os.toLowerCase()).toBe(varIn('var_os'))
  })

  it('does not claim an architecture nobody has run it on', () => {
    // Upstream's rule: var_arm64 unset means never tried, and the JSON field has to be absent to
    // match. Present-but-amd64-only reads on their site as "known broken", which is a different
    // and stronger claim than the truth.
    const declared = /^var_arm64=/m.test(ct)

    expect(declared).toBe(false)
    expect(json.architectures).toBeUndefined()
  })

  it('sends testers to the same place the README does', () => {
    // Every container the script builds repeats this URL - on each login, in its Proxmox
    // description and on the last line of the install - so a stale one is repeated at the person
    // best placed to report the thing it is asking about. Two copies, one issue.
    const testurl = /^var_testurl="\$\{var_testurl:-(\S+)\}"/m.exec(ct)?.[1]

    expect(testurl).toMatch(/^https:\/\//)
    expect(readme).toContain(testurl)
  })

  it('promises an update path the container script implements', () => {
    expect(json.updateable).toBe(true)
    expect(ct).toContain('function update_script()')
    expect(ct).toContain('check_for_gh_release "haelan" "bardesss/haelan"')
  })
})
