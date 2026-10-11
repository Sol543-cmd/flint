// Sign-in for personal Microsoft accounts using the OAuth 2.0
// authorization-code flow with PKCE (no secrets, no server needed).
const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'offline_access Files.ReadWrite';
const K_CLIENT = 'flint.clientId';
const K_TOKENS = 'flint.tokens';

export class AuthNeeded extends Error { constructor(m = 'Sign in to OneDrive to sync.') { super(m); this.name = 'AuthNeeded'; } }

export const clientId = () => localStorage.getItem(K_CLIENT) || '';
export function setClientId(id) {
  localStorage.setItem(K_CLIENT, id.trim());
  localStorage.removeItem(K_TOKENS);
}
export const hasTokens = () => !!localStorage.getItem(K_TOKENS);
export function signOut() { localStorage.removeItem(K_TOKENS); }

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function login({ silent = false } = {}) {
  const verifier = b64url(rand(32));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(rand(16));
  sessionStorage.setItem('flint.pkce', JSON.stringify({ verifier, state, silent }));
  const p = new URLSearchParams({
    client_id: clientId(), response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
    code_challenge: challenge, code_challenge_method: 'S256', state, response_mode: 'query',
    prompt: silent ? 'none' : 'select_account',
  });
  location.assign(`${AUTH}/authorize?${p}`);
}

// Returns 'signed-in', 'silent-failed', or null when the URL isn't a sign-in redirect.
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return null;
  const saved = JSON.parse(sessionStorage.getItem('flint.pkce') || 'null');
  sessionStorage.removeItem('flint.pkce');
  history.replaceState(null, '', redirectUri());
  if (q.has('error')) {
    if (saved?.silent) return 'silent-failed';
    throw new Error(q.get('error_description') || q.get('error'));
  }
  if (!saved || saved.state !== q.get('state')) throw new Error('Sign-in didn’t complete. Try signing in again.');
  await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), code_verifier: saved.verifier, redirect_uri: redirectUri() });
  return 'signed-in';
}

async function tokenRequest(params) {
  const r = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), scope: SCOPES, ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_description || j.error || `Sign-in failed (${r.status})`);
    e.code = j.error;
    throw e;
  }
  const t = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in - 120) * 1000 };
  localStorage.setItem(K_TOKENS, JSON.stringify(t));
  return t;
}

let refreshing = null;
export async function getToken() {
  const t = JSON.parse(localStorage.getItem(K_TOKENS) || 'null');
  if (!t) throw new AuthNeeded();
  if (Date.now() < t.exp) return t.access;
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh })
      .catch((e) => {
        if (e.code === 'invalid_grant' || e.code === 'interaction_required') { signOut(); throw new AuthNeeded('Your OneDrive sign-in expired. Sign in again to sync.'); }
        throw e;
      })
      .finally(() => { refreshing = null; });
  }
  return (await refreshing).access;
}

export function invalidate() {
  const t = JSON.parse(localStorage.getItem(K_TOKENS) || 'null');
  if (t) { t.exp = 0; localStorage.setItem(K_TOKENS, JSON.stringify(t)); }
}
