import { useState } from 'react'
import { useTranslation } from '../i18n/index.js'

/**
 * `value` is always a complete URI. There is no template, no interpolation at render time and
 * nothing for the owner to fill in, which is the whole point of the component: a value the
 * console would reject is never offered here, it is shown as rejected somewhere else.
 */
export function CopyField({ value, label }: { value: string, label: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-field">
      <span className="label">{label}</span>
      <code className="copy-value">{value}</code>
      <button
        type="button"
        className="button"
        data-copy-for={value}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true))
        }}
      >
        {copied ? t('setup.copyField.copied') : t('setup.copyField.copy')}
      </button>
    </div>
  )
}
