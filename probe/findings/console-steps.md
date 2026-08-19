# Console steps, recorded <date>

Source material for the M1 setup wizard. Google exposes no API for creating an OAuth client,
so every self-hoster repeats these clicks. The only lever available is making them unambiguous,
which means recording the friction while it is fresh rather than from memory.

| # | Page | Action | Value | Friction |
|---|---|---|---|---|
| 1 | | | | |

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
