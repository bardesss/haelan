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

// A Windows checkout may hand these over with CRLF, which the line-anchored patterns below miss.
const ct = read('../../proxmox/ct/haelan.sh').replace(/\r\n/g, '\n')
const install = read('../../proxmox/install/haelan-install.sh').replace(/\r\n/g, '\n')
const json = JSON.parse(read('../../proxmox/json/haelan.json'))
const pkg = JSON.parse(read('../../package.json'))
const dockerfile = read('../../Dockerfile')
const readme = read('../../README.md')

// The same call the server makes at boot with an empty environment, so these are the defaults a
// container actually gets rather than the defaults someone remembered.
const defaults = readConfig({})

// Every update swaps this directory out for a freshly built one and deletes the old copy.
const DEPLOY_DIR = '/opt/haelan'

const updateBody = ct.slice(ct.indexOf('function update_script()'), ct.indexOf('\n}\n', ct.indexOf('function update_script()')))
const before = (body: string, a: string, b: string) => {
  expect(body.indexOf(a), `${a} is missing`).toBeGreaterThan(-1)
  expect(body.indexOf(b), `${b} is missing`).toBeGreaterThan(-1)
  expect(body.indexOf(a), `${a} must come before ${b}`).toBeLessThan(body.indexOf(b))
}

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
  it('runs the service as its own system user with a private data directory', () => {
    expect(install).not.toMatch(/^User=root$/m)
    expect(install).toMatch(/^User=haelan$/m)
    expect(install).toMatch(/^Group=haelan$/m)
    expect(install).toMatch(/^UMask=0077$/m)
    expect(install).toContain('useradd --system --no-create-home --home-dir /opt/haelan_data --shell /usr/sbin/nologin haelan')
    expect(install).toContain('install -d -m 700 -o haelan -g haelan /opt/haelan_data')
    before(install, 'install -d -m 700 -o haelan -g haelan /opt/haelan_data', 'systemctl enable -q --now haelan')
  })

  it('moves a container installed as root onto that user when it updates', () => {
    for (const step of [
      'useradd --system --no-create-home --home-dir /opt/haelan_data --shell /usr/sbin/nologin haelan',
      'chown -R haelan:haelan /opt/haelan_data',
      'chmod 700 /opt/haelan_data',
      'User=haelan',
      'systemctl daemon-reload',
    ]) before(updateBody, step, 'systemctl start haelan')
  })

  it('builds an update beside the running tree and swaps only once it built', () => {
    expect(updateBody).toContain('CLEAN_INSTALL=1 fetch_and_deploy_gh_release "haelan" "bardesss/haelan" "tarball" "latest" "/opt/haelan.staging"')
    expect(updateBody).not.toMatch(/fetch_and_deploy_gh_release "haelan" "bardesss\/haelan" "tarball"\s*$/m)
    before(updateBody, 'cd /opt/haelan.staging', '$STD pnpm build')
    before(updateBody, '$STD pnpm build', 'systemctl stop haelan')
    before(updateBody, 'systemctl stop haelan', 'mv /opt/haelan /opt/haelan.previous')
    before(updateBody, 'mv /opt/haelan /opt/haelan.previous', 'mv /opt/haelan.staging /opt/haelan')
    before(updateBody, `http://127.0.0.1:${defaults.port}/api/setup/state`, 'mv /opt/haelan.previous /opt/haelan')
  })

  it('fetches the engine and its own scripts from pinned refs', () => {
    expect(ct).toMatch(/^COMMUNITY_SCRIPTS_CORE_URL="\$\{COMMUNITY_SCRIPTS_CORE_URL:-https:\/\/raw\.githubusercontent\.com\/community-scripts\/core\/[0-9a-f]{40}\}"$/m)
    expect(ct).toContain(`COMMUNITY_SCRIPTS_URL="\${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/bardesss/haelan/v${pkg.version}/proxmox}" # x-release-please-version`)
    expect(ct).toMatch(/^export COMMUNITY_SCRIPTS_CORE_URL COMMUNITY_SCRIPTS_URL$/m)
    expect(ct).not.toContain('community-scripts/core/main')
    expect(readme).toContain(`https://raw.githubusercontent.com/bardesss/haelan/v${pkg.version}/proxmox/ct/haelan.sh`)
    expect(readme).not.toContain('bardesss/haelan/master/proxmox')
    const config = JSON.parse(read('../../release-please-config.json'))
    expect(config.packages['.']['extra-files']).toEqual(expect.arrayContaining(['README.md', 'proxmox/ct/haelan.sh']))
  })
})
