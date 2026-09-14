import { useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { useSession } from '../../auth/session.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { useMcpCalls, useMcpTokens, useCreateMcpToken, useRevokeMcpToken } from '../../data/useMcpTokens.js'
import type { McpCallRow, McpTokenRow, MintedToken } from '../../data/useMcpTokens.js'

// The same three the server accepts, and the same default. Two copies of a closed set, which the
// route's own 400 is the backstop for: a select offering a fourth would be refused rather than
// silently clamped.
const LIVES = [30, 90, 365] as const
const DEFAULT_LIFE = 90

/**
 * The tokens that let an agent on another machine read this account, and the calls they made.
 *
 * Not admin gated, like the Profile card above it and unlike everything below: this is the
 * reader's own credential. There is deliberately no path by which an admin could mint one for
 * somebody else - an admin resetting a member's password is loud, because the member's own
 * password stops working, and a token minted on their behalf would be the same access silently.
 *
 * The call list is the only part of this unit that detects an attack rather than preventing one,
 * and an audit trail nobody looks at detects nothing. That is why the last-used stamp sits on the
 * token's own row rather than buried in the list, and why the list is twenty rows rather than a
 * thousand.
 */
export function McpTokens() {
  const { t, i18n } = useTranslation()
  const session = useSession()
  const tokens = useMcpTokens()
  const calls = useMcpCalls()
  const create = useCreateMcpToken()
  const revoke = useRevokeMcpToken()

  // Settings.tsx's own useSession() call shares this query key, so by the time a reader has
  // minted a token this has almost always already resolved - but a fresh load racing the mint
  // is not impossible, and an instance whose address was never configured (setup incomplete, or
  // skipped) answers with '' rather than a value at all. Either way, a bare "/mcp" is worse than
  // silence: it reads as a real endpoint and is not one.
  const baseUrl = session.data?.baseUrl ?? ''
  const endpoint = baseUrl === '' ? '' : `${baseUrl}/mcp`

  const [label, setLabel] = useState('')
  const [days, setDays] = useState<number>(DEFAULT_LIFE)
  // Component state, never the query cache. A cached secret is one that reappears on a later
  // render of a screen the reader thought they had left, on a value the server will never send
  // again and cannot be asked for.
  const [justMinted, setJustMinted] = useState<MintedToken | null>(null)

  const when = (ms: number): string =>
    new Date(ms).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    create.mutate({ label, days }, {
      onSuccess: (minted) => { setJustMinted(minted); setLabel('') },
    })
  }

  if (tokens.isPending) return <Loading />
  if (tokens.isError || tokens.data === undefined) {
    return <ErrorState onRetry={() => { void tokens.refetch() }} error={tokens.error} />
  }

  const rows = tokens.data.tokens

  return (
    <div className="mcp-tokens">
      <p className="field-hint">{t('settings.mcp.intro')}</p>

      {justMinted !== null && (
        // role="alert" rather than a quiet caption: this is the one thing on the panel whose cost
        // is paid entirely by somebody who did not read it in time.
        <div className="invite-link-panel" role="alert">
          {/* Above the token's own field: the two things a client config needs sit together, and
              a member who copies only the secret and skips the address has nowhere to send it. */}
          {endpoint === ''
            ? <p className="field-hint">{t('settings.mcp.endpointUnset')}</p>
            : (
              <div className="copy-field">
                <span className="label">{t('settings.mcp.endpoint')}</span>
                <code className="copy-value">{endpoint}</code>
                <button type="button" className="button"
                  onClick={() => { void navigator.clipboard.writeText(endpoint) }}>
                  {t('settings.members.copy')}
                </button>
              </div>
            )}
          <div className="copy-field">
            <span className="label">{t('settings.mcp.secretTitle')}</span>
            <code className="copy-value">{justMinted.secret}</code>
            <button type="button" className="button"
              onClick={() => { void navigator.clipboard.writeText(justMinted.secret) }}>
              {t('settings.members.copy')}
            </button>
          </div>
          <p className="field-hint">{t('settings.mcp.secretHint')}</p>
          <div className="form-actions">
            <button type="button" className="button" onClick={() => setJustMinted(null)}>
              {t('settings.mcp.secretDone')}
            </button>
          </div>
        </div>
      )}

      {rows.length === 0
        ? <p className="field-hint">{t('settings.mcp.empty')}</p>
        : (
          <ul className="mcp-token-list">
            {rows.map((row) => <TokenRow key={row.id} row={row} />)}
          </ul>
        )}

      <form onSubmit={submit}>
        <label className="field">
          <span className="label">{t('settings.mcp.label')}</span>
          <input className="input" value={label} required
            onChange={(e) => setLabel(e.currentTarget.value)} />
          <span className="field-hint">{t('settings.mcp.labelHint')}</span>
        </label>
        <label className="field">
          <span className="label">{t('settings.mcp.life')}</span>
          <select className="input" value={days} onChange={(e) => setDays(Number(e.currentTarget.value))}>
            {LIVES.map((life) => (
              <option key={life} value={life}>{t('settings.mcp.lifeDays', { days: life })}</option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={create.isPending}>
            {create.isPending ? t('settings.mcp.minting') : t('settings.mcp.mint')}
          </button>
        </div>
      </form>

      {/* The server's own sentence, not one of this panel's: a refused life names the three that
          are allowed, and replacing that with "that did not work" throws away the only part that
          tells the reader what to pick instead. Same choice Profile.tsx makes. */}
      {create.isError && (
        <p className="field-error" role="alert">{t('settings.mcp.failed', { reason: create.error.message })}</p>
      )}
      {revoke.isError && (
        <p className="field-error" role="alert">{t('settings.mcp.revokeFailed', { reason: revoke.error.message })}</p>
      )}

      <h3 className="profile-subhead">{t('settings.mcp.callsTitle')}</h3>
      {/* Always, including when the list is empty. The sentence about arguments not being recorded
          is the part of this card worth reading, and hiding it behind "there are calls to show"
          would hide it from exactly the reader deciding whether to mint their first token. */}
      <p className="field-hint">{t('settings.mcp.callsHint')}</p>
      <CallsList />
    </div>
  )

  // A failed fetch and an empty list must not read the same: this list is the one surface on the
  // card whose job is to detect an attack rather than prevent one, and "No calls yet." over a
  // dropped request would tell the one reader checking for a leaked token that nothing happened.
  function CallsList() {
    if (calls.isError) return <ErrorState onRetry={() => { void calls.refetch() }} error={calls.error} />
    if (calls.data === undefined || calls.data.calls.length === 0) {
      return <p className="field-hint">{t('settings.mcp.callsEmpty')}</p>
    }
    return (
      <ul className="mcp-call-list">
        {calls.data.calls.map((call) => (
          <li key={call.id}>
            {when(call.atMs)} · {call.tool ?? '—'} · {call.rowCount ?? '—'} · {t(OUTCOME_KEY[call.outcome])}
          </li>
        ))}
      </ul>
    )
  }

  function TokenRow({ row }: { row: McpTokenRow }) {
    // Expiry and revocation are different facts about a token and the row says which: a member
    // looking for why an agent stopped working is served by "revoked on the 3rd" and misled by a
    // single greyed-out row that could mean either. A third fact sits beside those two: a token
    // nobody revoked can still have simply run out on its own, and "Expires <a past date>" reads
    // as a lie the moment the reader notices the tense. dead wins over naturallyExpired when a
    // token was revoked after it had already lapsed, since revocation is the more specific fact.
    const dead = row.revokedAtMs !== null
    // Duplicates core's mcpTokenUsable rule, the same way LIVES above duplicates the server's
    // closed set: this is a rendering fact about a row already fetched, not a second gate, and
    // the guard evaluating the same expiry against the real clock server side is the backstop.
    const naturallyExpired = !dead && row.expiresAtMs <= Date.now()
    return (
      <li className="mcp-token">
        <span className="label">{row.label}</span>
        <span className="field-hint">{t('settings.mcp.created', { when: when(row.createdAtMs) })}</span>
        <span className="field-hint">
          {dead
            ? t('settings.mcp.revoked', { when: when(row.revokedAtMs!) })
            : naturallyExpired
              ? t('settings.mcp.expired', { when: when(row.expiresAtMs) })
              : t('settings.mcp.expires', { when: when(row.expiresAtMs) })}
        </span>
        <span className="field-hint">
          {row.lastUsedAtMs === null
            ? t('settings.mcp.neverUsed')
            : t('settings.mcp.lastUsed', { when: when(row.lastUsedAtMs) })}
        </span>
        {!dead && !naturallyExpired && (
          <button type="button" className="button" disabled={revoke.isPending}
            onClick={() => revoke.mutate({ id: row.id })}>
            {revoke.isPending ? t('settings.mcp.revoking') : t('settings.mcp.revoke')}
          </button>
        )}
      </li>
    )
  }
}

// Literal keys rather than a template built from `outcome`, so catalogue-usage.test.ts's static
// scanner - which finds a dynamic t(`prefix.${var}`) only when the interpolation falls on a whole
// path segment - can see all three without special-casing a partial-segment interpolation like
// `outcome${suffix}`.
const OUTCOME_KEY: Record<McpCallRow['outcome'], string> = {
  ok: 'settings.mcp.outcomeOk',
  error: 'settings.mcp.outcomeError',
  refused: 'settings.mcp.outcomeRefused',
}
