import { useState } from 'react'
import type { FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '../../i18n/index.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import {
  instanceUrlKey, redirectUriPreview, useInstanceUrl, useSaveInstanceUrl,
} from '../../data/useInstanceUrl.js'

/**
 * Where a household moves this instance to a new address: behind a reverse proxy, onto a homelab
 * hostname, off a laptop.
 *
 * The warning below the redirect field is the point of the whole section, not decoration on it. A
 * changed address does not stop syncing -- the refresh grant sends no redirect_uri -- so somebody
 * who saves here without registering the new redirect first sees nothing wrong for months, and
 * then finds every consent broken on the day they add a member or reconnect a revoked account.
 * There is no failure in between to warn them, which is why the warning has to be here, before
 * the button, rather than in a result line after it.
 *
 * Admin only, mounted the way Members.tsx and Maintenance.tsx are: Settings.tsx's own guard on
 * session.data?.isAdmin, which is also who the PUT accepts -- everyone else already gets
 * 'forbidden' from the server regardless of what renders here.
 */
export function InstanceUrl() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const query = useInstanceUrl()
  const save = useSaveInstanceUrl()
  // Null until the reader types, so the field follows the server's value through a save and an
  // invalidation without a second effect to push it back; a draft of '' is a field deliberately
  // cleared and must not read as untouched.
  const [draft, setDraft] = useState<string | null>(null)

  if (query.isPending) return <Loading />
  if (query.isError) {
    return (
      <ErrorState onRetry={() => {
        void queryClient.refetchQueries({ queryKey: instanceUrlKey(), exact: true })
      }} />
    )
  }

  const current = query.data
  const value = draft ?? current.baseUrl
  const preview = redirectUriPreview(value)
  // Compared on the redirect rather than on the address, because that is the string that has to be
  // registered: a trailing slash typed back in changes the field and nothing a reader must act on.
  const wouldChange = preview !== '' && preview !== current.redirectUri

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    save.mutate({ baseUrl: value }, { onSuccess: () => setDraft(null) })
  }

  return (
    <div className="instance-url">
      <div className="copy-field">
        <span className="label">{t('settings.instanceUrl.current')}</span>
        <code className="copy-value">{current.baseUrl}</code>
      </div>
      {/* Said plainly and first, because the reverse is what a household assumes: the reason this
          screen is easy to get wrong is that getting it wrong looks exactly like getting it
          right. */}
      <p className="field-hint">{t('settings.instanceUrl.syncUnaffected')}</p>

      <form onSubmit={submit}>
        <label className="field">
          <span className="label">{t('settings.instanceUrl.newLabel')}</span>
          <input
            className="input" value={value} required inputMode="url"
            placeholder={t('settings.instanceUrl.placeholder')}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <span className="field-hint">{t('settings.instanceUrl.newHint')}</span>
        </label>

        <div className="copy-field">
          <span className="label">{t('settings.instanceUrl.redirectLabel')}</span>
          <code className="copy-value">{preview}</code>
          <button
            type="button" className="button" disabled={preview === ''}
            onClick={() => { void navigator.clipboard.writeText(preview) }}
          >
            {t('settings.instanceUrl.copy')}
          </button>
        </div>

        {/* role="alert" rather than a quiet paragraph: this is the one instruction on the panel
            whose cost is paid months later by somebody who never read it. */}
        <p className="instance-url-warning" role="alert">
          {t('settings.instanceUrl.registerFirst')}
        </p>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={save.isPending || !wouldChange}>
            {save.isPending ? t('settings.instanceUrl.saving') : t('settings.instanceUrl.save')}
          </button>
        </div>
      </form>

      {/* The server's own message, not a sentence of this panel's: a rejected address comes back
          with the Google rule that rules it out (redirectUri.ts quotes three of them), and
          replacing that with "that did not work" would throw away the only thing telling the
          reader what to type instead. */}
      {save.isError && (
        <p className="field-error" role="alert">
          {t('settings.instanceUrl.failed', { reason: save.error.message })}
        </p>
      )}
      {save.isSuccess && !save.isPending && (
        <p className="instance-url-result" role="status">
          {t('settings.instanceUrl.saved', { url: save.data.baseUrl })}
        </p>
      )}
    </div>
  )
}
