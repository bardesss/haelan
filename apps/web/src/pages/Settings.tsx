import { useTranslation } from '../i18n/index.js'
import { useSession } from '../auth/session.js'
import { Card } from '../components/Card.js'
import { ConnectGoogle } from '../auth/ConnectGoogle.js'
import { Profile } from './settings/Profile.js'
import { McpTokens } from './settings/McpTokens.js'
import { OverrideList } from './settings/OverrideList.js'
import { SourceNames } from './settings/SourceNames.js'
import { DataTypes } from './settings/DataTypes.js'
import { Members } from './settings/Members.js'
import { InstanceUrl } from './settings/InstanceUrl.js'
import { Maintenance } from './settings/Maintenance.js'

// The settings page: no sections existed before this one, so pages/settings/ holds each section's
// own component (OverrideList.tsx is the first) and this file is the shell that gives them a
// title, a route and a place in the rail, the same shape every other top level page already uses.
export function Settings() {
  const { t } = useTranslation()
  const session = useSession()
  return (
    <>
      <h1 style={{ fontSize: 'var(--font-size-lg)', margin: '0 0 var(--space-3)' }}>{t('settings.title')}</h1>
      <div className="grid">
        {/* A person whose token was revoked lands on this page with somewhere to reconnect from
            that is not the Dashboard's front page forever: ConnectGoogle renders nothing once
            connected (its own doc comment), so this is silent for the common case. */}
        <ConnectGoogle />
        {/* First, and not gated on isAdmin: this is the reader's own account rather than anything
            about the instance, and the two routes behind it act on whoever the session resolves to.
            Every section below it changes something shared; this one is the only one that does not,
            which is also why it is the one a member arriving here at all can use. */}
        {/* Half width and side by side, and the only pairing on this page that is guaranteed to
            hold: these two are the sections nobody is gated out of, so admin and member see the
            same row rather than one of them seeing a card stranded beside a gap. Both are narrow
            enough to earn it - a form of three fields and a list of checkboxes - where the three
            sections below are a table and two rows of name-plus-controls that only lose columns
            at half width. DataTypes is lifted above Overrides to make the pair; it reads better
            here anyway, with the two sections about the reader's own account at the top and
            everything instance wide beneath them. */}
        <Card span={6} label={t('settings.profile.title')}>
          <Profile />
        </Card>
        {/* Not gated on isAdmin: DataTypes.tsx's own comment on why this is per person rather
            than household wide. */}
        <Card span={6} label={t('settings.dataTypes.title')}>
          <DataTypes />
        </Card>
        {/* Under the Profile/DataTypes row and not gated on isAdmin, for the same reason Profile
            is not: this is the reader's own credential, and there is deliberately no path by
            which an admin could mint one for somebody else. */}
        <Card span={12} label={t('settings.mcp.title')}>
          <McpTokens />
        </Card>
        <Card span={12} label={t('settings.overrides.title')}>
          <OverrideList />
        </Card>
        <Card span={12} label={t('settings.sourceNames.title')}>
          <SourceNames />
        </Card>
        {/* Admin only, and gated here rather than inside Members itself: the five routes it calls
            already answer 'forbidden' to anyone else, but mounting the section at all for a
            member who cannot use a single control on it would be pure noise on their own screen. */}
        {session.data?.isAdmin === true && (
          <Card span={12} label={t('settings.members.title')}>
            <Members />
          </Card>
        )}
        {/* Admin only, and gated here for the same reason Members is: the PUT it calls already
            answers 'forbidden' to anyone else, and the address on show is one nobody but an admin
            can act on. Placed above Maintenance because moving an instance is a thing a household
            does once and needs to find, not a figure they watch.

            The second half width pair, and stable for the mirror image of the reason the first
            one is: both of these are admin gated, so they are present together or absent
            together and neither is ever left beside a gap. */}
        {session.data?.isAdmin === true && (
          <Card span={6} label={t('settings.instanceUrl.title')}>
            <InstanceUrl />
          </Card>
        )}
        {/* Admin only, and gated here for the same reason Members is: the three routes it calls
            already answer 'forbidden' to anyone else, but mounting a card whose only content is
            two buttons a member could never press would be pure noise on their own screen. */}
        {session.data?.isAdmin === true && (
          <Card span={6} label={t('settings.maintenance.title')}>
            <Maintenance />
          </Card>
        )}
      </div>
    </>
  )
}
