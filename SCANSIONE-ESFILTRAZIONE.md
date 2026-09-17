# Scansione esfiltrazione dati sanitari — repository `haelan`

**Repository:** `https://github.com/bardesss/haelan` (clone locale `E:\Git\haelan`)
**Commit analizzato:** `6c943f7`
**Data scansione:** 16 settembre 2026
**Tipo di analisi:** statica, read-only (nessun file del repository modificato)
**Perimetro:** `apps/server`, `packages/core`, `packages/tokens`, `apps/web`, `scripts`, `probe`,
configurazione di build e CI. **L'app Android è esclusa su richiesta.**

---

## VERDETTO

> **Nessuna esfiltrazione nascosta. Nessun tracciamento esterno. Nessuna telemetria.**

Il codice che **salva** i dati sanitari è `packages/core` (accesso alla Health API di Google +
SQLite) e `apps/server` (le route che li ricevono e li scrivono). In tutto questo perimetro
esistono **tre sole destinazioni di rete in uscita**, e sono tutte endpoint ufficiali Google:
la Health API v4 e OAuth2. Il frontend web parla **esclusivamente** con la propria origine.

Nessun endpoint strano, nessun analytics, nessun crash-reporting, nessun CDN, nessun pixel,
nessun dominio di terze parti hardcoded.

**Confidenza:** alta per l'analisi statica di sorgenti, artefatti compilati e storia git.
Nessuna analisi dinamica (cattura traffico) è stata eseguita — vedi §6.

---

## 1. Architettura dei dati

```
Google Health API v4 ──(sync, solo IN INGRESSO)──> server ──> SQLite locale
                                                      │
                                            web dashboard (stessa origine)
```

Il verso è **sempre in entrata**. Il server non rispedisce nulla all'esterno: le sue chiamate
uscenti sono *richieste di lettura* verso Google, autenticate col token dell'utente. Non esiste
nel codice alcun percorso che prenda una riga dal database e la invii altrove.

---

## 2. Mappa completa dell'egress di rete — l'evidenza centrale

**Ogni singolo punto del codice di produzione che apre una connessione**, in tutto il perimetro:

| # | File:riga | Destinazione | Cosa trasmette |
|---|---|---|---|
| 1 | `packages/core/src/api/client.ts:292` | `https://health.googleapis.com/v4` | GET/POST di **lettura** verso Google + Bearer token |
| 2 | `packages/core/src/api/oauth.ts:164` | `https://health.googleapis.com/v4/users/me/profile` | lettura profilo Google |
| 3 | `packages/core/src/api/oauth.ts:103` | `https://oauth2.googleapis.com/token` | scambio refresh → access token |
| 4 | `packages/core/src/api/tokens.ts:63` | `https://oauth2.googleapis.com/token` | refresh del token |
| 5 | `apps/web/src/api/client.ts:39` | **path relativo** (stessa origine) | unico `fetch` del frontend |
| 6 | `apps/web/src/setup/SetupApp.tsx:136` | `/api/sync/events` (stessa origine) | SSE di avanzamento sync |

Più il redirect del browser verso `https://accounts.google.com/o/oauth2/v2/auth`
(`packages/core/src/api/oauth.ts:4`), che avviene **solo dopo un click dell'utente** su
`/oauth/start` e non trasmette alcun dato sanitario — solo `client_id`, `redirect_uri`,
`scope` e `state`.

**Nient'altro.** Ricerca esaustiva di `fetch(`, `new WebSocket`, `EventSource(`, `sendBeacon`,
`createConnection`, `request(`, `import(` dinamici e degli import `node:net`, `node:tls`,
`node:dns`, `node:http`, `node:https`, `node:dgram` su tutto `apps/server` e `packages/core`:
gli unici riscontri in codice di produzione sono quelli in tabella (gli altri sono in test).

### 2a. La destinazione non è dirottabile

Il client API costruisce gli URL da costanti di modulo — `API_ROOT`, `TOKEN_ENDPOINT`
(`packages/core/src/api/client.ts:8`, `oauth.ts:4-6`, `tokens.ts:4`). Esistono override
(`EndpointOverrides`, `app.ts:28`) ma sono **dichiarati "Tests point these at a stub;
production leaves them unset"** e `index.ts` non li valorizza. Non c'è variabile d'ambiente,
file di configurazione o input utente che possa cambiare l'host di destinazione.

Il frontend usa **solo path relativi**: verificati tutti i ~94 call-site e ogni path-builder
(`pageShell.ts`, `useInsight.ts`, `useSeries.ts`, `useIntraday.ts`, `useNights.ts`,
`useAnnotations.ts`, …) — iniziano tutti per `/api/`.

### 2b. Domini unici in tutto il repository

Estraendo **tutti** gli URL da tutti i file di `apps/`, `packages/`, `scripts/`, `probe/`,
`.github/` — **19 host**, tutti legittimi:

```
accounts.google.com        health.googleapis.com      oauth2.googleapis.com
www.googleapis.com         console.cloud.google.com   developers.google.com
github.com                 schemas.android.com        (namespace XML)
localhost / 127.0.0.1      10.0.2.2 / 192.168.*        (esempi, test)
box.tail1234.ts.net        haelan.example(.com)       (placeholder Tailscale / esempi)
example.invalid            nas                        (test)
```

**Stessa ricerca sull'intera storia git (225 commit):** 37 host, tutti riconducibili a Google,
a documentazione (fsf.org, apache.org, gnu.org, semver.org, keepachangelog.com), ai badge
`img.shields.io`, allo schema `w3.org`, o a placeholder di test (`evil.example`,
`stub.invalid`). **Nessun host è mai stato introdotto e poi rimosso per nasconderlo.**

---

## 3. Dipendenze: nessun SDK di tracciamento

**Tutte** le dipendenze del workspace:

| Pacchetto | Dipendenze |
|---|---|
| root | typescript, vitest, fast-check, happy-dom, vite-node, @types/node |
| `apps/server` | fastify, @fastify/cookie, @fastify/static, better-sqlite3, drizzle-orm, zod, @modelcontextprotocol/sdk |
| `apps/web` | react, react-dom, echarts, i18next, react-i18next, @tanstack/react-query |
| `packages/core` | better-sqlite3, drizzle-orm, @node-rs/argon2, drizzle-kit |
| `packages/tokens` | *(zero dipendenze)* |

**Nessuna** libreria di analytics, crash-reporting, ads, attribution o telemetria — nessuna
occorrenza di Firebase, Crashlytics, Sentry, Amplitude, Mixpanel, Segment, PostHog, Datadog,
Bugsnag, Hotjar, LogRocket, Matomo, Plausible, Umami, Google Analytics/Tag Manager,
AppsFlyer, Adjust…

Le uniche parole chiave che compaiono nei sorgenti sono falsi positivi verificati con contesto:
`plausible` è l'aggettivo inglese in 22 commenti, `tracking` è in commenti e in un'etichetta
di navigazione, `track(` è un helper dei test.

---

## 4. Supply chain di build

| Controllo | Esito |
|---|---|
| `pnpm-lock.yaml`: pacchetti con `requiresBuild` | **0** → nessuno script di installazione eseguito dalle dipendenze |
| `pnpm-workspace.yaml`: `allowBuilds` | solo `better-sqlite3` ed `esbuild` |
| `.npmrc` / `.pnpmfile.cjs` / hook pnpm | **assenti** |
| `postinstall` / `preinstall` nei package.json | **nessuno** |
| Git hooks | solo `.githooks/commit-msg` (rifiuta link di sessione nei messaggi); `.git/hooks` vuoto |
| CI (`.github/workflows`) | GitHub Actions standard; `release-please` fissato per SHA |
| Segreti committati (`.env`, `.pem`, `.key`, keystore) | **nessuno** — `.gitignore` copre `.env`, `.env.local`, `probe/.tokens.json`, `.local-*/` |
| Task pianificati / persistenza (`schtasks`, `crontab`, registro) | **nessuno** |

Nessun `probe/.tokens.json` né database SQLite è tracciato da git (verificato con `git ls-files`).

---

## 5. Codice offuscato o nascosto: nessun reperto

| Ricerca | Esito |
|---|---|
| `eval(` / `new Function(` | **0** in codice di produzione |
| Stringhe base64 lunghe (≥60 caratteri) | **0** |
| Caratteri Unicode invisibili / bidi (*Trojan Source*) | **0** |
| Righe >2000 caratteri (payload compressi) | **0** |
| `import()` dinamici con URL variabile | **0** (solo import locali di file) |
| `child_process` | solo per la sandbox SQL (`mcp/runSql.ts`, `mcp/sqlWorker.ts`) e i test — documentato |
| `Buffer.from(..., 'base64')` | solo per OAuth `state`, cifratura AES-GCM (`crypto/secretBox.ts`), chiave d'istanza |
| `os.hostname` / fingerprinting macchina | **0** (solo `randomUUID` per ID interni) |
| `sendBeacon` / `WebSocket` / `XMLHttpRequest` | **0** |
| Logging remoto | **0** — Fastify con `logger: false` (`app.ts:147`), solo `console.log`/`error` locali |
| Redirect aperti (`reply.redirect` con URL utente) | **0** — solo `/setup/google`, `/setup/backfill`, `/` (relativi) |

### 5a. Il bundle compilato è stato verificato, non solo i sorgenti

`apps/web/dist/assets/index-CyetZH-S.js` (1.17 MB) — l'artefatto che viene realmente servito:

- host esterni presenti: `www.w3.org` (namespace SVG/XML), `github.com` (3 link della sidebar),
  `react.dev` (testo dei messaggi d'errore React), `react.i18next.com` (avviso di doc),
  `console.cloud.google.com` (link setup), `haelan.example.com` (placeholder)
- **tutti link cliccabili o stringhe non eseguibili**, nessuna richiesta automatica
- le tre keyword sospette sono state verificate con contesto e sono interne a librerie:
  `gTag` = `Symbol.toStringTag` dell'helper del bundler, `Amplitude` = `zigzagAmplitude`
  di ECharts, `EventSource` = `/api/sync/events` (stessa origine)
- CSS compilato: **zero** `@import`, `url()`, data-URI o URL remoti
- **zero** `@font-face` in tutto il progetto: font stack 100% di sistema, nessun Google Fonts
- `index.html`: solo icone locali e uno script locale — nessun CDN, nessun iframe

Gli asset in `assets/screenshots/*.png` sono stati verificati a livello di byte: `IEND`
all'ultimo byte, zero dati accodati, nessun chunk di metadati (`tEXt`/`zTXt`/`iTXt`).

---

## 6. Cosa NON ho potuto verificare (limiti espliciti)

1. **Nessuna analisi dinamica.** Non ho eseguito l'istanza né catturato traffico reale
   (DevTools, mitmproxy, tcpdump). Il verdetto è statico. Una cattura di traffico su
   un'istanza reale è l'unico passo che chiuderebbe la questione in modo definitivo.
2. **Nessuna revisione riga-per-riga di `node_modules`.** L'analisi del bundle compilato non
   mostra traffico verso host esterni, ma non è una revisione di ogni libreria di terze parti.
3. **Il bundle `apps/web/dist` è l'artefatto di una build precedente**: l'ho analizzato come
   tale e non ho rieseguito `pnpm build` per confrontarlo byte-per-byte con l'HEAD del sorgente.
   Entrambi comunque puliti.
4. **Documentazione locale stantia** (non è un problema di sicurezza): `AUDIT.md`, `PLAN.md`,
   `AGENT.md`, `TASKS.md` descrivono codice che non esiste più. Sono esclusi da git
   (`.git/info/exclude`) e non tracciati — ma se li leggi, sono fuorvianti.

---

## 7. Reperti reali — **non** esfiltrazione, ma da conoscere

### R-1 · Nessuna Content-Security-Policy né header di sicurezza (medio)
**Nessun** header `Content-Security-Policy`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy` o `Strict-Transport-Security` in tutto il repository. Il bundle è servito
da `apps/server/src/static.ts:14` senza header; `app.ts` non ha hook `onSend`; non c'è helmet.

*Perché conta per questa domanda:* una CSP `default-src 'self'` è il controllo che renderebbe
**verificabile a runtime** l'assenza di traffico in uscita, invece che solo per ispezione
statica. È la raccomandazione principale.

### R-2 · XSS nei tooltip — già corretto (informativo, ma importante)
`apps/web/src/charts/base.ts:225-264` documenta che i tooltip ECharts finivano in `innerHTML`
e che una nota contenente `<img src=x onerror=...>` veniva **eseguita**. La correzione
(`escapeHtml` + tagged template `tip`) è presente, e un test-guardia
(`apps/web/test/no-unescaped-tooltip.test.ts`) impedisce regressioni. Un XSS sarebbe stato un
vettore di esfiltrazione reale: è chiuso.

### R-3 · `i18next` con `escapeValue: false` (basso, informativo)
`apps/web/src/i18n/index.tsx:20`. Corretto nel contesto attuale perché l'output passa da React,
che escappa — ma è la precondizione di R-2, quindi vale come difesa in profondità.

---

## 8. Raccomandazioni, in ordine di valore

1. **Aggiungere una CSP** restrittiva lato server:
   `default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`.
2. **Aggiungere `X-Frame-Options: DENY`** e **`Referrer-Policy: no-referrer`** come default
   globale (oggi solo i link esterni hanno `rel="noreferrer"`).
3. **Eseguire una cattura di traffico** su un'istanza reale per la conferma dinamica.
4. Valutare `escapeValue: true` in i18next come difesa in profondità (R-3).

---

## 9. Riproducibilità

```bash
# Egress: ogni chiamata di rete nel codice di produzione
rg -n "fetch\(|new WebSocket|EventSource\(|sendBeacon|createConnection" apps packages

# Domini unici, anche su tutta la storia git
git grep -h -I -o 'https?://[a-zA-Z0-9._-]+' $(git rev-list --all) | sort -u

# Codice offuscato / payload nascosti
rg -n "eval\(|new Function\(|atob\(|fromCharCode" apps packages
rg -n '["'"'"'][A-Za-z0-9+/]{60,}={0,2}["'"'"']' apps packages

# Script di installazione nelle dipendenze  -> 0
rg -c "requiresBuild" pnpm-lock.yaml

# Segreti tracciati  -> vuoto
git ls-files | rg '\.env|\.pem|\.key|\.p12|keystore'
```

---

*Report generato da analisi statica read-only. Nessun file del repository è stato creato,
modificato o cancellato durante la scansione.*
