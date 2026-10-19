// Small IndexedDB wrapper. Stores:
//   kv     – settings, vault info, sync cursors
//   files  – OneDrive item metadata for everything in the vault
//   notes  – note text (last synced version + local version)
//   blobs  – cached images for offline viewing
const NAME = 'flint';
const VERSION = 1;
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });

export async function get(store, key) {
  const d = await open();
  return req(d.transaction(store).objectStore(store).get(key));
}
export async function all(store) {
  const d = await open();
  return req(d.transaction(store).objectStore(store).getAll());
}
export async function put(store, value, key) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  key === undefined ? t.objectStore(store).put(value) : t.objectStore(store).put(value, key);
  return done(t);
}
export async function del(store, key) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  t.objectStore(store).delete(key);
  return done(t);
}
export async function replaceAll(store, values) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  const s = t.objectStore(store);
  s.clear();
  for (const v of values) s.put(v);
  return done(t);
}
export async function clear(store) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  t.objectStore(store).clear();
  return done(t);
}
export async function has(store, key) {
  const d = await open();
  return (await req(d.transaction(store).objectStore(store).getKey(key))) !== undefined;
}
