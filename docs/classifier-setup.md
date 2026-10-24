# Category classifier setup — TypeSafe Jev main, DeepSeek fallback

Follower Centrifuge 6000 Pro Max Ultra Plus Titanium Reloaded Flash Xtreme HD Turbo Enriched estimates an account's category from **public usernames, display names and — when enabled — public profile photos**. Two hosted
classifiers are supported plus a fully offline demo:

| Provider | Role | API |
| --- | --- | --- |
| **TypeSafe AI Jev** (`jev-latest`) | Primary (recommended) | `POST https://api.typesafe.ai/v1/systemone` — structured `choice` questions |
| **DeepSeek** (`deepseek-chat`) | Fallback (when Jev fails) or alternative primary | OpenAI-compatible `POST /v1/chat/completions` (direct browser or local proxy) |
| **Offline demo** | No network, deterministic | local first-name heuristics |

Every result is an **estimate** with a confidence value. The default category set
is `female`, `male`, `machine`, `organization` and `ambiguous`; the product is
category-agnostic and the same pipeline applies to whichever category you choose
in the wizard. Results are never statements of fact about a person.

---

## 1. TypeSafe Jev (primary)

1. Sign up at <https://console.typesafe.ai/> and create an API key (`apikey_…`).
2. In the app: **Advanced → Name classifier → Primary provider → TypeSafe Jev** (the wizard keeps this out of the way; it is rarely needed).
   - API key: paste it (kept in this tab's `sessionStorage`; never written to
     `localStorage`).
   - Model: `jev-latest` (aliases `jev-preview`, pinned versions such as
     `jev-1.14.0` also work — see <https://api.typesafe.ai/v1/models>).
   - Base URL: `https://api.typesafe.ai`.
3. Press **Test connection**. It performs a tiny System One probe and reports
   the answering model.

### Instagram CSP: why the local relay exists

Instagram's page Content-Security-Policy blocks cross-origin `fetch`/XHR to
`api.typesafe.ai` and `api.deepseek.com` (`connect-src`), while explicitly
allowing `ws://localhost:*`. Direct browser calls therefore fail on
instagram.com. Start the bundled relay once and keep it running while scanning:

```bash
npm run proxy    # HTTP proxy + ws://localhost:8787/ws relay
```

Firefox upgrades `ws://localhost` to `wss://localhost` because Instagram's CSP
contains `upgrade-insecure-requests`. The proxy therefore also serves a secure
relay on `wss://localhost:8788` using a certificate issued by a **locally
generated CA** (`.proxy-cert/ca-cert.pem`). On start it installs that CA as a
trusted CA into every Firefox profile's NSS database (and Chrome's
`~/.pki/nssdb`) via `certutil`; `npm run trust:relay` does the same manually and
auto-downloads `libnss3-tools` into the gitignored `.tools/` when certutil is
missing. **One-time step: restart Firefox** so NSS reloads the trust store —
there is no certificate dialog to click. Re-run the installer after creating a
new browser profile or deleting `.proxy-cert/`. Chrome/Edge use the plain relay
without extra steps.

In **Advanced → Name classifier → Classifier transport** the default `Auto`
mode uses the relay on instagram.com and direct calls on any other origin.
`Always use the local relay` forces it; `Direct API calls` is only useful for
pages without that CSP (local preview, your own site). The relay is
loopback-only, forwards only the two classifier hosts over HTTPS, and rejects
non-Instagram/non-localhost browser origins. If the relay is not running, the
review screen shows the exact first transport error plus this fix.

### How the app talks to Jev

**Profile photos (optional):** a vision-capable DeepSeek model
(`deepseek-flash` by default) is used only to describe public profile photos as
neutral visual cues; usernames and display names travel with those cues into
Jev's main classification. Jev always makes the category decision, and the review
rows are labelled **via main** or **via fallback**. Turn the photo pass off in
**Advanced → Name classifier → Include profile photos** to classify from text
only. Photo URLs are sent to DeepSeek during that pass.

A whole batch is classified in **one** request: the app sends the list of
accounts as `state` (numbered rows with username + display name only — no
Instagram ids), and one `choice` question per account
(`account_1`, `account_2`, …) whose criteria are the five categories. Each
answer returns the chosen category, a confidence and full probabilities. This
is very cheap: one 5-account probe used ~1.2k input tokens.

### Pricing (as published by TypeSafe, verify in your console)

Input ≈ **$0.042 per million tokens**, output free. In practice a 1,000-account
audit costs a fraction of a cent. Results are cached locally (keyed by prompt
version + model), so re-runs of the same accounts are free and make no request.

---

## 2. DeepSeek fallback

Enable **“Fall back to DeepSeek if Jev fails”** to retry a batch through
DeepSeek whenever Jev errors (network, auth, rate limit, invalid response).
Each classification records which provider actually answered.

Two transports:

| Transport | Where the key lives | Notes |
| --- | --- | --- |
| **Direct browser** | `sessionStorage` of the instagram.com tab (or compiled into the optional local build) | DeepSeek's API currently sends CORS headers for the instagram.com origin (verified with a preflight from `https://www.instagram.com`). If it starts rejecting browser calls, switch to the proxy. |
| **Local proxy** | Proxy process env only | Optional hardening: the key never enters the browser. Start with `DEEPSEEK_API_KEY=sk-... npm run proxy`; it listens on `http://127.0.0.1:8787`. |

DeepSeek model defaults to `deepseek-chat`; the app asks for strict JSON output
and validates it (every account exactly once; unknown/duplicate/extra ids are
discarded; confidence clamped).

---

## 3. Public/GitHub Pages users vs the optional keyed build

- **Public build (GitHub Pages)**: `npm run build` — contains **no keys**.
  Every user configures their own provider + key in Settings (session-only).
  Never bake somebody else's account or key into a published page.
- **Optional local keyed build** (personal use only):

  ```bash
  printf '%s' 'apikey_…' > .typesafe-key   # gitignored
  printf '%s' 'sk-…'     > .deepseek-key   # gitignored, optional fallback
  npm run build:local-key                  # -> dist/critical-relations-local.js (gitignored)
  ```

  The output embeds the keys and defaults to TypeSafe Jev + DeepSeek fallback,
  so pasting it into the console needs no settings. **Never commit, publish or
  share that file.** The embed is gated behind `IU_ALLOW_EMBEDDED_KEY`, which
  only `build:local-key` sets — a stray env var can never leak into a normal
  build. Keys compiled into the local build are never copied into
  `sessionStorage`/`localStorage`.

Verify the real APIs end-to-end with synthetic names only:

```bash
npm run check:classifier
```

This reads `.typesafe-key` / `.deepseek-key` (or `TYPESAFE_API_KEY` /
`DEEPSEEK_API_KEY`), probes the primary + fallback, classifies six synthetic
accounts through the app's real prompt/parser, and asserts the five categories.

---

## 4. Privacy: what leaves the browser

- **TypeSafe Jev**: one HTTP request to `api.typesafe.ai` containing a numbered
  list of `{username, display_name}` plus fixed category criteria. No account
  ids, cookies, passwords, photos or follower lists.
- **DeepSeek**: a chat request containing account id, username and display name
  (the id is used only to match answers back to accounts), plus the fixed
  prompt. In proxy mode it goes to your local proxy, which forwards to
  `api.deepseek.com`.
- Names are explicitly marked as untrusted data; the prompts forbid inferring
  anything from photos or protected traits and tell the model to ignore
  instructions embedded in names.
- Classification results are cached in `localStorage` on the current origin.
  JSON/CSV exports contain only public account fields — no category guesses.

---

## 5. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Authentication failed (HTTP 401/403)` | Wrong/revoked key | Create a new key; for the proxy update `DEEPSEEK_API_KEY` and restart |
| `Could not reach TypeSafe (network error or timeout)` | No internet / DNS / firewall | Check connectivity to `api.typesafe.ai`; retry |
| `TypeSafe responded with an unexpected/invalid payload` | Wrong base URL/model or a proxy returning HTML | Verify base URL + model (`jev-latest`) |
| `[proxy] Could not reach DeepSeek` | Proxy not running / wrong URL | `curl http://127.0.0.1:8787/health`; check the proxy URL in Settings |
| Proxy says `Origin is not allowed by this proxy` | Browser origin not allowlisted | Add the exact origin to `CORS_ORIGINS`, restart the proxy |
| `EADDRINUSE` on 8787 | Port taken | `PORT=8788 npm run proxy` and update the proxy URL in Settings |
| Rate limited (429) | Too many requests | Wait; lower batch size; the client already retries with backoff |
| Classification seems wrong for ambiguous/non-Latin names | Model uncertainty | They are labelled `ambiguous`; review before acting |

On instagram.com every request (TypeSafe or DeepSeek) goes through the proxy's
WebSocket relay at `ws://localhost:8787/ws`; the HTTP endpoints below remain
useful for local pages/tools. If the relay is unreachable the classifier stops
after the first failed batch (circuit breaker) so the review can show one clear,
actionable error instead of hundreds of retries.

Environment variables for the local proxy/relay: `DEEPSEEK_API_KEY` (required for
requests without their own Authorization header), `DEEPSEEK_BASE_URL`
(default `https://api.deepseek.com`), `PORT`/`DEEPSEEK_PROXY_PORT` (8787),
`HOST` (default `127.0.0.1` — **do not expose publicly**), `CORS_ORIGINS`
(default includes `https://www.instagram.com` and localhost dev ports).
