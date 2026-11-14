// Reference implementation: "Log in with ZADA" in Node.js / Express + Postgres (pg).
// npm i express express-session jose pg
// Env: ZADA_CLIENT_ID, ZADA_CLIENT_SECRET, ZADA_REDIRECT_URI (exactly as registered),
//      SESSION_SECRET, DATABASE_URL
//
// Migration (adapt table/column names):
//   ALTER TABLE customers ADD COLUMN zada_sub text;
//   CREATE UNIQUE INDEX customers_zada_sub_key ON customers (zada_sub) WHERE zada_sub IS NOT NULL;
//
// Routes:
//   GET /login/zada            -> redirects the browser to ZADA
//   GET /login/zada/callback   -> ZADA redirects back here (register this exact URL)
//
// Production: use a persistent session store (connect-pg-simple, Redis), not the default MemoryStore.

import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import pg from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = 'https://portal.zada.solutions';
const BASE = 'https://api.zada.solutions/portal/functions/v1';
const JWKS = createRemoteJWKSet(new URL(`${BASE}/oidc-jwks`));

const { ZADA_CLIENT_ID, ZADA_CLIENT_SECRET, ZADA_REDIRECT_URI, SESSION_SECRET, DATABASE_URL } = process.env;
const pool = new pg.Pool({ connectionString: DATABASE_URL });

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const random = () => b64url(crypto.randomBytes(32));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fail = (res, msg, status = 400) => res.status(status).send(`<p>${escapeHtml(msg)}</p><p><a href="/login/zada">Try again</a></p>`);

const app = express();
app.set('trust proxy', 1); // behind a reverse proxy / load balancer, so secure cookies work
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
}));

app.get('/login/zada', (req, res, next) => {
  const state = random();
  const nonce = random();
  const codeVerifier = random();
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  req.session.zada = { state, nonce, codeVerifier };

  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({
    client_id: ZADA_CLIENT_ID,
    redirect_uri: ZADA_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  req.session.save((err) => (err ? next(err) : res.redirect(url.toString())));
});

app.get('/login/zada/callback', async (req, res) => {
  const pending = req.session.zada;
  delete req.session.zada; // state is single-use
  const { code, state, error, error_description } = req.query;

  if (!pending || state !== pending.state) return fail(res, 'Login expired or invalid. Please try again.');
  if (error) return fail(res, `ZADA login failed: ${error_description || error}`);

  try {
    // Exchange the code — server-side, with the secret.
    const tokenRes = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: ZADA_REDIRECT_URI,
        client_id: ZADA_CLIENT_ID,
        client_secret: ZADA_CLIENT_SECRET,
        code_verifier: pending.codeVerifier,
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) return fail(res, `ZADA login failed: ${tokens.error_description || tokens.error}`);

    // Validate the ID token.
    const { payload } = await jwtVerify(tokens.id_token, JWKS, {
      issuer: ISSUER, audience: ZADA_CLIENT_ID, algorithms: ['RS256'],
    });
    if (payload.nonce !== pending.nonce) return fail(res, 'Login invalid. Please try again.');

    const result = await findOrLinkCustomer(payload);
    if (result.error) return fail(res, result.error, 403);

    req.session.regenerate((err) => {
      if (err) return fail(res, 'Session error. Please try again.', 500);
      req.session.customerId = result.id;
      req.session.save(() => res.redirect('/'));
      // Mobile/SPA back end: instead of a cookie session, redirect to your app's deep link with a
      // short-lived one-time code the app exchanges for its own token. Never put tokens in the URL.
    });
  } catch (e) {
    console.error('ZADA login error:', e.message); // never log tokens or claims
    return fail(res, 'Could not complete the login. Please try again.', 502);
  }
});

// Look up by sub; otherwise match ONCE on a verified claim and store sub. Ambiguous or no match:
// refuse (change the no-match branch only if the product wants automatic sign-up).
async function findOrLinkCustomer(claims) {
  const bySub = await pool.query('SELECT id FROM customers WHERE zada_sub = $1', [claims.sub]);
  if (bySub.rows.length) return { id: bySub.rows[0].id };

  let candidates = [];
  const phone = claims.phone_number; // arrives in E.164, e.g. +959xxxxxxxx
  if (phone) {
    const stored = phone.startsWith('+959') ? ['0' + phone.slice(3), phone, phone.slice(1)] : [phone, phone.slice(1)];
    candidates = (await pool.query('SELECT id FROM customers WHERE phone = ANY($1) AND zada_sub IS NULL', [stored])).rows;
  }
  if (!candidates.length && claims.email) {
    candidates = (await pool.query('SELECT id FROM customers WHERE lower(trim(email)) = $1 AND zada_sub IS NULL',
      [claims.email.trim().toLowerCase()])).rows;
  }

  if (candidates.length > 1) return { error: 'More than one account matches your details. Please contact support.' };
  if (candidates.length === 0) return { error: 'No account found for your ZADA ID. Please sign up first, then link ZADA.' };

  await pool.query('UPDATE customers SET zada_sub = $1 WHERE id = $2 AND zada_sub IS NULL', [claims.sub, candidates[0].id]);
  return { id: candidates[0].id };
}

app.listen(process.env.PORT || 3000);
