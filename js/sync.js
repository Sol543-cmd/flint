// Offline-first sync between this device and the vault folder in OneDrive.
//
// Safety rules:
//  * Every note keeps `base` (the exact text last seen in OneDrive) and `local`.
//  * Uploads use If-Match with the version we last saw, so OneDrive refuses
//    the save if the file changed elsewhere. We never blindly overwrite.
//  * When both sides changed, a line-based 3-way merge is tried. If the edits
//    touch the same lines, the note is marked as a conflict and the user picks.
//  * Line endings (LF / CRLF) and a UTF-8 BOM are preserved exactly.
//    Files we can't round-trip byte-for-byte are opened read-only.
//  * Only .md files are ever written. Nothing is renamed, moved or deleted.
import * as db from './db.js';
import * as g from './graph.js';
import { merge3 } from './merge.js';

export const V = {
  vaultId: null, vaultPath: '', lastSync: 0,
  files: new Map(), notes: new Map(), byName: new Map(), alias: new Map(),
  status: 'idle', error: '', progress: null,
};

const listeners = new Set();
export const on = (fn) => listeners.add(fn);
const emit = (type, data) => { for (const fn of listeners) fn(type, data); };
const setStatus = (s, error = '') => { V.status = s; V.error = error; emit('status'); };

export const isMd = (name) => /\.md$/i.test(name);
export const baseName = (p) => p.split('/').pop().replace(/\.md$/i, '');
export const dirName = (p) => p.split('/').slice(0, -1).join('/');
export const resolveId = (id) => V.alias.get(id) || id;
export const pendingCount = () => [...V.notes.values()].filter((n) => n.dirty || n.pendingCreate).length;
export const conflicts = () => [...V.notes.values()].filter((n) => n.conflict);

// ---------- local state ----------
export async function loadLocal() {
  const [files, notes, meta] = await Promise.all([db.all('files'), db.all('notes'), db.get('kv', 'vault')]);
  if (meta) { V.vaultId = meta.id; V.vaultPath = meta.path; V.lastSync = meta.lastSync || 0; }
  V.files = new Map(files.map((f) => [f.id, f]));
  V.notes = new Map(notes.map((n) => [n.id, n]));
  reindex();
}

const key = (s) => s.normalize('NFC').toLowerCase();

export function reindex() {
  V.byName = new Map();
  for (const n of V.notes.values()) {
    const k = key(baseName(n.path));
    if (!V.byName.has(k)) V.byName.set(k, []);
    V.byName.get(k).push(n);
  }
}

// Resolve paths like "../Folder/Note" against the folder of the note they're in.
function joinRelative(from, rel) {
  const parts = from ? from.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

// Resolve a [[link]] target the way Obsidian does: exact path first, then by name
// (shortest path wins). Case-insensitive, and tolerant of Mac/Windows accent encoding.
export function resolveNote(target, fromPath = '') {
  let t = target.trim().replace(/\\/g, '/').replace(/\.md$/i, '');
  if (/^\.\.?\//.test(t)) t = joinRelative(dirName(fromPath), t);
  t = t.replace(/^\/+/, '');
  if (!t) return null;
  const lower = key(t);
  if (t.includes('/')) {
    let best = null;
    for (const n of V.notes.values()) {
      const p = key(n.path.replace(/\.md$/i, ''));
      if (p === lower || p.endsWith('/' + lower)) if (!best || n.path.length < best.path.length) best = n;
    }
    return best;
  }
  const list = V.byName.get(lower);
  if (!list) return null;
  return list.reduce((a, b) => (b.path.length < a.path.length ? b : a));
}

export function resolveFile(name, fromPath = '') {
  let t = name.trim();
  if (/^\.\.?\//.test(t)) t = joinRelative(dirName(fromPath), t);
  const full = key(t.replace(/^\/+/, ''));
  const base = full.split('/').pop();
  let best = null;
  for (const f of V.files.values()) {
    if (f.folder || !f.path) continue;
    const p = key(f.path);
    if (p === full) return f;
    if (key(f.name) === base && (!best || f.path.length < best.path.length)) best = f;
  }
  return best;
}

// Download images that notes embed, so they show offline too.
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
async function prefetchImages() {
  const wanted = new Map();
  for (const n of V.notes.values()) {
    for (const m of n.local.matchAll(/!\[\[([^\]|#\n]+)|!\[[^\]\n]*\]\(<?([^)>\n]+?)>?\)/g)) {
      const name = (m[1] || decodeURISafe(m[2] || '')).trim();
      if (!IMG_EXT.test(name) || /^https?:/i.test(name)) continue;
      const f = resolveFile(name, n.path);
      if (f && f.size < 20_000_000) wanted.set(f.id, f);
    }
  }
  const todo = [];
  for (const f of wanted.values()) {
    const rec = await db.get('blobs', f.id).catch(() => null);
    if (!rec || rec.cTag !== f.cTag) todo.push(f);
  }
  await pool(todo, 3, async (f) => {
    try {
      const { bytes, item } = await g.download(f.id);
      await db.put('blobs', { blob: new Blob([bytes], { type: MIME[f.name.split('.').pop().toLowerCase()] || 'application/octet-stream' }), cTag: item.cTag }, f.id);
    } catch (e) { if (e.name === 'Offline' || e.name === 'AuthNeeded') throw e; }
  });
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
const decodeURISafe = (s) => { try { return decodeURI(s); } catch { return s; } };

// ---------- encoding ----------
export function decode(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return { text: new TextDecoder().decode(buf), eol: '\n', bom: false, readOnly: 'This note isn’t saved as UTF-8 text, so editing is off to keep it exactly as it is.' };
  }
  let bom = false;
  if (text.charCodeAt(0) === 0xfeff) { bom = true; text = text.slice(1); }
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length;
  const loneCr = (text.match(/\r(?!\n)/g) || []).length;
  let eol = '\n', readOnly = null;
  if (crlf > 0 && crlf === lf && !loneCr) { eol = '\r\n'; text = text.replace(/\r\n/g, '\n'); }
  else if (crlf > 0 || loneCr > 0) {
    readOnly = 'This note mixes different line-ending styles, so editing is off to keep it exactly as it is.';
    text = text.replace(/\r\n?/g, '\n');
  }
  return { text, eol, bom, readOnly };
}

function encode(n, text) {
  let s = n.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
  if (n.bom) s = '\uFEFF' + s;
  return new TextEncoder().encode(s);
}

// ---------- writes to the device ----------
const writeTimers = new Map();
export async function saveNote(n) {
  clearTimeout(writeTimers.get(n.id));
  writeTimers.delete(n.id);
  V.notes.set(n.id, n);
  await db.put('notes', n);
}
function queueWrite(n) {
  clearTimeout(writeTimers.get(n.id));
  writeTimers.set(n.id, setTimeout(() => { writeTimers.delete(n.id); db.put('notes', n); }, 300));
}
export async function flushWrites() {
  for (const id of [...writeTimers.keys()]) {
    clearTimeout(writeTimers.get(id));
    writeTimers.delete(id);
    const n = V.notes.get(id);
    if (n) await db.put('notes', n);
  }
}

// Called on every keystroke. Updates memory immediately, disk shortly after.
export function editLocal(id, text) {
  const n = V.notes.get(resolveId(id));
  if (!n || n.readOnly) return false;
  if (n.local === text) return true;
  n.local = text;
  n.dirty = n.pendingCreate || text !== n.base;
  queueWrite(n);
  emit('dirty', n.id);
  schedulePush();
  return true;
}

export async function createNote(path, text = '') {
  const id = 'local:' + crypto.randomUUID();
  const n = { id, path, base: '', local: text, baseETag: null, baseCTag: null, eol: '\n', bom: false, readOnly: null, dirty: true, conflict: null, pendingCreate: true };
  await saveNote(n);
  reindex();
  emit('tree');
  schedulePush();
  return id;
}

export function uniquePath(path) {
  const taken = new Set([...V.notes.values()].map((n) => n.path.toLowerCase()));
  for (const f of V.files.values()) if (f.path) taken.add(f.path.toLowerCase());
  if (!taken.has(path.toLowerCase())) return path;
  const stem = path.replace(/\.md$/i, '');
  for (let k = 1; ; k++) { const p = `${stem} ${k}.md`; if (!taken.has(p.toLowerCase())) return p; }
}

// ---------- vault selection ----------
export async function chooseVault(id, path) {
  await Promise.all([db.clear('files'), db.clear('notes'), db.clear('blobs')]);
  await db.put('kv', { id, path, deltaLink: null, lastSync: 0 }, 'vault');
  V.vaultId = id; V.vaultPath = path; V.lastSync = 0;
  V.files = new Map(); V.notes = new Map(); reindex();
  emit('tree');
}

export async function resetLocal() {
  if (pendingCount() || conflicts().length) throw new Error('Some changes haven’t synced yet.');
  await chooseVault(V.vaultId, V.vaultPath);
}

// ---------- sync ----------
let running = null, again = false, pushTimer = null, lastPull = 0;

export function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync({ quick: true }), 2000);
}

export function sync(opts = {}) {
  if (running) { again = true; return running; }
  running = run(opts).finally(() => {
    running = null;
    if (again) { again = false; setTimeout(() => sync({ quick: true }), 300); }
  });
  return running;
}

async function run({ quick = false } = {}) {
  if (!V.vaultId) return;
  if (!navigator.onLine) { setStatus('offline'); return; }
  setStatus('syncing');
  try {
    if (!quick || Date.now() - lastPull > 30_000) { await pullTree(); lastPull = Date.now(); }
    await pushAll();
    await pullContents();
    await prefetchImages();
    V.lastSync = Date.now();
    const meta = await db.get('kv', 'vault');
    if (meta) { meta.lastSync = V.lastSync; await db.put('kv', meta, 'vault'); }
    setStatus(conflicts().length ? 'conflict' : pendingCount() ? 'pending' : 'ok');
  } catch (e) {
    console.error(e);
    if (e.name === 'AuthNeeded') setStatus('auth', e.message);
    else if (e.name === 'Offline' || e instanceof TypeError) setStatus('offline');
    else setStatus('error', e.message);
  } finally {
    V.progress = null;
    emit('progress');
  }
}

async function crawl() {
  const items = [];
  const queue = [V.vaultId];
  while (queue.length) {
    const batch = queue.splice(0, 4);
    await Promise.all(batch.map(async (id) => {
      let url = `/me/drive/items/${id}/children?$select=${g.SELECT}&$top=500`;
      while (url) {
        const r = await g.req(url);
        if (!r.ok) throw await g.err(r);
        const j = await r.json();
        for (const it of j.value) {
          items.push(it);
          if (it.folder && !it.name.startsWith('.')) queue.push(it.id);
        }
        url = j['@odata.nextLink'];
      }
    }));
  }
  return items;
}

async function pullTree() {
  const meta = (await db.get('kv', 'vault')) || { id: V.vaultId, path: V.vaultPath };
  let full = !meta.deltaLink;
  const changed = new Map();
  const removed = new Set();
  let deltaLink = null;

  if (meta.noDelta) {
    full = true;
    for (const it of await crawl()) changed.set(it.id, it);
  } else {
    let url = meta.deltaLink || `/me/drive/items/${V.vaultId}/delta?$select=${g.SELECT}`;
    while (url) {
      const r = await g.req(url);
      if (r.status === 410 && meta.deltaLink) { meta.deltaLink = null; await db.put('kv', meta, 'vault'); return pullTree(); }
      if (!r.ok) {
        if (full && [400, 403, 404, 501].includes(r.status)) { meta.noDelta = true; await db.put('kv', meta, 'vault'); return pullTree(); }
        throw await g.err(r);
      }
      const j = await r.json();
      for (const it of j.value) {
        if (it.deleted) { removed.add(it.id); changed.delete(it.id); } else { changed.set(it.id, it); removed.delete(it.id); }
      }
      url = j['@odata.nextLink'];
      if (j['@odata.deltaLink']) deltaLink = j['@odata.deltaLink'];
    }
  }

  const all = full ? new Map() : new Map([...V.files].map(([k, v]) => [k, { ...v }]));
  for (const id of removed) all.delete(id);
  for (const it of changed.values()) {
    if (it.id === V.vaultId) continue;
    all.set(it.id, {
      id: it.id, name: it.name, parentId: it.parentReference?.id, folder: !!it.folder,
      eTag: it.eTag, cTag: it.cTag, size: it.size, mtime: it.lastModifiedDateTime,
    });
  }
  // Build paths relative to the vault; drop anything outside it or in hidden folders (.obsidian, .trash…).
  const memo = new Map([[V.vaultId, '']]);
  const pathOf = (id, depth = 0) => {
    if (memo.has(id)) return memo.get(id);
    const f = all.get(id);
    if (!f || depth > 64) { memo.set(id, null); return null; }
    const pp = pathOf(f.parentId, depth + 1);
    const p = pp === null ? null : pp ? `${pp}/${f.name}` : f.name;
    memo.set(id, p);
    return p;
  };
  for (const [id, f] of all) {
    const p = pathOf(id);
    if (p === null || p.split('/').some((s) => s.startsWith('.'))) all.delete(id);
    else f.path = p;
  }

  V.files = all;
  await db.replaceAll('files', [...all.values()]);
  if (deltaLink) meta.deltaLink = deltaLink;
  await db.put('kv', meta, 'vault');

  // Reconcile notes with the new file list.
  for (const n of [...V.notes.values()]) {
    if (n.pendingCreate) continue;
    const f = all.get(n.id);
    if (!f || !isMd(f.name)) {
      if (n.dirty || n.conflict) {
        // Deleted or moved out of the vault elsewhere, but has unsynced edits here: keep them.
        n.pendingCreate = true; n.deletedRemote = true; n.conflict = null;
        await saveNote(n);
      } else {
        V.notes.delete(n.id);
        await db.del('notes', n.id);
      }
    } else if (f.path !== n.path) {
      n.path = f.path;
      await saveNote(n);
    }
  }
  reindex();
  emit('tree');
}

async function pushAll() {
  for (const n of [...V.notes.values()]) {
    if (n.conflict || n.readOnly) continue;
    if (n.pendingCreate) await pushCreate(n);
    else if (n.dirty) await pushNote(n);
  }
}

function setConflict(n, text, item) {
  n.conflict = { text, eTag: item.eTag, cTag: item.cTag, at: Date.now() };
  emit('note', { id: n.id, external: false });
}

async function pushNote(n, attempt = 0) {
  const snap = n.local;
  const r = await g.upload(n.id, encode(n, snap), n.baseETag);
  if (r.ok) {
    const it = await r.json();
    n.base = snap; n.baseETag = it.eTag; n.baseCTag = it.cTag;
    n.dirty = n.local !== snap;
    const f = V.files.get(n.id);
    if (f) { f.eTag = it.eTag; f.cTag = it.cTag; }
    await saveNote(n);
    emit('saved', n.id);
    return;
  }
  if (r.status === 412 && attempt < 3) {
    // Changed in the vault since we last looked. Try to merge both sets of edits.
    const { bytes, item } = await g.download(n.id);
    const d = decode(bytes);
    if (d.readOnly) { setConflict(n, d.text, item); await saveNote(n); return; }
    const m = merge3(n.base, snap, d.text);
    if (!m.ok) { setConflict(n, d.text, item); await saveNote(n); emit('conflict', n.id); return; }
    let next = m.text;
    if (n.local !== snap) { // typed more while we were busy
      const m2 = merge3(snap, n.local, m.text);
      if (!m2.ok) { setConflict(n, d.text, item); await saveNote(n); emit('conflict', n.id); return; }
      next = m2.text;
    }
    n.base = d.text; n.baseETag = item.eTag; n.baseCTag = item.cTag; n.eol = d.eol; n.bom = d.bom;
    n.local = next;
    n.dirty = n.local !== n.base;
    await saveNote(n);
    emit('note', { id: n.id, external: true });
    if (n.dirty) return pushNote(n, attempt + 1);
    return;
  }
  if (r.status === 404) {
    n.pendingCreate = true; n.deletedRemote = true;
    await saveNote(n);
    return pushCreate(n);
  }
  throw await g.err(r);
}

async function pushCreate(n) {
  let path = n.path;
  for (let k = 0; k < 50; k++) {
    const snap = n.local;
    const r = await g.createAt(V.vaultId, path, encode(n, snap));
    if (r.ok) {
      const it = await r.json();
      const oldId = n.id;
      clearTimeout(writeTimers.get(oldId)); writeTimers.delete(oldId);
      V.notes.delete(oldId);
      await db.del('notes', oldId);
      Object.assign(n, { id: it.id, path, base: snap, baseETag: it.eTag, baseCTag: it.cTag, pendingCreate: false, deletedRemote: false });
      n.dirty = n.local !== snap;
      V.alias.set(oldId, it.id);
      V.files.set(it.id, { id: it.id, name: it.name, parentId: it.parentReference?.id, folder: false, eTag: it.eTag, cTag: it.cTag, size: it.size, path });
      await db.put('files', V.files.get(it.id));
      await saveNote(n);
      reindex();
      emit('renamed', { from: oldId, to: it.id });
      return;
    }
    if (r.status === 409) { // a file with that name already exists in the vault
      const stem = n.path.replace(/\.md$/i, '');
      path = `${stem} ${k + 1}.md`;
      continue;
    }
    throw await g.err(r);
  }
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

async function pullContents() {
  const todo = [];
  for (const f of V.files.values()) {
    if (f.folder || !isMd(f.name)) continue;
    const n = V.notes.get(f.id);
    if (!n || (!n.dirty && !n.conflict && n.baseCTag !== f.cTag)) todo.push(f);
  }
  if (!todo.length) return;
  let done = 0;
  V.progress = { done, total: todo.length };
  emit('progress');
  await pool(todo, 4, async (f) => {
    const { bytes, item } = await g.download(f.id);
    const d = decode(bytes);
    const cur = V.notes.get(f.id);
    if (!(cur && (cur.dirty || cur.conflict))) { // skip if it was edited here meanwhile; the upload path will merge
      const n = { id: f.id, path: f.path, base: d.text, local: d.text, baseETag: item.eTag, baseCTag: item.cTag, eol: d.eol, bom: d.bom, readOnly: d.readOnly, dirty: false, conflict: null, pendingCreate: false };
      await saveNote(n);
      emit('note', { id: n.id, external: true });
    }
    V.progress = { done: ++done, total: todo.length };
    emit('progress');
  });
  reindex();
  emit('tree');
}

// ---------- conflict resolution ----------
export async function resolveConflict(id, choice) {
  const n = V.notes.get(resolveId(id));
  if (!n?.conflict) return;
  const c = n.conflict;
  if (choice === 'both') {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    await createNote(uniquePath(n.path.replace(/\.md$/i, ` (conflict ${stamp}).md`)), n.local);
  }
  if (choice === 'both' || choice === 'theirs') {
    Object.assign(n, { base: c.text, local: c.text, baseETag: c.eTag, baseCTag: c.cTag, dirty: false, conflict: null });
  } else if (choice === 'mine') {
    // Treat the vault version as the new base; our text becomes the change to upload.
    Object.assign(n, { base: c.text, baseETag: c.eTag, baseCTag: c.cTag, conflict: null });
    n.dirty = n.local !== n.base;
  }
  await saveNote(n);
  emit('note', { id: n.id, external: true });
  sync({ quick: true });
}
