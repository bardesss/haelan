import { MAPPING_VERSION } from '../api/version.ts'
import { DERIVATION_VERSION } from '../derive/version.ts'
import type { PersonRow } from '../store/people.ts'

export interface RebuildNeed {
  personId: string
  /** Why, in the operator's words. Empty is impossible: a need with no reason is not a need. */
  reasons: string[]
}

/**
 * Who needs rebuilding, and why.
 *
 * A version that moved in either direction counts. Rolling a constant back is how somebody
 * reverts a mapping change they regret, and the rows written under the newer number are exactly
 * as wrong for the older code as the reverse.
 */
export function peopleNeedingRebuild(rows: readonly PersonRow[]): RebuildNeed[] {
  const need: RebuildNeed[] = []
  for (const row of rows) {
    const reasons: string[] = []
    if (row.builtMappingVersion !== MAPPING_VERSION) {
      reasons.push(`mapping version ${row.builtMappingVersion ?? 'unrecorded'}, now ${MAPPING_VERSION}`)
    }
    if (row.builtDerivationVersion !== DERIVATION_VERSION) {
      reasons.push(`derivation version ${row.builtDerivationVersion ?? 'unrecorded'}, now ${DERIVATION_VERSION}`)
    }
    if (reasons.length > 0) need.push({ personId: row.id, reasons })
  }
  return need
}
