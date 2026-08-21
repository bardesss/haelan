# Scope classification, observed 2026-08-19

Project: haelan-genesis. Consent screen app name: haelan.

## Requested scopes

All read-only. Derived from the v1 page set, see the mapping in the M0 handover.

| Scope | Console label | User-facing description |
|---|---|---|
| googlehealth.activity_and_fitness.readonly | Restricted | See your Google Health activity and fitness data |
| googlehealth.health_metrics_and_measurements.readonly | Restricted | See your Google Health health metrics and measurement data |
| googlehealth.nutrition.readonly | Restricted | See your Google Health nutrition data |
| googlehealth.sleep.readonly | Restricted | See your Google Health sleep data |
| googlehealth.profile.readonly | Restricted | See your Google Health profile data |
| googlehealth.settings.readonly | Sensitive | See your Google Health settings |

Observed on the Data Access page, 2026-08-19. The console groups scopes under "Your
non-sensitive scopes", "Your sensitive scopes" and "Your restricted scopes" rather than
labelling a column, and it further subheads the restricted group as "Google Health scopes".
No scope landed in the non-sensitive group.

Restricted means verification requires a third party security assessment, so verification is
permanently out of reach here. That costs nothing: verification exists to lift the 100 user
cap, and spec section 1 forbids ever wanting to exceed it. Google's own setup page implies
unverified clients may run in production under that cap, which is what the next check settles.

The user-facing descriptions above are what a household member reads on the consent screen.
They are recorded verbatim because the M1 setup wizard should show the same wording rather
than paraphrasing it.

## The decisive observation, resolved

Publishing status switched to **In production** while unverified, with five restricted scopes
attached. No security review was demanded and nothing blocked the switch.

- [x] Publishing status could be switched to In production while unverified: **yes**
- [x] The only warning shown was about branding: "Your branding needs to be verified before it
      can be shown to users." That governs whether the app name and logo appear on the consent
      screen, not whether the app may run.
- [x] Billing account demanded at any point: **no**, answered by the 2026-08-21 acceptance walk
  in `console-steps.md`. A project with no billing account attached completed client creation,
  publishing to In production, consent, and a full backfill.
- [ ] Per request cost shown on any quota page: pending, see the documented limits below

## Verdict

**Spec section 7 mitigation 1 applies.** Restricted classification governs verification, which
lifts the 100 user cap, not publishing, which is what controls token lifetime. The two are
independent, and only the second one matters to a household instance.

Consequences:

- Refresh tokens do not carry the 7 day testing status expiry. The household consents once.
- The reconnect banner and the invalid_grant pause stay in the design as the response to a
  genuine revocation, not as a weekly ritual. Mitigation 3 survives, mitigation 2 is dead.
- Every member sees an unverified app warning at consent. The setup guide must say so plainly
  and in advance, because an unexpected security warning is where a self hoster abandons the
  install.
- Verification is permanently out of reach and permanently unnecessary. These two facts are
  the same fact, stated from the two ends of spec section 1.

Empirical confirmation still runs: task 5 logs a daily refresh for ten days, because a
documented lifetime and an observed one are different kinds of evidence and the whole sync
design rests on this one.

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
