# Console steps, recorded <date>

Source material for the M1 setup wizard. Google exposes no API for creating an OAuth client,
so every self-hoster repeats these clicks. The only lever available is making them unambiguous,
which means recording the friction while it is fresh rather than from memory.

| # | Page | Action | Value | Friction |
|---|---|---|---|---|
| 1 | | | | |

**Still empty, and M1d did not fill it.** The wizard's numbered console copy in
`apps/web/src/setup/GoogleStep.tsx` is derived from Google's documentation, not from a recorded
run, and documentation is not the console. Filling this in needs somebody to walk the real thing
in a browser against a real project, which no test can stand in for.

To do it, from an empty data directory:

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

### Acceptance, unverified

Nothing below has been confirmed against the real console. These are the questions the run has
to answer, recorded as questions so that a later reader cannot mistake them for results.

- [ ] An empty data directory put the wizard on screen with no configuration.
- [ ] The redirect URIs the wizard offered were accepted by the console verbatim, with no editing.
- [ ] Publishing status reached In production, and the warning shown was about branding only.
- [ ] Consent completed and the callback landed on the backfill screen.
- [ ] The profile probe passed. If it did not, the message named the actual cause.
- [ ] Backfill started, progress was visible, and it survived a container restart mid run.
- [ ] `sqlite3 .local-data/haelan.sqlite "select count(*) from samples"` returned a real count.
- [ ] Nothing in the logs contained the client secret or a refresh token.
- [ ] The billing question M0 left open, answered: was a billing account demanded at any point?

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
