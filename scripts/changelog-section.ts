// Pulls one version's section out of CHANGELOG.md, for the release workflow to use as the
// GitHub Release body. A function rather than an inline shell pipeline, so the one thing that can
// go wrong silently -- an empty body, a heading swallowed by the next one, "1.0.0" matching
// "1.0.10" -- is covered by a test instead of only being noticed once a wrong release went out.
//
// Usage: node --experimental-strip-types scripts/changelog-section.ts <section-name> [changelog-path]
// Prints the section body to stdout and exits 0, or prints why it could not to stderr and exits 1.
// <section-name> is the exact bracket contents to look for: "1.0.0" or "Unreleased".

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/**
 * Returns the body of the `## [section]` heading in `changelog`, trimmed, or `null` if that
 * heading does not exist or its body is empty.
 *
 * `section` is matched as the literal bracket contents, closing bracket included, so "1.0.0"
 * matches only a heading whose bracket is exactly "[1.0.0]" -- never "[1.0.10]", whose bracket
 * text diverges at the character after "1.0.1", and never "[1.0.0-rc.1]", whose bracket does not
 * close where "1.0.0" ends. A prefix match on the version alone (no closing bracket) would get
 * both wrong.
 */
export function extractSection(changelog: string, section: string): string | null {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n')
  const heading = `## [${section}]`
  const startIndex = lines.findIndex((line) => line.startsWith(heading))
  if (startIndex === -1) return null

  const bodyLines: string[] = []
  for (let i = startIndex + 1; i < lines.length; i++) {
    // The next `## ` heading (any version, or "Unreleased") ends this section. A deeper
    // heading, `###` and up, is part of the body -- that is how Added/Changed/Fixed are marked.
    if (lines[i].startsWith('## ')) break
    bodyLines.push(lines[i])
  }

  const body = bodyLines.join('\n').trim()
  return body.length > 0 ? body : null
}

async function main() {
  const [, , section, changelogPath = 'CHANGELOG.md'] = process.argv
  if (!section) {
    console.error('Usage: changelog-section.ts <section-name> [changelog-path]')
    process.exitCode = 1
    return
  }

  const changelog = await readFile(changelogPath, 'utf8')
  const body = extractSection(changelog, section)
  if (body === null) {
    console.error(
      `No "## [${section}]" section with content found in ${changelogPath}. ` +
        'Add one before tagging a release -- see CONTRIBUTING.md.',
    )
    process.exitCode = 1
    return
  }

  process.stdout.write(body + '\n')
}

// Runs main() only when invoked directly (`node changelog-section.ts ...`), not when the test
// suite imports extractSection from this same file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
