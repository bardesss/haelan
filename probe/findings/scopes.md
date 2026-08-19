# Scope classification, observed <date>

Project: haelan-genesis. Consent screen app name: haelan.

## Requested scopes

All read-only. Derived from the v1 page set, see the mapping in the M0 handover.

| Scope | Console label | Notes |
|---|---|---|
| googlehealth.activity_and_fitness.readonly | | |
| googlehealth.sleep.readonly | | |
| googlehealth.health_metrics_and_measurements.readonly | | |
| googlehealth.nutrition.readonly | | |
| googlehealth.profile.readonly | | |
| googlehealth.settings.readonly | | |

## The decisive observation

Google's setup page states that unverified clients carry a 100 user cap "for both testing and
production purposes", and that verification is needed only to exceed 100 users. If that is
accurate, an unverified client can sit in production status, which removes the 7 day refresh
token expiry that testing status imposes. A third party integrator instead reports that every
googlehealth scope is restricted and gated behind a security review.

Only the console settles it:

- [ ] Publishing status could be switched to In production while unverified: yes / no
- [ ] If no, the exact blocking message:
- [ ] Billing account demanded at any point: yes / no
- [ ] Per request cost shown on any quota page: yes / no

## Verdict

- Production reachable while unverified: spec section 7 mitigation 1 applies. The household
  consents once and never re-consents in normal use.
- Production blocked without a security review: mitigation 2 applies. Weekly re-consent goes
  into the setup guide and the reconnect banner becomes a first class feature.

## Rate limits, documented rather than observed

developers.google.com/health/rate-limits, read 2026-08-19:

| Interval | Limit |
|---|---|
| Per project, daily | 86.4M requests |
| Per project, minutely | 120,000 requests |
| Per user, minutely | 300 requests (5 QPS) |
| Unverified client | 250 QPS total, across at most 100 users |

Exceeding any of them returns 429. A household of a few people on a nightly sync is orders of
magnitude below every line here, so the sync engine's backoff exists for correctness rather
than for a limit anyone will reach.

Worth noting for the publishing status question: the unverified cap is expressed here as
throughput and user count, not as a restriction on running in production.
