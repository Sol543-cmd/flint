// EPUB books: reading the file format, and the Books shelf kept in OneDrive at
// Apps/Flint/Books (outside your vault). Each book is also stored on the device
// so it opens offline.
import * as db from './db.js';
import * as g from './graph.js';

const { JSZip, DOMPurify } = window;
const OPS = 'http://www.idpf.org/2007/ops';
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
function resolve(base, rel) {
  const out = [];
  for (const s of `${base}${decodeURIComponent(rel || '')}`.split('/')) {
    if (s === '..') out.pop(); else if (s && s !== '.') out.push(s);
  }
  return out.join('/');
}
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

// ---------- the EPUB format ----------
export async function openEpub(buf) {
  const zip = await JSZip.loadAsync(buf);
  const container = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = container && /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath || !zip.file(opfPath)) throw new Error('This doesn’t look like an EPUB book.');
  const opf = new DOMParser().parseFromString(await zip.file(opfPath).async('string'), 'application/xml');
  const base = dirOf(opfPath);
  const all = (tag) => [...opf.getElementsByTagNameNS('*', tag)];
  const text = (tag) => all(tag)[0]?.textContent?.trim() || '';
  const manifest = new Map(all('item').map((it) => [it.getAttribute('id'), { href: resolve(base, it.getAttribute('href')), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' }]));
  const spine = all('itemref').map((r) => manifest.get(r.getAttribute('idref'))).filter((m) => m && /html|xml/.test(m.type)).map((m) => m.href);
  if (!spine.length) throw new Error('This book has no readable chapters.');
  let cover = [...manifest.values()].find((m) => m.props.includes('cover-image'))?.href;
  if (!cover) { const id = all('meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content'); cover = id && manifest.get(id)?.href; }
  const book = {
    zip, spine, cover: cover || null,
    title: text('title') || 'Untitled book',
    author: all('creator').map((c) => c.textContent.trim()).filter(Boolean).join(', '),
    publisher: text('publisher'), date: text('date').slice(0, 10), language: text('language'),
    toc: [],
  };
  // Table of contents: EPUB 3 nav document, or EPUB 2 toc.ncx.
  const nav = [...manifest.values()].find((m) => m.props.includes('nav'));
  if (nav && zip.file(nav.href)) {
    const doc = new DOMParser().parseFromString(await zip.file(nav.href).async('string'), 'application/xhtml+xml');
    const tocNav = [...doc.getElementsByTagName('nav')].find((n) => (n.getAttributeNS(OPS, 'type') || n.getAttribute('epub:type') || '').includes('toc')) || doc.getElementsByTagName('nav')[0];
    const walk = (ol, depth) => { for (const li of ol?.children || []) { const a = li.querySelector(':scope > a, :scope > span > a'); if (a) { const [p, anchor] = (a.getAttribute('href') || '').split('#'); book.toc.push({ label: a.textContent.replace(/\s+/g, ' ').trim(), path: resolve(dirOf(nav.href), p), anchor: anchor || '', depth }); } walk(li.querySelector(':scope > ol'), depth + 1); } };
    walk(tocNav?.querySelector('ol'), 0);
  }
  if (!book.toc.length) {
    const ncx = [...manifest.values()].find((m) => /ncx/.test(m.type));
    if (ncx && zip.file(ncx.href)) {
      const doc = new DOMParser().parseFromString(await zip.file(ncx.href).async('string'), 'application/xml');
      const walk = (parent, depth) => { for (const np of [...parent.children].filter((c) => c.localName === 'navPoint')) { const label = np.getElementsByTagNameNS('*', 'text')[0]?.textContent.trim(); const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src') || ''; const [p, anchor] = src.split('#'); if (label) book.toc.push({ label, path: resolve(dirOf(ncx.href), p), anchor: anchor || '', depth }); walk(np, depth + 1); } };
      const map = doc.getElementsByTagNameNS('*', 'navMap')[0];
      if (map) walk(map, 0);
    }
  }
  book.blobUrls = new Map();
  return book;
}

async function blobUrl(book, path) {
  if (book.blobUrls.has(path)) return book.blobUrls.get(path);
  const f = book.zip.file(path);
  if (!f) return '';
  const blob = new Blob([await f.async('arraybuffer')], { type: MIME[path.split('.').pop().toLowerCase()] || '' });
  const url = URL.createObjectURL(blob);
  book.blobUrls.set(path, url);
  return url;
}

// One chapter as clean HTML. Flint's own typography replaces the book's styling.
export async function chapterHtml(book, idx) {
  const path = book.spine[idx];
  const raw = await book.zip.file(path)?.async('string');
  if (raw == null) return '<p>This chapter is missing from the book file.</p>';
  let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(raw, 'text/html');
  const body = doc.body || doc.getElementsByTagName('body')[0];
  if (!body) return '';
  for (const el of body.querySelectorAll('*')) {
    const t = el.getAttributeNS?.(OPS, 'type') || el.getAttribute('epub:type');
    if (t) el.setAttribute('data-epub-type', t);
  }
  for (const im of body.querySelectorAll('image')) { // SVG-wrapped cover images
    const href = im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (href) { const img = doc.createElement('img'); img.setAttribute('src', href); (im.closest('svg') || im).replaceWith(img); }
  }
  for (const img of body.querySelectorAll('img')) img.setAttribute('src', await blobUrl(book, resolve(dirOf(path), img.getAttribute('src'))));
  for (const a of body.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^[a-z]+:/i.test(href)) continue;
    const [p, anchor] = href.split('#');
    a.setAttribute('data-epub-href', `${p ? resolve(dirOf(path), p) : path}#${anchor || ''}`);
    a.setAttribute('href', '#');
  }
  return DOMPurify.sanitize(body.innerHTML, { FORBID_TAGS: ['style', 'link', 'script', 'form'], FORBID_ATTR: ['style', 'class', 'width', 'height'], ADD_ATTR: ['data-epub-href', 'data-epub-type'], ALLOW_UNKNOWN_PROTOCOLS: true });
}

async function coverThumb(book) {
  if (!book.cover) return '';
  try {
    const url = await blobUrl(book, book.cover);
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = 240, h = Math.round((img.naturalHeight / img.naturalWidth) * w) || 360;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.8);
  } catch { return ''; }
}

// ---------- the shelf ----------
let dir = 'Apps/Flint/Books';
export function setDataPath(dataPath) { dir = `${dataPath.split('/').slice(0, -1).join('/')}/Books`; }
export const booksDir = () => dir;
export async function shelf() { return (await db.get('kv', 'books').catch(() => null)) || []; }
async function saveShelf(list) { await db.put('kv', list, 'books'); }
export async function bookFile(id) { return (await db.get('blobs', `book:${id}`).catch(() => null))?.buf || null; }

async function describe(buf, base) {
  const book = await openEpub(buf);
  return { ...base, title: book.title, author: book.author, publisher: book.publisher, date: book.date, chapters: book.spine.length, cover: await coverThumb(book) };
}

// Add a book from a file on this device. Saved locally at once; uploaded when online.
export async function addBook(file) {
  const buf = await file.arrayBuffer();
  const id = `local-${crypto.randomUUID()}`;
  const name = file.name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\.epub$/i, '').trim() || 'Book';
  const entry = await describe(buf, { id, name: `${name}.epub`, pending: true, added: Date.now() });
  await db.put('blobs', { buf }, `book:${id}`);
  const list = await shelf();
  list.push(entry);
  await saveShelf(list);
  return entry;
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
// Bring the shelf up to date with OneDrive: upload new books, download others' books.
export async function syncBooks(onChange) {
  let list = await shelf();
  for (const b of list.filter((x) => x.pending)) {
    const buf = await bookFile(b.id);
    if (!buf) continue;
    const r = await g.req(`/me/drive/root:/${enc(`${dir}/${b.name}`)}:/content?@microsoft.graph.conflictBehavior=rename`, { method: 'PUT', headers: { 'Content-Type': 'application/epub+zip' }, body: buf });
    if (!r.ok) continue;
    const it = await r.json();
    await db.put('blobs', { buf }, `book:${it.id}`);
    await db.del('blobs', `book:${b.id}`);
    Object.assign(b, { oldId: b.id, id: it.id, name: it.name, eTag: it.eTag, pending: false });
    onChange?.({ renamed: [b.oldId, b.id] });
  }
  const r = await g.req(`/me/drive/root:/${enc(dir)}:/children?$select=id,name,eTag,size,file&$top=500`);
  if (r.status === 404) { await saveShelf(list); return list; }
  if (!r.ok) throw await g.err(r);
  const remote = (await r.json()).value.filter((x) => x.file && /\.epub$/i.test(x.name));
  const next = [];
  for (const it of remote) {
    const have = list.find((b) => b.id === it.id);
    if (have && have.eTag === it.eTag && (await bookFile(it.id))) { next.push(have); continue; }
    try {
      const { bytes } = await g.download(it.id);
      await db.put('blobs', { buf: bytes }, `book:${it.id}`);
      next.push(await describe(bytes, { id: it.id, name: it.name, eTag: it.eTag, added: have?.added || Date.now() }));
    } catch { if (have) next.push(have); }
  }
  for (const b of list) if (b.pending) next.push(b);
  for (const b of list) if (!b.pending && !next.some((x) => x.id === b.id)) await db.del('blobs', `book:${b.id}`);
  await saveShelf(next);
  onChange?.({});
  return next;
}

export async function removeBook(id) {
  const list = await shelf();
  const b = list.find((x) => x.id === id);
  if (b && !b.pending) {
    const r = await g.req(`/me/drive/items/${id}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) throw await g.err(r);
  }
  await db.del('blobs', `book:${id}`);
  await saveShelf(list.filter((x) => x.id !== id));
}
