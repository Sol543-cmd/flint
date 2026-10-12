import * as auth from './auth.js';

const G = 'https://graph.microsoft.com/v1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Offline extends Error { constructor() { super('No connection to OneDrive.'); this.name = 'Offline'; } }

export async function req(url, opts = {}, attempt = 0) {
  const token = await auth.getToken();
  let r;
  try {
    r = await fetch(url.startsWith('http') ? url : G + url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Offline();
  }
  if (r.status === 401 && attempt < 1) { auth.invalidate(); return req(url, opts, attempt + 1); }
  if ([429, 500, 502, 503, 504].includes(r.status) && attempt < 4) {
    const ra = Number(r.headers.get('Retry-After') || 0);
    await sleep(Math.max(ra * 1000, 800 * 2 ** attempt));
    return req(url, opts, attempt + 1);
  }
  return r;
}

export async function err(r) {
  let msg = `OneDrive error ${r.status}`;
  try { const j = await r.json(); if (j.error?.message) msg = j.error.message; } catch { /* ignore */ }
  const e = new Error(msg);
  e.status = r.status;
  return e;
}

async function json(url, opts) {
  const r = await req(url, opts);
  if (!r.ok) throw await err(r);
  return r.json();
}

export const SELECT = 'id,name,folder,file,eTag,cTag,size,lastModifiedDateTime,parentReference,deleted';

export async function listFolders(folderId) {
  let url = folderId ? `/me/drive/items/${folderId}/children?$top=500` : '/me/drive/root/children?$top=500';
  const items = [];
  while (url) {
    const j = await json(url);
    items.push(...j.value);
    url = j['@odata.nextLink'];
  }
  return items;
}

export const rootItem = () => json('/me/drive/root?$select=id,name');
export const me = () => json('/me/drive?$select=owner');

// Downloads a file's bytes plus the metadata (eTag/cTag) it belongs to.
export async function download(id) {
  const r = await req(`/me/drive/items/${id}`);
  if (!r.ok) throw await err(r);
  const item = await r.json();
  const dl = item['@microsoft.graph.downloadUrl'];
  let res;
  if (dl) {
    try { res = await fetch(dl); } catch { res = null; }
  }
  if (!res || !res.ok) {
    res = await req(`/me/drive/items/${id}/content`);
    if (!res.ok) throw await err(res);
  }
  return { bytes: await res.arrayBuffer(), item };
}

// Replace a file's content, but only if it still matches the version we last saw.
export function upload(id, bytes, eTag) {
  return req(`/me/drive/items/${id}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain', ...(eTag ? { 'If-Match': eTag } : {}) },
    body: bytes,
  });
}

// Create a new file at a path inside the vault. Fails (409) if the name is taken.
export function createAt(vaultId, path, bytes) {
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return req(`/me/drive/items/${vaultId}:/${enc}:/content?@microsoft.graph.conflictBehavior=fail`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: bytes,
  });
}

// Rename a file in place. Fails (409) if the name is taken.
export function rename(id, name) {
  return req(`/me/drive/items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, '@microsoft.graph.conflictBehavior': 'fail' }),
  });
}

// Flint's own data file (outside the vault). Returns null if it doesn't exist yet.
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
export async function getJsonByPath(path) {
  const r = await req(`/me/drive/root:/${encPath(path)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw await err(r);
  const item = await r.json();
  const { bytes, item: fresh } = await download(item.id);
  let json = null;
  try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { json = null; }
  return { json, eTag: fresh.eTag || item.eTag };
}
export function putJsonByPath(path, text, eTag) {
  return req(`/me/drive/root:/${encPath(path)}:/content${eTag ? '' : '?@microsoft.graph.conflictBehavior=fail'}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(eTag ? { 'If-Match': eTag } : {}) },
    body: new TextEncoder().encode(text),
  });
}
