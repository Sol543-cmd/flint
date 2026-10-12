// Flint's own data: notes on highlights, reading queue, bookmarks, pins, reading
// positions and reading stats. It's kept in one small JSON file in OneDrive
// *outside* the vault (Apps/Flint/flint-data.json), so Obsidian never sees it,
// and it syncs between every phone that uses Flint.
//
// Each record carries its own "last changed" time, so edits made on different
// phones merge record by record instead of overwriting each other.
import * as db from './db.js';
import * as g from './graph.js';

const COLS = ['notes', 'queue', 'finished', 'bookmarks', 'pinNotes', 'pinFolders', 'pos'];
const FORMAT = 1;
const TOMBSTONE_DAYS = 180;

let doc = null;
let enabled = true;
export function setEnabled(on) { enabled = on; }
export const isEnabled = () => enabled;
let meta = { last: 0 };
let path = null;
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
const emit = () => { for (const fn of listeners) fn(); };

export const deviceId = (() => {
  let id = localStorage.getItem('flint.device');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('flint.device', id); }
  return id;
})();

function empty() {
  const d = { v: FORMAT, stats: {} };
  for (const c of COLS) d[c] = {};
  return d;
}

export async function load() {
  doc = (await db.get('kv', 'flintdata').catch(() => null)) || empty();
  for (const c of COLS) doc[c] ||= {};
  doc.stats ||= {};
  meta = (await db.get('kv', 'flintdataMeta').catch(() => null)) || { last: 0 };
}

// Where the file lives: Apps/Flint, unless the vault itself would contain that
// folder; then a hidden ".flint" folder inside the vault, which Obsidian ignores.
export function setVaultPath(vaultPath) {
  const inside = vaultPath === '' || 'Apps/Flint'.startsWith(vaultPath) || vaultPath.startsWith('Apps/Flint');
  path = inside ? `${vaultPath ? `${vaultPath}/` : ''}.flint/flint-data.json` : 'Apps/Flint/flint-data.json';
}
export const dataLocation = () => path;
export const lastSynced = () => meta.last;

let saveTimer = null, uploadTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { db.put('kv', doc, 'flintdata'); }, 250);
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => { if (enabled && navigator.onLine) syncData().catch(() => {}); }, 15_000);
}
export async function flush() {
  clearTimeout(saveTimer);
  if (doc) await db.put('kv', doc, 'flintdata');
}

// ---------- records ----------
export function all(col) {
  return Object.entries(doc[col]).filter(([, r]) => !r.del).map(([key, r]) => ({ key, ...r }));
}
export function get(col, key) {
  const r = doc[col][key];
  return r && !r.del ? r : null;
}
export function put(col, key, value, { quiet = false } = {}) {
  doc[col][key] = { ...value, u: Date.now() };
  persist();
  if (!quiet) emit();
}
export function remove(col, key) {
  if (!doc[col][key] || doc[col][key].del) return;
  doc[col][key] = { del: true, u: Date.now() };
  persist();
  emit();
}

// ---------- reading time ----------
export function addReadingTime(day, seconds) {
  const mine = (doc.stats[deviceId] ||= {});
  mine[day] = (mine[day] || 0) + seconds;
  persist();
}
export function secondsByDay() {
  const out = {};
  for (const dev of Object.values(doc.stats)) for (const [d, s] of Object.entries(dev)) out[d] = (out[d] || 0) + s;
  return out;
}

// ---------- merging and syncing ----------
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function merge(a, b) {
  const out = empty();
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86_400_000;
  for (const c of COLS) {
    for (const k of new Set([...Object.keys(a[c] || {}), ...Object.keys(b[c] || {})])) {
      const x = a[c]?.[k], y = b[c]?.[k];
      const win = !x ? y : !y ? x : (y.u > x.u ? y : x);
      if (win.del && win.u < cutoff) continue;
      out[c][k] = win;
    }
  }
  for (const dev of new Set([...Object.keys(a.stats || {}), ...Object.keys(b.stats || {})])) {
    const x = a.stats?.[dev] || {}, y = b.stats?.[dev] || {};
    out.stats[dev] = {};
    for (const d of new Set([...Object.keys(x), ...Object.keys(y)])) out.stats[dev][d] = Math.max(x[d] || 0, y[d] || 0);
  }
  return out;
}

let running = null;
export function syncData() {
  if (!enabled || !path || !doc) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remote = await g.getJsonByPath(path);
      if (remote && remote.json?.v > FORMAT) return; // written by a newer Flint; leave it alone
      const merged = remote?.json ? merge(doc, remote.json) : doc;
      if (stable(merged) !== stable(doc)) { doc = merged; await db.put('kv', doc, 'flintdata'); emit(); }
      if (remote?.json && stable(merged) === stable(remote.json)) break;
      const r = await g.putJsonByPath(path, JSON.stringify(doc), remote?.eTag || null);
      if (r.ok) break;
      if (r.status === 412 || r.status === 409) continue; // someone else saved first: merge again
      throw await g.err(r);
    }
    meta.last = Date.now();
    await db.put('kv', meta, 'flintdataMeta');
  })().finally(() => { running = null; });
  return running;
}

// For backup files.
export const snapshot = () => JSON.parse(JSON.stringify(doc));
export function restore(data) {
  if (!data || typeof data !== 'object') return;
  const incoming = { v: FORMAT, stats: data.stats || {} };
  for (const c of COLS) incoming[c] = data[c] || {};
  doc = merge(doc, incoming);
  persist();
  emit();
}
