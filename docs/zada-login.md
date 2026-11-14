# Log in with ZADA — integration guide

> One file, written to be read by developers and by coding agents (Claude Code, Cursor, Codex).
> Everything an integration needs is on this page. Version 1.0 · November 2026.

## What it is

"Log in with ZADA" is a standard **OpenID Connect authorization-code flow**. Instead of a password,
the user proves who they are with a credential in the **ZADA Wallet** app (for example their ZADA
ID). You receive an ID token with verified claims — name, phone number, email — that the user
approved sharing.

Any OIDC library works. There is nothing ZADA-specific to install.

## Before you start

You need three things. Your ZADA contact gives you the first; you set the other two yourself in
the ZADA Portal (**Tenant Dashboard → OAuth Setup**) or ask your ZADA contact to do it.

| Item | Where it comes from |
|---|---|
| `client_id` | Issued by ZADA when your organisation is set up |
| Allowed callback URLs | You register every environment's exact callback URL |
| `client_secret` | Generated once in OAuth Setup (shown once) or handed over by ZADA |

## Endpoints

Discovery (authoritative): `https://portal.zada.solutions/.well-known/openid-configuration`

| Purpose | URL |
|---|---|
| Issuer (`iss`) | `https://portal.zada.solutions` |
| Authorize | `https://api.zada.solutions/portal/functions/v1/authorize` |
| Token | `https://api.zada.solutions/portal/functions/v1/token` |
| JWKS | `https://api.zada.solutions/portal/functions/v1/oidc-jwks` |
| UserInfo | `https://api.zada.solutions/portal/functions/v1/oidc-userinfo` |

**Use these hosts exactly.** Do not substitute a `*.supabase.co` URL you may find elsewhere: it is
blocked for users in Myanmar and the login will silently fail for them.

## Hard rules

These are the mistakes integrations actually make. Follow all of them.

1. **Server-side only.** The token exchange and the `client_secret` live on your back end. Never put
   the secret in browser or mobile code, a repository, or logs.
2. **Exact callback match.** `redirect_uri` must be byte-identical to a registered URL — scheme,
   host, port, path, trailing slash. Use the same value at `/authorize` and `/token`.
3. **Callbacks you control.** Use `https://` on a domain you own. For local development use
   `http://localhost:<port>/...` — never a made-up hostname such as `dev.local.com`: those can be
   real public domains owned by someone else.
4. **Always send `state`** (random, per request) and reject the callback if it does not match.
5. **Always use PKCE (S256).** ZADA accepts requests without it; do not rely on that.
6. **Send a `nonce`** and check it in the ID token.
7. **Open the system browser**, not an embedded WebView, on mobile. The user must switch to the
   ZADA Wallet app and come back.
8. **Key accounts on `sub`, not on claims.** See [Linking accounts](#linking-accounts).

## The flow

```
your app                      ZADA                               user's phone
   |-- 302 /authorize -------->|                                     |
   |                           |-- QR code / deep link ------------->| ZADA Wallet: approve
   |<-- 302 callback?code&state|<-- verified presentation -----------|
   |-- POST /token (server) -->|
   |<-- id_token --------------|
```

### 1. Send the user to `/authorize`

```
GET https://api.zada.solutions/portal/functions/v1/authorize
  ?client_id=<client_id>
  &redirect_uri=<registered callback, URL-encoded>
  &response_type=code
  &scope=openid
  &state=<random>
  &nonce=<random>
  &code_challenge=<BASE64URL(SHA256(code_verifier))>
  &code_challenge_method=S256
```

ZADA shows a page with a QR code (desktop) or a button that opens the wallet (phone), waits for the
user, and redirects back to you. You do not poll anything.

`scope=openid` runs your organisation's default login (normally the ZADA ID). `scope=openid age`
runs an age check instead, if ZADA has configured one for you.

### 2. Handle the callback

| You receive | Meaning |
|---|---|
| `?code=…&state=…` | Success. Check `state`, then go to step 3 |
| `?error=access_denied&error_description=…&state=…` | User declined, verification failed, or the credential's issuer is not accepted. Show the description |
| `?error=invalid_request\|unsupported_response_type\|server_error&…` | A problem with the request or on ZADA's side |

If your `client_id` is unknown or the `redirect_uri` is not registered, ZADA **does not redirect**:
it shows a 400 error page (`invalid_client` / `invalid_redirect_uri`) and your callback is never
called.

### 3. Exchange the code (server-side)

```
POST https://api.zada.solutions/portal/functions/v1/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<code>
&redirect_uri=<same value as step 1>
&client_id=<client_id>
&client_secret=<client_secret>
&code_verifier=<code_verifier>
```

`client_secret_basic` (HTTP Basic) also works. Codes are single-use and must be exchanged within
**10 minutes** of the user approving.

Response:

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 3600, "id_token": "…", "scope": "openid profile" }
```

### 4. Validate the ID token

Verify the RS256 signature against the JWKS, and check `iss = https://portal.zada.solutions`,
`aud = <client_id>`, `exp`, and `nonce`.

Example payload:

```json
{
  "iss": "https://portal.zada.solutions",
  "aud": "<client_id>",
  "sub": "zada-Xq3…",
  "auth_time": 1763020800,
  "acr": "zada:acr:credential",
  "nonce": "…",
  "name": "Aung Aung",
  "phone_number": "+959…",
  "email": "aung@example.com",
  "verified_claims": { "verification": { … }, "claims": { … } }
}
```

The released claims appear twice: flattened at the top level (easy to read) and inside
`verified_claims` (OpenID for Identity Assurance format, with evidence of which organisation issued
the credential). Which claims you receive is fixed per organisation; ask ZADA to change it.

## Linking accounts

`sub` is **pairwise**: the same person always gets the same `sub` at your `client_id`, and a
different `sub` at every other service. It is derived from a stable claim in the credential (for a
ZADA ID, normally the phone number).

- **First login of an existing customer:** you have no `sub` yet. Match once on a verified claim,
  then store `sub` on the account. `phone_number` arrives in E.164 (`+959…`): convert your stored
  numbers to the same format to compare. `email` is verified by ZADA before the credential is issued;
  compare it lowercased. Prefer phone when both are present.
- **Every login after that:** look up by `sub` only.
- If more than one account matches, do not link: send the person to support.
- If no account matches, decide as a product choice: create one, or send them to your normal
  sign-up first.
- If the person's anchoring claim changes (a new phone number), their `sub` changes. Fall back to the
  one-time match above.

## Testing

1. Register a staging and a `localhost` callback.
2. Install the ZADA Wallet on a test phone — [App Store](https://apps.apple.com/app/zada-id-wallet/id1578666669)
   (listed as "ZADA ID Wallet") or [Google Play](https://play.google.com/store/apps/details?id=com.zadanetwork.wallet) —
   and create a ZADA ID.
3. Run the login on staging, approve in the wallet, and confirm you receive the ID token.
4. Automated smoke test (no phone needed) — checks discovery, your callback registration, and that
   the token endpoint enforces your secret:

```bash
./verify.sh <client_id> <registered_callback_url>
```

(`verify.sh` ships in the ZADA Login skill, see below.)

A full login cannot be automated: a person must approve in the wallet. That is the point.

## Errors at `/token`

| `error` | Cause |
|---|---|
| `invalid_client` | Wrong `client_id`, or missing or wrong `client_secret` |
| `invalid_grant` | Code expired, already used, wrong `redirect_uri`, or PKCE `code_verifier` mismatch |
| `authorization_pending` | Code used before the wallet finished — should not happen in this flow |
| `access_denied` | Verification failed |

## Security

- Rotate the `client_secret` in OAuth Setup the moment you suspect it leaked.
- Remove callback URLs you no longer use; the allow-list is your main protection.
- Each login is a fresh wallet verification. There is no long-lived ZADA session to sign out of —
  manage your own session lifetime.

## For coding agents

A ready-made Claude Code skill with these rules, a reference implementation and `verify.sh`:

```
/plugin marketplace add lycheeventures/zada-agent-kit
/plugin install zada-login@zada
```

Other agents: point them at this file, or at `/llms.txt` on the same host.

## Help

Your ZADA contact, or the ZADA Portal → Tenant Activity, which lists every login attempt with its
status and error.
