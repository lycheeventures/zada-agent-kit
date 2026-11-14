---
name: zada-login
description: Add "Log in with ZADA" to an app — OpenID Connect authorization-code login where the user proves their identity with the ZADA Wallet. Use when the user asks to integrate ZADA login, ZADA ID sign-in, ZADA OIDC, or to migrate from the old ZADA 1-click login / Aegis gateway / v1-verifications API.
---

# Log in with ZADA

ZADA login is plain OpenID Connect (authorization code + PKCE, RS256 ID token). Use the project's
existing OIDC/OAuth library if it has one; otherwise follow `reference/express-example.js`
(Express + `pg`).

## Fixed values — use exactly these

| | |
|---|---|
| Issuer | `https://portal.zada.solutions` |
| Discovery | `https://portal.zada.solutions/.well-known/openid-configuration` |
| Authorize | `https://api.zada.solutions/portal/functions/v1/authorize` |
| Token | `https://api.zada.solutions/portal/functions/v1/token` |
| JWKS | `https://api.zada.solutions/portal/functions/v1/oidc-jwks` |

Never use a `*.supabase.co` host for ZADA, even if old code or docs contain one: it is blocked in
Myanmar, where many ZADA users are. If the project contains `v1-verifications`, `policy_id`,
`x-api-key` against ZADA, or "Aegis", that is the retired login — replace it, do not extend it.

## Ask the user for (do not invent)

1. `client_id` — from ZADA.
2. The exact callback URL for **each** environment (production, staging, local). Every one must be
   registered separately in the ZADA Portal (Tenant Dashboard → OAuth Setup) or by their ZADA
   contact. Nothing works for an unregistered URL.
3. The env var holding the `client_secret` (e.g. `ZADA_CLIENT_SECRET`). Never ask the user to paste
   the secret into the chat.
4. Which user table to link to, and its phone/email columns and their stored format.
5. What should happen when a verified person matches **no** existing account: create one, or refuse
   and send them to the normal sign-up. Default if they don't say: **refuse** and show a message —
   do not silently create accounts.
6. Whether the login is called by a server-rendered web app (cookie session, redirect home) or by a
   mobile/SPA client (see "API back ends" below).

Read `client_id`, callback URL and secret from configuration/env, not hard-coded — they differ per
environment. Put the values the user gave you in the example `.env`/config.

## Rules (each one has broken a real integration)

1. Token exchange and secret: **server-side only**. Never in front-end/mobile bundles, logs or git.
2. `redirect_uri` byte-identical to the registered URL, and identical at `/authorize` and `/token`.
3. Local development callback: `http://localhost:<port>/…` only (registered like any other). Never
   an invented hostname (`dev.local.com`, `myapp.local`…) — those can resolve to strangers' servers.
4. Random `state` per request, stored server-side, checked on callback, single-use.
5. PKCE S256 always, even though ZADA accepts requests without it.
6. Random `nonce`, checked in the ID token.
7. Mobile: open the login in the **system browser** (ASWebAuthenticationSession / Custom Tabs), not
   a WebView — the user switches to the ZADA Wallet app and back.
8. Validate the ID token: `algorithms: ['RS256']`, signature via JWKS, `iss`, `aud = client_id`,
   `exp`, `nonce`.
9. Escape `error_description` before putting it in HTML (it comes from the query string).
10. Wrap the token exchange and validation in error handling; a network failure must show a
    "try again" page, not crash the request.
11. Behind a reverse proxy, set `trust proxy` (or equivalent) so secure cookies work, and save the
    session before redirecting.

## Linking accounts

Store the `sub` claim. It is pairwise (per service) and stable for the same person — never compare
it across services.

1. **Add a column** for it (e.g. `zada_sub text`, unique where not null). Write the migration and tell
   the user it must be applied.
2. Login: look up by `sub` first.
3. No row by `sub` → match **once** on a verified claim, then save `sub` on that row:
   - `phone_number` arrives in **E.164** (`+959…`, `+66…`). Convert the *stored* value to E.164 to
     compare (for Myanmar local numbers `09…` → `+959…`; use libphonenumber for other countries), or
     compare against every stored format the table actually uses — check a few rows.
   - `email` is verified by ZADA (one-time-code checked before the credential was issued). Compare
     lowercased and trimmed. Prefer phone when both are present.
4. More than one row matches → **do not link**; refuse and tell the person to contact support.
5. No row matches → do what the user chose in "Ask the user" item 5.
6. Any claim can be absent (the person may not have it). Absent claims simply do not match.

## Claims

The ID token carries the claims ZADA has configured for this organisation, flattened at the top level
(`name`, `phone_number`, `email`, …) and again in `verified_claims` (OIDC4IDA; who issued the
credential is in `verified_claims.verification.evidence[0].record.source.organization`). You cannot
request more with scopes — the set is fixed server-side; tell the user to ask ZADA.

## API back ends (mobile app or SPA)

The ZADA redirect lands on the **back end** callback. After validating the ID token and linking the
account, hand the result to the client the way the project already does sessions: e.g. redirect to
the app's deep link / universal link with a **short-lived one-time code** that the app exchanges for
its normal session token. Never put the ID token, access token or secret in that redirect URL.

## Verify your work

After implementing, run the smoke test (no phone needed):

```bash
bash <this skill dir>/scripts/verify.sh <client_id> <registered_callback_url>
```

It checks discovery, that the callback is registered, that an unregistered one is refused, and that
`/token` enforces the secret. It does **not** test your code. All lines must print `PASS`; a `WARN`
about the secret means none is registered yet — required before go-live. Then tell the user the
steps you cannot do: apply the migration, and a real login on a phone with the ZADA Wallet.

Full guide for humans: `https://portal.zada.solutions/zada-login.md`.
