import { describe, it, expect } from 'vitest'
import { extractSection } from '../changelog-section.ts'

const CHANGELOG = `# Changelog

## [Unreleased]

- Something not yet released.

## [1.2.3]

### Added

- Middle section content.

## [1.2.0] - 2026-01-01

### Fixed

- First real release content.

## [1.0.0-rc.1] - 2025-12-01

- A pre-release entry, its own bracket.
`

describe('extractSection', () => {
  it('extracts a section from the middle of the file, stopping at the next heading', () => {
    expect(extractSection(CHANGELOG, '1.2.3')).toBe('### Added\n\n- Middle section content.')
  })

  it('extracts the first section in the file', () => {
    expect(extractSection(CHANGELOG, 'Unreleased')).toBe('- Something not yet released.')
  })

  it('extracts the last section in the file, where there is no next heading to stop at', () => {
    expect(extractSection(CHANGELOG, '1.0.0-rc.1')).toBe('- A pre-release entry, its own bracket.')
  })

  it('returns null for a version with no heading at all', () => {
    expect(extractSection(CHANGELOG, '9.9.9')).toBeNull()
  })

  it('does not let a version match another version it is a prefix of', () => {
    // "1.2.0" is a prefix of "1.2.0" -- but also a textual prefix of a heading like "1.2.0-rc.1"
    // or, the more common bug, "1.2.3" is a textual prefix of "1.2.30". Guard both directions:
    // asking for "1.2" must not match the "1.2.0" or "1.2.3" headings, and asking for "1.2.3"
    // must not match a "1.2.30" heading.
    expect(extractSection(CHANGELOG, '1.2')).toBeNull()

    const withLongerVersion = CHANGELOG.replace('## [1.2.3]', '## [1.2.30]')
    expect(extractSection(withLongerVersion, '1.2.3')).toBeNull()
    expect(extractSection(withLongerVersion, '1.2.30')).toBe('### Added\n\n- Middle section content.')
  })

  it('treats a heading with an empty body as missing', () => {
    const emptySection = '## [2.0.0]\n\n## [1.9.0]\n\nfilled in\n'
    expect(extractSection(emptySection, '2.0.0')).toBeNull()
  })

  it('treats a heading whose body is only whitespace as missing', () => {
    const blankSection = '## [2.0.0]\n   \n\n## [1.9.0]\n\nfilled in\n'
    expect(extractSection(blankSection, '2.0.0')).toBeNull()
  })

  it('does not match a pre-release tag against the release version it is built from', () => {
    // "1.0.0-rc.1" must not resolve when asking for "1.0.0": the workflow relies on this to
    // route pre-release tags to the Unreleased section instead of a same-numbered release section.
    expect(extractSection(CHANGELOG, '1.0.0')).toBeNull()
  })
})
