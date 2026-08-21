# Console steps, recorded 2026-08-21

Source material for the M1 setup wizard. Google exposes no API for creating an OAuth client,
so every self-hoster repeats these clicks. The only lever available is making them unambiguous,
which means recording the friction while it is fresh rather than from memory.

**Walked on 2026-08-21**, from an empty data directory against a real Google project and a real
account, in a browser. The console side produced no friction worth a table: the redirect URIs the
wizard offered were accepted verbatim with no editing, publishing reached In production with a
branding warning and nothing else, and **no billing account was demanded at any point** — which
closes the question M0 left open at `scopes.md`. The numbered copy in
`apps/web/src/setup/GoogleStep.tsx` needed no correction against what the console actually showed.

The friction was all on haelan's side, and the walk is the only reason it was found. Three
defects, none of which any test was positioned to catch, fixed in
[#25](https://github.com/bardesss/haelan/pull/25):

- The Google step said to declare all six scopes and never said which six, leaving the reader in
  the console with no way forward from the page they were following.
- Consent completed, the callback redirected, and nothing synced: `runner.start` only set an
  interval, and `setInterval` waits a whole interval before its first tick, so the screen saying
  haelan was walking backwards through the history would have said nothing had started for an hour.
- The backfill screen rendered white, because a rebuilt bundle kept being served against routes
  enumerated at registration, and the not-found handler answered the resulting asset requests with
  `index.html` and a 200.

A fourth, milder one: the documented acceptance command is
`HAELAN_DATA_DIR=./.local-data pnpm start`, and running plain `pnpm start` resolves the default
`/data` to `C:\data` on Windows — real health data at a drive root, outside the repository. The
absolute path printed at boot ([#24](https://github.com/bardesss/haelan/pull/24)) is what caught
it, working exactly as intended.

To repeat this run, from an empty data directory:

```
rm -rf ./.local-data
pnpm build
HAELAN_DATA_DIR=./.local-data pnpm start
```

Run it from the repository root. The server prints the data directory it resolved, and that
line is worth reading before starting: an acceptance run that quietly reopened a database from
an earlier attempt is not an empty volume, and would prove nothing.

Then walk the wizard end to end, filling one row above per console page as you go, and correct
`GoogleStep.tsx` wherever the recorded reality differs from what the copy claims.

### Acceptance, verified 2026-08-21

Each line records what was observed, not what was expected. Two carry the caveat that the first
attempt failed and the box is checked against the re-walk after [#25](https://github.com/bardesss/haelan/pull/25);
saying so is the point of keeping this file.

- [x] An empty data directory put the wizard on screen with no configuration.
- [x] The redirect URIs the wizard offered were accepted by the console verbatim, with no editing.
- [x] Publishing status reached In production, and the warning shown was about branding only.
- [x] Consent completed and the callback landed on the backfill screen. *First attempt: the screen
      rendered white. Checked against the re-walk after the static-asset fix.*
- [x] The profile probe passed. The callback probes access before storing anything, so a stored
      refresh token is itself the evidence.
- [x] Backfill started, progress was visible, and it survived a restart mid run. *First attempt:
      nothing started, because the first sync was never triggered on consent. After the fix, the
      instance was stopped mid backfill, its data directory moved, and restarted: the walk resumed
      from its stored cursors rather than from today, 76,969 → 114,027 → 160,263 samples across
      the restarts.*
- [x] `select count(*) from samples` returned a real count: **160,263**, plus 46 sessions and 725
      archived payloads, from a real account.
- [x] Nothing in the logs contained the client secret or a refresh token. Thirty-two captured
      server output files searched for the literal secret and for refresh token shapes.
- [x] The billing question M0 left open, answered: **no billing account was demanded at any
      point.** `scopes.md` still records this as pending and should be corrected.

Re-syncing is idempotent, measured on the same instance rather than inferred: the trailing week is
re-fetched every run, and 29 window and type pairs have been fetched more than once — 725 archived
payloads carry only 586 distinct body hashes, so 139 were bytes the instance already held. Against
that, zero duplicate sample natural keys and zero duplicate session keys.

**What this run does not establish:** how far back Google actually serves intraday data. The
design's argument for building ingestion before the dashboard is that minute-level history ages
out of Google's window irrecoverably, and the backfill now caps intraday types at 90 days. Whether
that cap forgoes data Google would still have served is unmeasured, and every day it stays
unmeasured the answer gets worse and cannot be recovered.

`.local-data/` is gitignored. It holds a real refresh token and real health data, and neither
belongs in this repository.

## Redirect URIs, a constraint the plan did not anticipate

The plan asked for `http://<lan-hostname>:8080/oauth/callback` to be registered alongside the
localhost entries. No such URI can be registered. Google's web application client rules,
quoted from developers.google.com/identity/protocols/oauth2/web-server:

- "Redirect URIs must use the HTTPS scheme, not plain HTTP. Localhost URIs (including localhost
  IP address URIs) are exempt from this rule."
- "Hosts cannot be raw IP addresses. Localhost IP addresses are exempted from this rule."
- "Host TLDs (Top Level Domains) must belong to the public suffix list."

So 192.168.178.82 fails the raw IP rule and a .local name fails both the scheme rule and the
public suffix rule.

Registered instead:

    http://localhost:8899/callback        probe, delete after M1
    http://localhost:8080/oauth/callback  instance, browser on the host machine
    http://127.0.0.1:8080/oauth/callback  same, for flows that resolve the loopback literally

The default port has since moved from 8080 to 4235, because 8080 is too commonly taken on a
household machine. The entries above are the record of what M0 actually registered; an
instance built to the current spec also needs `http://localhost:4235/oauth/callback` and
`http://127.0.0.1:4235/oauth/callback` in the console.

### What this means for M1

Serving the dashboard over plain HTTP on the LAN is untouched. Only the consent callback is
constrained, so consent can complete in exactly three places:

1. A browser on the machine running the instance, via localhost.
2. Tailscale, where the ts.net name carries a real certificate and sits on the public suffix
   list, so `https://<machine>.<tailnet>.ts.net/oauth/callback` is registrable.
3. A reverse proxy holding a certificate for a domain the household owns.

A second household member connecting from their own laptop therefore either uses the host
machine or the instance is on Tailscale. The wizard has to state which of the three applies
before it sends anyone to the consent screen, because the failure mode otherwise is a
redirect_uri_mismatch after consent has already been granted.
