import { useTranslation } from '../i18n/index.js'
import type { DataTypeChoice } from '../data/useDataTypes.js'

/**
 * One checkbox per catalogue type the sync engine can fetch, checked when the type is being
 * synced for this person.
 *
 * The route this reads from (and writes back to) keeps exclusions, not inclusions --
 * ExcludedDataTypeStore's own vocabulary, so a catalogue type added later syncs for everyone by
 * default rather than needing every person's row updated to include it. A reader of this control
 * thinks the other way around ("is my step count being synced"), so the excluded-to-checked flip
 * happens exactly once, here: Settings wires this component to the mutation without knowing the
 * inversion exists, and the wizard (Task 7) gets the same guarantee by reusing this component
 * rather than building its own checkbox list against the same route.
 */
export function DataTypePicker({ items, onChange, disabled }: {
  items: DataTypeChoice[]
  onChange: (excluded: string[]) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const allOff = items.length > 0 && items.every((item) => item.excluded)

  const toggle = (id: string, checked: boolean): void => {
    const excluded = items
      .filter((item) => (item.id === id ? !checked : item.excluded))
      .map((item) => item.id)
    onChange(excluded)
  }

  return (
    <div className="data-type-picker">
      {allOff && <p className="field-hint">{t('settings.dataTypes.allOff')}</p>}
      <ul className="data-type-list">
        {items.map((item) => (
          <li key={item.id} className="data-type-row">
            <label>
              <input
                type="checkbox"
                checked={!item.excluded}
                disabled={disabled}
                onChange={(e) => toggle(item.id, e.currentTarget.checked)}
              />
              <span className="data-type-label">{item.id}</span>
            </label>
            <span className="data-type-tier">{item.tier}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
