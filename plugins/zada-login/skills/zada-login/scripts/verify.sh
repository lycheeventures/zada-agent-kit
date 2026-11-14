#!/usr/bin/env bash
# ZADA login smoke test. No phone, no secret needed.
# Usage: verify.sh <client_id> <registered_callback_url>
# Note: check 2 starts one real (unused) login session on ZADA's side; it expires after an hour.
set -u
CLIENT_ID="${1:-}"; CALLBACK="${2:-}"
if [ -z "$CLIENT_ID" ] || [ -z "$CALLBACK" ]; then echo "usage: $0 <client_id> <registered_callback_url>"; exit 2; fi

ISSUER="https://portal.zada.solutions"
BASE="https://api.zada.solutions/portal/functions/v1"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
warn() { echo "WARN  $1"; }
enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1"; }

# 1. Discovery
DISC=$(curl -s --max-time 15 "$ISSUER/.well-known/openid-configuration")
if echo "$DISC" | grep -q "\"issuer\": *\"$ISSUER\"" && echo "$DISC" | grep -q "$BASE/token"; then
  pass "discovery document reachable, issuer and token endpoint as expected"
else
  fail "discovery document missing or unexpected"
fi

# Callback sanity
case "$CALLBACK" in
  https://*) ;;
  http://localhost:*|http://localhost/*|http://127.0.0.1*) warn "local http callback: fine for development, never register it as production" ;;
  *) fail "callback must be https:// (or http://localhost for development): $CALLBACK" ;;
esac

# 2. Registered callback -> 302 to the ZADA verify page
VERIFIER=$(openssl rand -hex 32)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=')
Q="client_id=$CLIENT_ID&response_type=code&scope=openid&state=smoketest&nonce=smoketest&code_challenge=$CHALLENGE&code_challenge_method=S256"
OUT=$(curl -s --max-time 30 -o /dev/null -w "%{http_code} %{redirect_url}" "$BASE/authorize?$Q&redirect_uri=$(enc "$CALLBACK")")
case "$OUT" in
  "302 https://portal.zada.solutions/verify/"*) pass "callback is registered; /authorize redirects to the ZADA verify page" ;;
  "400"*) fail "/authorize refused the callback (unknown client_id or callback not registered) — register it in ZADA Portal → OAuth Setup" ;;
  "302 "*) fail "/authorize redirected back with an error: ${OUT#302 }" ;;
  *) fail "/authorize unexpected response: $OUT" ;;
esac

# 3. Unregistered callback must be refused without a redirect
BAD="https://unregistered.invalid/zada-smoke-test"
OUT=$(curl -s --max-time 15 -o /dev/null -w "%{http_code}" "$BASE/authorize?$Q&redirect_uri=$(enc "$BAD")")
[ "$OUT" = "400" ] && pass "unregistered callback refused with 400 (no redirect)" || fail "unregistered callback returned $OUT, expected 400"

# 4. Token endpoint enforces the client secret
TOK=$(curl -s --max-time 15 -X POST "$BASE/token" -d grant_type=authorization_code -d code=smoke-test \
  -d client_id="$CLIENT_ID" --data-urlencode redirect_uri="$CALLBACK" -d code_verifier="$VERIFIER")
case "$TOK" in
  *invalid_client*) pass "/token rejects requests without client_secret" ;;
  *invalid_grant*) warn "/token accepted a request without client_secret — no secret is registered yet; generate one in OAuth Setup before going live" ;;
  *) fail "/token unexpected response: $TOK" ;;
esac

echo
if [ $FAIL -eq 0 ]; then
  echo "Automated checks done. Remaining manual step: log in on a phone with the ZADA Wallet and approve."
else
  echo "Some checks failed."
fi
exit $FAIL
