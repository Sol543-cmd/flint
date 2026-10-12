import * as db from './db.js';
import * as auth from './auth.js';
import * as g from './graph.js';
import * as sy from './sync.js';
import { V } from './sync.js';
import { renderMarkdown, esc, FRONTMATTER, isRealTag } from './markdown.js';
import { linkScripture, logosUrl } from './scripture.js';
import { planHighlight, planRemove, normalize, occurrences, hiddenRanges, listHighlights } from './highlight.js';
import { findSource, composeCopy, STYLES, isFootnoteStyle } from './cite.js';
import { buildDocx } from './docxexport.js';
import * as fd from './flintdata.js';
import { Listener, buildSentences, supported as ttsSupported, voices as ttsVoices } from './listen.js';

const $ = (s) => document.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = (n) => String(n).padStart(2, '0');
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`flint.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(`flint.${k}`, JSON.stringify(v)),
};

// ---------- preferences (stored on this phone only, never in notes) ----------
const FONTS = {
  literata: ['Literata', '"Literata Variable", Georgia, serif', 1],
  sourceserif: ['Source Serif', '"Source Serif 4 Variable", Georgia, serif', 1],
  garamond: ['EB Garamond', '"EB Garamond Variable", Garamond, serif', 1.12],
  baskerville: ['Baskerville', '"Libre Baskerville", Baskerville, serif', 0.94],
  merriweather: ['Merriweather', '"Merriweather Variable", Georgia, serif', 0.95],
  bitter: ['Bitter', '"Bitter Variable", Rockwell, serif', 0.98],
  georgia: ['Georgia', 'Georgia, "Times New Roman", serif', 1],
  atkinson: ['Atkinson Hyperlegible', '"Atkinson Hyperlegible", system-ui, sans-serif', 1],
  system: ['System sans', 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 1],
  dyslexic: ['OpenDyslexic', 'OpenDyslexic, system-ui, sans-serif', 0.9],
};
const SIZES = [14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 29, 32];
const WEIGHTS = [400, 500, 600, 700];
const SPACING = { tight: 1.42, normal: 1.65, loose: 1.95 };
const MARGINS = { narrow: 16, normal: 30, wide: 52 };
const DEFAULTS = {
  font: 'literata', size: 5, weight: 0, theme: 'auto', spacing: 'normal', margin: 'normal', align: 'left',
  layout: 'pages', anim: 'slide', progress: 'page', clock: 'on',
  htmlMode: 'text', hideLangs: 'dataview, dataviewjs, tasks, query, button, meta-bind-button, tracker',
  openIn: 'read', hiddenTags: '',
  print: { paper: 'letter', orient: 'portrait', margin: 'normal', font: 'serif', size: 'normal', spacing: 'single', title: true, source: true, highlights: true, images: true },
  exportTo: 'save', citeStyle: 'mla', citeKind: 'bib', citeExcerpt: true,
  nightOn: 'off', nightTheme: 'dark', nightFrom: '20:00', nightTo: '07:00',
  listenRate: 1, listenVoice: '', dataSync: 'on', columns: 'auto',
  scripture: 'on', logosMode: 'app', bibleVersion: '',
};
const P = { ...DEFAULTS, ...store.get('prefs', {}) };
P.print = { ...DEFAULTS.print, ...(P.print || {}) };
const savePrefs = () => store.set('prefs', P);
const langSet = () => new Set(P.hideLangs.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const fsPx = () => Math.round(SIZES[P.size] * (FONTS[P.font] || FONTS.literata)[2]);

// Night theme: switches automatically between the chosen times.
function effectiveTheme() {
  if (P.nightOn !== 'on') return P.theme;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const toMin = (t) => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
  const a = toMin(P.nightFrom), b = toMin(P.nightTo);
  const night = a === b ? false : a < b ? mins >= a && mins < b : mins >= a || mins < b;
  return night ? P.nightTheme : P.theme;
}

function applyPrefs() {
  const r = document.documentElement;
  const f = FONTS[P.font] || FONTS.literata;
  r.style.setProperty('--read', f[1]);
  r.style.setProperty('--fs', `${fsPx()}px`);
  r.style.setProperty('--wt', WEIGHTS[P.weight]);
  r.style.setProperty('--lh', SPACING[P.spacing]);
  r.style.setProperty('--m', `${MARGINS[P.margin]}px`);
  r.style.setProperty('--align', P.align);
  r.dataset.theme = effectiveTheme();
  $('#rdCols').dataset.align = P.align;
  $('#reader').dataset.layout = P.layout;
  $('#reader').dataset.anim = P.anim;
  $('meta[name=theme-color]').content = getComputedStyle(r).getPropertyValue('--bg').trim();
  syncAaSheet();
  updateClock();
}

// ---------- state ----------
const S = {
  view: 'home', current: null, editorId: null, mode: 'read', ov: [],
  recent: store.get('recent', []),
  openFolders: new Set(store.get('open', [])),
};
const cur = () => (S.current ? V.notes.get(sy.resolveId(S.current)) : null);
function addRecent(id) { S.recent = [id, ...S.recent.filter((x) => x !== id)].slice(0, 30); store.set('recent', S.recent); }
// Reading positions sync between phones through Flint's own data file.
const posMap = () => Object.fromEntries(fd.all('pos').map((r) => [r.key, r.f]));
const savePosFor = (id, frac) => {
  const f = Math.round(Math.max(0, Math.min(1, frac)) * 10000) / 10000;
  if (fd.get('pos', id)?.f === f) return;
  fd.put('pos', id, { f }, { quiet: true });
};

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

// ---------- overlays and the back gesture ----------
let modalResolve = null;
let folderResolve = null;
const popWaiters = [];
const OV = {
  drawer: { show() { $('#drawer').hidden = false; renderTree(); }, hide() { $('#drawer').hidden = true; } },
  aa: { show() { $('#sheetAa').hidden = false; syncAaSheet(); }, hide() { $('#sheetAa').hidden = true; } },
  toc: { show() { $('#sheetToc').hidden = false; }, hide() { $('#sheetToc').hidden = true; } },
  folder: { show() { $('#sheetFolder').hidden = false; }, hide() { $('#sheetFolder').hidden = true; } },
  more: { show() { $('#sheetMore').hidden = false; }, hide() { $('#sheetMore').hidden = true; } },
  note: { show() { $('#sheetNote').hidden = false; }, hide() { $('#sheetNote').hidden = true; } },
  stats: { show() { $('#sheetStats').hidden = false; }, hide() { $('#sheetStats').hidden = true; } },
  define: { show() { $('#sheetDefine').hidden = false; }, hide() { $('#sheetDefine').hidden = true; } },
  books: { show() { $('#sheetBooks').hidden = false; }, hide() { $('#sheetBooks').hidden = true; if (S.view === 'notebook') renderNotebook(); } },
  print: { show() { $('#sheetPrint').hidden = false; }, hide() { $('#sheetPrint').hidden = true; } },
  cite: { show() { $('#sheetCite').hidden = false; }, hide() { $('#sheetCite').hidden = true; } },
  folders: {
    show() { $('#sheetFolders').hidden = false; },
    hide() { $('#sheetFolders').hidden = true; if (folderResolve) { const r = folderResolve; folderResolve = null; r(null); } },
  },
  settings: { show() { fillSettings(); $('#settings').hidden = false; }, hide() { $('#settings').hidden = true; } },
  modal: {
    show() { $('#modal').hidden = false; },
    hide() { $('#modal').hidden = true; if (modalResolve) { const r = modalResolve; modalResolve = null; r(null); } },
  },
};
function updateScrim() {
  const top = S.ov[S.ov.length - 1];
  $('#scrim').hidden = !['drawer', 'aa', 'toc', 'modal', 'folders', 'folder', 'more', 'print', 'cite', 'note', 'stats', 'define', 'books'].includes(top);
  $('#scrim').style.zIndex = top === 'drawer' ? 40 : 60;
  document.body.classList.toggle('lock', S.ov.length > 0);
}
function pushOv(name) {
  hidePop();
  hideChrome();
  OV[name].show();
  S.ov.push(name);
  history.pushState({ ...(history.state || {}), ov: S.ov.length }, '');
  updateScrim();
}
const popOv = () => new Promise((res) => { if (!S.ov.length) return res(); popWaiters.push(res); history.back(); });
function dropAllOv() { while (S.ov.length) OV[S.ov.pop()].hide(); updateScrim(); }

window.addEventListener('popstate', (e) => {
  if (S.ov.length) {
    OV[S.ov.pop()].hide();
    updateScrim();
    while (popWaiters.length) popWaiters.shift()();
    return;
  }
  const st = e.state || {};
  const leaving = S.curState;
  if (st.v === 'note' && V.notes.has(sy.resolveId(st.id))) openNote(st.id, { history: 'none', mode: st.mode });
  else if (st.v === 'tags') showTags(st.tag || null, 'none', st.y || 0);
  else if (st.v === 'pinned') showPinned('none', st.y || 0);
  else if (st.v === 'notebook') showNotebook('none', st.y || 0, { note: st.note, book: st.book });
  else if (st.v === 'queue') showQueue('none', st.y || 0);
  else showHome('none', st.y || 0);
  // Going back from a note opened in a folder popup reopens that popup.
  if (leaving?.v === 'note' && typeof leaving.fromFolder === 'string' && !(st.v === 'note' && st.id === leaving.id)) openFolderSheet(leaving.fromFolder);
});

function ask({ label, value = '', ok = 'OK', hint = '', input = true, placeholder = '' }) {
  return new Promise((resolve) => {
    $('#modalLabel').textContent = label;
    const inp = $('#modalInput');
    inp.hidden = !input; inp.value = value; inp.placeholder = placeholder;
    $('#modalHint').textContent = hint; $('#modalHint').hidden = !hint;
    $('#modalOk').textContent = ok;
    modalResolve = resolve;
    pushOv('modal');
    if (input) setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}

// ---------- rendering ----------
const renderNote = (text, fromPath = '') => renderMarkdown(text, {
  htmlMode: P.htmlMode, hideLangs: langSet(), resolve: (t) => !!sy.resolveNote(t, fromPath),
});
const missing = (text) => { const s = document.createElement('span'); s.className = 'missing'; s.textContent = text; return s; };
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
const blobUrls = new Map();

async function loadImage(img, target, fromPath) {
  const [link, size] = target.split('|');
  const name = link.split('#')[0];
  if (size && /^\d+(x\d+)?$/.test(size)) img.style.width = `${size.split('x')[0]}px`;
  const f = sy.resolveFile(name, fromPath);
  if (!f) { img.replaceWith(missing(`${name.split('/').pop()} isn’t in this vault`)); return; }
  const key = f.id + f.cTag;
  const show = (blob) => { if (!blobUrls.has(key)) blobUrls.set(key, URL.createObjectURL(blob)); img.src = blobUrls.get(key); };
  if (blobUrls.has(key)) { img.src = blobUrls.get(key); return; }
  let rec = null;
  try { rec = await db.get('blobs', f.id); } catch { /* ignore */ }
  if (rec && (rec.cTag === f.cTag || !navigator.onLine)) return show(rec.blob);
  if (!navigator.onLine) { img.replaceWith(missing('Image shows when you’re online')); return; }
  try {
    const { bytes, item } = await g.download(f.id);
    const blob = new Blob([bytes], { type: MIME[f.name.split('.').pop().toLowerCase()] || 'application/octet-stream' });
    db.put('blobs', { blob, cTag: item.cTag }, f.id).catch(() => {});
    show(blob);
  } catch {
    if (rec) show(rec.blob); else img.replaceWith(missing('Image couldn’t load'));
  }
}

const headingKey = (s) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function sectionOf(text, sub) {
  const body = text.replace(FRONTMATTER, '');
  if (!sub) return body;
  const lines = body.split('\n');
  if (sub.startsWith('^')) {
    const id = sub.slice(1);
    const i = lines.findIndex((l) => new RegExp(`\\s\\^${id.replace(/[^\w-]/g, '')}\\s*$`).test(l));
    if (i < 0) return body;
    let a = i, b = i;
    while (a > 0 && lines[a - 1].trim()) a--;
    while (b < lines.length - 1 && lines[b + 1].trim()) b++;
    return lines.slice(a, b + 1).join('\n');
  }
  const want = headingKey(sub.split('#').pop());
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start < 0 && headingKey(m[2]) === want) { start = i; level = m[1].length; continue; }
    if (start >= 0 && m[1].length <= level) return lines.slice(start, i).join('\n');
  }
  return start >= 0 ? lines.slice(start).join('\n') : body;
}

function calloutify(bq) {
  const p = bq.firstElementChild;
  if (!p || p.tagName !== 'P') return;
  const m = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n<]*)(?:<br>\n?|\n)?/.exec(p.innerHTML);
  if (!m) return;
  const type = m[1].toLowerCase();
  const tmp = document.createElement('span');
  tmp.innerHTML = m[3];
  const title = tmp.textContent.trim() || type[0].toUpperCase() + type.slice(1);
  p.innerHTML = p.innerHTML.slice(m[0].length);
  if (!p.innerHTML.trim()) p.remove();
  bq.classList.add('callout');
  bq.dataset.callout = type;
  const h = document.createElement('div');
  h.className = 'callout-title';
  h.textContent = title;
  bq.prepend(h);
}

function hydrate(root, n, depth = 0) {
  $$(':scope blockquote', root).forEach(calloutify);
  $$('img[data-embed]', root).forEach((img) => loadImage(img, img.dataset.embed, n.path));
  $$('span.embed[data-embed]', root).forEach((sp) => {
    const raw = sp.dataset.embed;
    const hash = raw.indexOf('#');
    const page = hash < 0 ? raw : raw.slice(0, hash);
    const sub = hash < 0 ? '' : raw.slice(hash + 1);
    const t = page ? sy.resolveNote(page, n.path) : n;
    if (!t) { sp.replaceChildren(missing(`${page.split('/').pop()} isn’t in this vault`)); return; }
    const name = sy.baseName(t.path);
    if (depth >= 1 || (t.id === n.id && !sub)) {
      sp.innerHTML = `<a class="wikilink" href="#" data-target="${esc(page)}" data-sub="${esc(sub)}">${esc(name)}</a>`;
      return;
    }
    sp.innerHTML = `<div class="embed-head"><a class="wikilink" href="#" data-target="${esc(page || name)}" data-sub="${esc(sub)}">${esc(name)}${sub ? ` › ${esc(sub.replace(/^\^/, ''))}` : ''}</a></div>${renderNote(sectionOf(t.local, sub), t.path)}`;
    hydrate(sp, t, depth + 1);
  });
  $$('a.wikilink:not([data-sub])', root).forEach((a) => { a.dataset.sub = a.dataset.heading || ''; });
  $$('a[href]:not(.wikilink):not(.tag)', root).forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  // Reading never changes files except highlights, so checkboxes are display-only here.
  $$('input[type=checkbox]', root).forEach((b) => { b.disabled = true; });
  if (depth === 0 && P.scripture === 'on') linkScripture(root, { mode: P.logosMode, version: P.bibleVersion });
}

// ---------- views ----------
function showView(v) {
  S.view = v;
  $('#home').hidden = v !== 'home';
  $('#tagsView').hidden = v !== 'tags';
  $('#pinnedView').hidden = v !== 'pinned';
  $('#notebookView').hidden = v !== 'notebook';
  $('#queueView').hidden = v !== 'queue';
  if (v !== 'reader') stopListening();
  $('#reader').hidden = v !== 'reader';
  $('#editorView').hidden = v !== 'editor';
  document.body.dataset.view = v;
  $$('.modeswitch [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === (v === 'editor' ? 'edit' : 'read'))));
  if (v !== 'reader') hidePop();
}

function leaveNote() {
  closeEditor();
  saveReaderPos();
  S.current = null;
  R.id = null;
}

function showHome(h = 'push', y = 0) {
  leaveNote();
  S.curState = { v: 'home' };
  if (h === 'push') history.pushState({ v: 'home' }, '');
  else if (h === 'replace') history.replaceState({ v: 'home' }, '');
  showView('home');
  renderHome();
  window.scrollTo(0, y);
}

// ---------- tags ----------
const TAG_RE = /(?<![^\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
const tagCache = new Map();
function noteTags(n) {
  const hit = tagCache.get(n.id);
  if (hit && hit.text === n.local) return hit.tags;
  const text = n.local;
  const tags = new Set();
  const hidden = hiddenRanges(text);
  const code = [...text.matchAll(/(`+)[^`\n][\s\S]*?\1/g)].map((m) => [m.index, m.index + m[0].length]);
  // Link addresses, HTML and web addresses can contain "#" without it being a tag.
  const skip = [...text.matchAll(/\]\([^)\n]*\)|<[^>\n]*>|\bhttps?:\/\/\S+|\[\[[^\]\n]*\]\]/g)].map((m) => [m.index, m.index + m[0].length]);
  const inside = (i) => [hidden, code, skip].some((list) => list.some(([a, b]) => i >= a && i < b));
  for (const m of text.matchAll(TAG_RE)) {
    const t = m[1].replace(/\/+$/, '');
    if (!inside(m.index) && isRealTag(t)) tags.add(t);
  }
  // Tags in the note's properties (frontmatter): "tags: [a, b]", "tags: a, b" or a "- a" list.
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm) {
    const lines = fm[1].split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(tags?)\s*:\s*(.*)$/i.exec(lines[i]);
      if (!m) continue;
      let vals = [];
      if (m[2].trim()) vals = m[2].replace(/^\[|\]$/g, '').split(/[,\s]+/);
      else for (let j = i + 1; j < lines.length && /^\s*-\s*/.test(lines[j]); j++) vals.push(lines[j].replace(/^\s*-\s*/, ''));
      for (const v of vals) { const t = v.trim().replace(/^["']|["']$/g, '').replace(/^#/, ''); if (t && isRealTag(t)) tags.add(t); }
    }
  }
  tagCache.set(n.id, { text, tags });
  return tags;
}
function tagHidden(k) {
  return P.hiddenTags.split(',').map((x) => x.trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
    .some((h) => (h.endsWith('*') ? k.startsWith(h.slice(0, -1)) : k === h || k.startsWith(`${h}/`)));
}
function allTags() {
  const map = new Map();
  for (const n of V.notes.values()) {
    for (const t of noteTags(n)) {
      const k = t.normalize('NFC').toLowerCase();
      if (tagHidden(k)) continue;
      if (!map.has(k)) map.set(k, { name: t, notes: new Set() });
      map.get(k).notes.add(n.id);
    }
  }
  return map;
}

function showTags(tag = null, h = 'push', y = 0) {
  leaveNote();
  const state = { v: 'tags', tag };
  S.curState = state;
  if (h === 'push') history.pushState(state, '');
  else if (h === 'replace') history.replaceState(state, '');
  showView('tags');
  renderTags(tag);
  window.scrollTo(0, y);
}

function renderTags(tag) {
  const tags = allTags();
  const list = $('#tagList');
  const filter = $('#tagFilter');
  if (!tag) {
    $('#tagsTitle').textContent = 'Tags';
    filter.hidden = false;
    const q = filter.value.trim().replace(/^#/, '').toLowerCase();
    const rows = [...tags.entries()].filter(([k]) => !q || k.includes(q)).sort((a, b) => byName(a[1].name, b[1].name));
    $('#tagsSub').textContent = tags.size ? `${tags.size} tag${tags.size === 1 ? '' : 's'} in your vault` : '';
    list.innerHTML = rows.length
      ? rows.map(([, t]) => `<li><button data-tag="${esc(t.name)}"><span class="r-name"><span>#${esc(t.name)}</span><span class="count">${t.notes.size}</span></span></button></li>`).join('')
      : `<li class="empty">${tags.size ? 'No tags match.' : 'No tags found in your notes yet.'}</li>`;
    return;
  }
  // One tag: notes with it, including nested tags like #study/greek under #study.
  const key = tag.normalize('NFC').toLowerCase();
  const ids = new Set();
  for (const [k, t] of tags) if (k === key || k.startsWith(`${key}/`)) t.notes.forEach((id) => ids.add(id));
  const notes = [...ids].map((id) => V.notes.get(id)).filter(Boolean).sort((a, b) => byName(sy.baseName(a.path), sy.baseName(b.path)));
  $('#tagsTitle').textContent = `#${tag}`;
  filter.hidden = true;
  $('#tagsSub').innerHTML = `<span class="tag-head">#${esc(tag)}</span><br>${notes.length} note${notes.length === 1 ? '' : 's'} · <button class="linkbtn" data-hidetag="${esc(tag)}">Hide this tag</button>`;
  list.innerHTML = notes.length
    ? notes.map((n) => `<li><button data-open="${esc(n.id)}" data-backlabel="#${esc(tag)}"><span class="r-name">${esc(sy.baseName(n.path))}</span><span class="r-meta">${esc(sy.dirName(n.path) || 'Vault root')}</span></button></li>`).join('')
    : '<li class="empty">No notes have this tag any more.</li>';
}

function renderHome() {
  if (S.view !== 'home') return;
  $('#homeVault').textContent = V.vaultPath.split('/').pop() || 'OneDrive';
  const count = V.notes.size;
  const st = readingSummary();
  $('#homeSub').textContent = st.today >= 60 || st.streak > 1
    ? [st.today >= 60 ? `${fmtTime(st.today)} read today` : 'Nothing read yet today', st.streak > 1 ? `${st.streak}-day streak` : ''].filter(Boolean).join(', ')
    : count
      ? `${count} note${count === 1 ? '' : 's'} on this phone${V.lastSync ? `, synced ${ago(V.lastSync)}` : ''}`
      : V.status === 'offline' ? 'Connect to the internet to download your notes.' : 'Getting your notes ready…';
  const qn = fd.all('queue').filter((q) => q.status === 'toread' && V.notes.has(sy.resolveId(q.key))).length;
  $('#queueCount').textContent = qn ? String(qn) : '';
  renderReview();
  const alerts = [];
  if (V.status === 'auth') alerts.push('<button class="alert" data-a="signin">Your OneDrive sign-in expired. Tap to sign in again. Everything stays readable meanwhile.</button>');
  for (const n of sy.conflicts()) alerts.push(`<button class="alert" data-open="${esc(n.id)}" data-openmode="edit">“${esc(sy.baseName(n.path))}” changed in your vault and here. Tap to choose what to keep.</button>`);
  if (V.progress) {
    const { done, total } = V.progress;
    alerts.push(`<div class="alert info">Saving notes for offline reading: ${done} of ${total}<div class="progress"><div style="width:${(done / total) * 100}%"></div></div></div>`);
  }
  const pend = sy.pendingCount();
  if (V.status === 'offline') alerts.push(`<div class="alert info">You’re offline, so this is your vault as of the last sync${V.lastSync ? ` (${ago(V.lastSync)})` : ''}.${pend ? ` ${pend} edited note${pend === 1 ? '' : 's'} will sync when you’re back online.` : ''}</div>`);
  if (V.status === 'error') alerts.push(`<button class="alert" data-a="sync">Sync stopped: ${esc(V.error)} Tap to try again.</button>`);
  $('#homeAlerts').innerHTML = alerts.join('');

  const last = V.notes.get(sy.resolveId(store.get('last', '')));
  const card = $('#continueCard');
  card.hidden = !last;
  if (last) {
    const frac = posMap()[last.id] || 0;
    $('#cTitle').textContent = sy.baseName(last.path);
    $('#cMeta').textContent = `${Math.round(frac * 100)}% read${sy.dirName(last.path) ? `, in ${sy.dirName(last.path)}` : ''}`;
    $('#cBar').style.width = `${Math.max(2, frac * 100)}%`;
    card.dataset.open = last.id;
  }
  const rec = S.recent.map((id) => V.notes.get(sy.resolveId(id))).filter((n) => n && n !== last).slice(0, 15);
  $('#recent').hidden = !rec.length && !!last;
  $('#recent').previousElementSibling.hidden = !rec.length && !!last;
  $('#recent').innerHTML = rec.length
    ? rec.map((n) => `<li><button data-open="${esc(n.id)}"><span class="r-name">${esc(sy.baseName(n.path))}</span><span class="r-meta">${esc(sy.dirName(n.path) || 'Vault root')}${n.dirty || n.pendingCreate ? ', not synced yet' : ''}</span></button></li>`).join('')
    : `<li class="empty">${count ? 'Notes you open will show up here. Tap Files to browse your vault.' : ''}</li>`;
}

// ---------- pins (kept in Flint only, never written to the vault) ----------
const pins = () => ({
  folders: fd.all('pinFolders').sort((a, b) => a.at - b.at).map((r) => ({ id: r.id || null, path: r.path })),
  notes: fd.all('pinNotes').sort((a, b) => a.at - b.at).map((r) => r.key),
});
const folderKey = (pf) => pf.id || `path:${pf.path}`;
function savePins(p) {
  for (const r of fd.all('pinNotes')) if (!p.notes.includes(r.key)) fd.remove('pinNotes', r.key);
  p.notes.forEach((id, i) => { if (!fd.get('pinNotes', id)) fd.put('pinNotes', id, { at: Date.now() + i }); });
  const keep = new Set(p.folders.map(folderKey));
  for (const r of fd.all('pinFolders')) if (!keep.has(r.key)) fd.remove('pinFolders', r.key);
  p.folders.forEach((pf, i) => { if (!fd.get('pinFolders', folderKey(pf))) fd.put('pinFolders', folderKey(pf), { id: pf.id, path: pf.path, at: Date.now() + i }); });
}
const folderIdByPath = (path) => { for (const f of V.files.values()) if (f.folder && f.path === path) return f.id; return null; };
const pinPath = (pf) => { const f = pf.id && V.files.get(pf.id); return f && f.folder ? f.path : pf.path; };
const isNotePinned = (id) => pins().notes.includes(id);
const isFolderPinned = (path) => pins().folders.some((pf) => pinPath(pf) === path);
function toggleNotePin(id) {
  const p = pins();
  const on = !p.notes.includes(id);
  p.notes = on ? [...p.notes, id] : p.notes.filter((x) => x !== id);
  savePins(p);
  return on;
}
function toggleFolderPin(path) {
  const p = pins();
  const on = !isFolderPinned(path);
  p.folders = on ? [...p.folders, { id: folderIdByPath(path), path }] : p.folders.filter((pf) => pinPath(pf) !== path);
  savePins(p);
  return on;
}
const folderLabel = (path) => (path ? path.split('/').pop() : 'Vault root');

function showPinned(h = 'push', y = 0) {
  leaveNote();
  S.curState = { v: 'pinned' };
  if (h === 'push') history.pushState({ v: 'pinned' }, '');
  else if (h === 'replace') history.replaceState({ v: 'pinned' }, '');
  showView('pinned');
  renderPinned();
  window.scrollTo(0, y);
}
function renderPinned() {
  if (S.view !== 'pinned') return;
  const p = pins();
  const known = new Set(['', ...allFolders()]);
  const unpin = (attr, val, label) => `<button class="unpin" ${attr}="${esc(val)}" aria-label="Unpin ${esc(label)}"><svg class="ic"><use href="#i-x"/></svg></button>`;
  const folders = p.folders.map(pinPath);
  $('#pinFolders').innerHTML = folders.length
    ? folders.map((path) => `<li><button data-folderopen="${esc(path)}"><span class="r-name r-folder"><svg class="ic"><use href="#i-folder"/></svg>${esc(folderLabel(path))}</span><span class="r-meta">${known.has(path) ? esc(sy.dirName(path) || 'Vault root') : 'Not found in the vault any more'}</span></button>${unpin('data-unpinfolder', path, folderLabel(path))}</li>`).join('')
    : '<li class="empty">To pin a folder, find it with Search, open it, and tap the pin.</li>';
  const notes = p.notes.map((id) => [id, V.notes.get(sy.resolveId(id))]);
  $('#pinNotes').innerHTML = notes.length
    ? notes.map(([id, n]) => (n
      ? `<li><button data-open="${esc(n.id)}" data-backlabel="Pinned"><span class="r-name">${esc(sy.baseName(n.path))}</span><span class="r-meta">${esc(sy.dirName(n.path) || 'Vault root')}</span></button>${unpin('data-unpinnote', id, sy.baseName(n.path))}</li>`
      : `<li><button disabled><span class="r-name">Missing note</span><span class="r-meta">It may have been deleted from the vault</span></button>${unpin('data-unpinnote', id, 'missing note')}</li>`)).join('')
    : '<li class="empty">To pin a note, open it, tap the middle of the page, and tap the pin at the top.</li>';
}

// ---------- folder popup ----------
const FS = { path: '' };
function openFolderSheet(path) {
  FS.path = path;
  renderFolderSheet();
  if (S.ov[S.ov.length - 1] !== 'folder') pushOv('folder');
}
function renderFolderSheet() {
  const path = FS.path;
  $('#fsName').textContent = folderLabel(path);
  $('#fsPath').textContent = path.includes('/') ? sy.dirName(path) : path ? 'Vault root' : '';
  $('#fsUp').hidden = !path;
  $('#fsPin').setAttribute('aria-pressed', String(isFolderPinned(path)));
  $('#fsPin').setAttribute('aria-label', isFolderPinned(path) ? 'Unpin this folder' : 'Pin this folder');
  const subs = allFolders().filter((f) => sy.dirName(f) === path && f !== path);
  const notes = [...V.notes.values()].filter((n) => sy.dirName(n.path) === path).sort((a, b) => byName(sy.baseName(a.path), sy.baseName(b.path)));
  $('#fsList').innerHTML = [
    ...subs.map((f) => `<li><button data-fsfolder="${esc(f)}"><svg class="ic"><use href="#i-folder"/></svg><span class="nm">${esc(folderLabel(f))}</span><svg class="ic note"><use href="#i-right"/></svg></button></li>`),
    ...notes.map((n) => `<li><button data-fsnote="${esc(n.id)}"><svg class="ic note"><use href="#i-note"/></svg><span class="nm">${esc(sy.baseName(n.path))}</span></button></li>`),
  ].join('') || '<li class="empty">This folder is empty.</li>';
  $('#fsList').scrollTop = 0;
}

function openNote(id, { history: h = 'push', mode, target = null, keepOv = false, backTo = null, backLabel = null, fromFolder = null } = {}) {
  id = sy.resolveId(id);
  const n = V.notes.get(id);
  if (!n) { toast('That note isn’t on this phone yet. It will appear after the next sync.'); return false; }
  // Remember where a list was scrolled, so Back returns to the same spot.
  if (h === 'push' && ['home', 'tags', 'pinned', 'notebook', 'queue'].includes(S.view) && !S.ov.length) history.replaceState({ ...(history.state || {}), y: scrollY }, '');
  closeEditor();
  saveReaderPos();
  if (!keepOv && S.ov.length) { dropAllOv(); if (h === 'push') h = 'replace'; }
  S.current = id;
  addRecent(id);
  store.set('last', id);
  const m = mode || P.openIn;
  const state = { v: 'note', id, mode: m, backTo, backLabel, fromFolder };
  S.curState = state;
  if (h === 'push') history.pushState(state, '');
  else if (h === 'replace') history.replaceState(state, '');
  if (m === 'edit') { showView('editor'); loadEditor(n); } else { showView('reader'); loadReader(n, target); }
  return true;
}

function setMode(m) {
  const n = cur();
  if (!n) return;
  if (m === 'edit' && n.readOnly) { toast('Editing is off for this note.'); return; }
  if ((m === 'edit') === (S.view === 'editor')) return;
  if (m === 'edit') {
    const frac = readerFrac();
    saveReaderPos();
    showView('editor');
    loadEditor(n);
    requestAnimationFrame(() => window.scrollTo(0, frac * (document.documentElement.scrollHeight - innerHeight)));
  } else {
    const h = document.documentElement.scrollHeight - innerHeight;
    const frac = h > 0 ? scrollY / h : 0;
    closeEditor();
    savePosFor(n.id, frac);
    showView('reader');
    loadReader(n);
  }
  history.replaceState({ ...(history.state || {}), v: 'note', id: n.id, mode: m }, '');
}

// ---------- reader ----------
const R = { id: null, page: 0, total: 1, step: 1, words: 0, chrome: false, swipedAt: 0, selAtDown: false };

function loadReader(n, target = null) {
  R.id = n.id;
  R.frac = null;
  R.anchor = null;
  const name = sy.baseName(n.path);
  const body = n.local.replace(FRONTMATTER, '');
  $('#rdTitle').textContent = name;
  $('#rdTitle').hidden = /^\s*# /.test(body);
  $('#rdStatusTitle').textContent = name;
  $('#rdChromeTitle').textContent = sy.dirName(n.path) ? `${sy.dirName(n.path)} / ${name}` : name;
  const content = $('#rdContent');
  if (body.trim()) {
    content.innerHTML = renderNote(n.local, n.path);
    hydrate(content, n);
  } else content.innerHTML = '<p class="empty">This note is empty. Switch to Edit to start writing.</p>';
  renderReaderBanner(n);
  renderLinks(n);
  R.words = (content.textContent.match(/\S+/g) || []).length;
  $$('img', content).forEach((img) => img.addEventListener('load', relayoutSoon, { once: true }));
  const back = history.state?.backTo ? V.notes.get(sy.resolveId(history.state.backTo)) : null;
  const backText = history.state?.backGone ? '' : back ? `“${sy.baseName(back.path)}”` : history.state?.backLabel || '';
  $('#rdBack').hidden = !backText;
  $('#rdBack').classList.remove('fading');
  R.backTurns = 0;
  R.backScrolled = 0;
  if (backText) $('#rdBack').textContent = `‹ Back to ${backText}`;
  $('[data-pinnote]').setAttribute('aria-pressed', String(isNotePinned(n.id)));
  R.src = findSource(n.local, name);
  stopListening();
  R.finishedMarked = false;
  R.readSeconds = 0;
  R.lastAct = Date.now();
  decorateMarks();
  hideChrome();
  layout();
  if (target) goToTarget(target);
  else setFrac(posMap()[n.id] || 0, false);
}

function rerenderReader() {
  const n = cur();
  if (!n || S.view !== 'reader') return;
  const frac = readerFrac();
  savePosFor(n.id, frac);
  loadReader(n);
}

// Pages are laid out as CSS columns inside a clipping box. On wide screens
// (or when chosen) two columns show side by side, like an open book.
function useTwoColumns(W, H) {
  if (P.layout !== 'pages') return false;
  if (P.columns === 'two') return W >= 560;
  if (P.columns === 'auto') return W >= 880 && W / H > 1.15;
  return false;
}
function layout() {
  const fr = $('#rdFrame'), clip = $('#rdClip'), cols = $('#rdCols');
  document.documentElement.style.setProperty('--pageH', `${fr.clientHeight}px`);
  if (P.layout === 'scroll') {
    cols.removeAttribute('style');
    clip.removeAttribute('style');
    R.total = 1;
    R.two = false;
    return;
  }
  fr.scrollTop = 0;
  const W = fr.clientWidth, H = fr.clientHeight;
  const m = MARGINS[P.margin];
  const two = useTwoColumns(W, H);
  const gap = two ? Math.round(Math.max(48, m * 1.6)) : Math.max(40, m);
  const maxCol = fsPx() * 34;
  const cw = Math.floor(two ? Math.min((W - 2 * m - gap) / 2, maxCol) : Math.min(W - 2 * m, maxCol));
  const box = two ? 2 * cw + gap : cw;
  Object.assign(clip.style, { position: 'absolute', top: '0', bottom: '0', left: `${Math.floor((W - box) / 2)}px`, width: `${box}px`, overflow: 'hidden' });
  Object.assign(cols.style, { width: `${box}px`, height: `${H}px`, columnWidth: `${cw}px`, columnGap: `${gap}px` });
  R.two = two;
  R.step = box + gap;
  R.total = Math.max(1, Math.ceil((cols.scrollWidth + gap) / R.step - 0.02));
  $('#reader').classList.toggle('spread', two);
}

function readerFrac() {
  if (!R.id) return 0;
  if (P.layout === 'scroll') {
    const fr = $('#rdFrame');
    const h = fr.scrollHeight - fr.clientHeight;
    return h > 0 ? fr.scrollTop / h : 0;
  }
  return R.total > 1 ? R.page / (R.total - 1) : 0;
}
function setFrac(frac, animate) {
  if (P.layout === 'scroll') {
    const fr = $('#rdFrame');
    fr.scrollTop = frac * (fr.scrollHeight - fr.clientHeight);
    updateProgress();
  } else goPage(Math.round(frac * (R.total - 1)), animate);
}
function saveReaderPos() { if (R.id && S.view === 'reader') savePosFor(R.id, readerFrac()); }

function goPage(p, animate = true) {
  R.page = Math.max(0, Math.min(R.total - 1, p));
  const cols = $('#rdCols');
  const anim = animate && P.anim === 'slide';
  if (!anim) cols.style.transition = 'none';
  cols.style.transform = `translateX(${-R.page * R.step}px)`;
  if (!anim) { void cols.offsetWidth; cols.style.transition = ''; }
  updateProgress();
  if (R.id) savePosFor(R.id, readerFrac());
}
// The floating Back button steps aside once you're reading: after two page
// turns or a bit of scrolling. Android's Back gesture still works.
function dismissBack() {
  const b = $('#rdBack');
  if (b.hidden || b.classList.contains('fading')) return;
  b.classList.add('fading');
  setTimeout(() => { b.hidden = true; b.classList.remove('fading'); }, 250);
  if (history.state?.v === 'note') history.replaceState({ ...history.state, backGone: true }, '');
}
function turn(d) {
  hidePop();
  R.anchor = null;
  if (!$('#rdBack').hidden && ++R.backTurns >= 2) dismissBack();
  if (P.layout !== 'pages') return;
  if ((d > 0 && R.page >= R.total - 1) || (d < 0 && R.page <= 0)) return;
  goPage(R.page + d);
  hideChrome();
}

function updateProgress() {
  const frac = readerFrac();
  R.frac = frac;
  R.lastAct = Date.now();
  updateRibbon();
  checkFinished(frac);
  const pages = P.layout === 'pages';
  const atEnd = pages ? R.page >= R.total - 1 : frac > 0.995;
  const mins = Math.ceil((R.words * (1 - (pages ? (R.page + 1) / R.total : frac))) / 230);
  const label = {
    page: pages ? `Page ${R.page + 1} of ${R.total}` : `${Math.round(frac * 100)}%`,
    time: atEnd ? 'End of note' : mins < 1 ? 'Less than a minute left in note' : `${mins} min left in note`,
    percent: `${Math.round(frac * 100)}%`,
    none: '',
  }[P.progress];
  $('#rdProg').textContent = label;
  const scrub = $('#rdScrub');
  if (pages) { scrub.max = String(Math.max(0, R.total - 1)); scrub.value = String(R.page); $('#rdScrubLabel').textContent = `Page ${R.page + 1} of ${R.total}`; }
  else { scrub.max = '100'; scrub.value = String(Math.round(frac * 100)); $('#rdScrubLabel').textContent = `${Math.round(frac * 100)}%`; }
}

function relayout() {
  if (!R.id || S.view !== 'reader') return;
  if (R.anchor?.isConnected && Date.now() < R.anchorUntil) { layout(); showElement(R.anchor, { flash: false }); return; }
  const frac = R.frac ?? readerFrac();
  layout();
  setFrac(frac, false);
}
let relayoutTimer;
function relayoutSoon() { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(relayout, 120); }

function showChrome() {
  R.chrome = true;
  $('#reader').classList.add('show-chrome');
  $$('#layoutSwitch [data-layoutpick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layoutpick === P.layout)));
  updateProgress();
  hidePop();
}
function setLayout(v) {
  if (P.layout === v) return;
  const frac = R.frac ?? readerFrac();
  P.layout = v;
  savePrefs();
  applyPrefs();
  layout();
  setFrac(frac, false);
  $$('#layoutSwitch [data-layoutpick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layoutpick === v)));
}
function hideChrome() { R.chrome = false; $('#reader').classList.remove('show-chrome'); }

function updateClock() {
  const c = $('#rdClock');
  if (!c) return;
  c.textContent = P.clock === 'on' ? new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

function pageOf(el) {
  if (P.layout !== 'pages') return 0;
  const cols = $('#rdCols').getBoundingClientRect();
  return Math.max(0, Math.min(R.total - 1, Math.floor((el.getBoundingClientRect().left - cols.left + 1) / R.step)));
}
// Jump to an element. When anchored, Flint keeps it in view while fonts and
// images finish loading (they can move it to a different page).
function showElement(el, { anchor = false, flash = true } = {}) {
  if (!el) return;
  if (P.layout === 'pages') goPage(pageOf(el), false);
  else {
    const fr = $('#rdFrame');
    fr.scrollTop += el.getBoundingClientRect().top - fr.getBoundingClientRect().top - fr.clientHeight / 4;
    updateProgress();
  }
  if (anchor) { R.anchor = el; R.anchorUntil = Date.now() + 8000; }
  if (flash) { el.classList.remove('target-flash'); void el.offsetWidth; el.classList.add('target-flash'); }
}
function findTarget(sub) {
  const root = $('#rdContent');
  if (!sub) return null;
  if (sub.startsWith('^')) {
    const a = root.querySelector(`[data-block="${CSS.escape(sub.slice(1))}"]`);
    return a?.closest('p, li, blockquote, td, h1, h2, h3, h4, h5, h6') || a;
  }
  const want = headingKey(sub.split('#').pop());
  return $$('h1,h2,h3,h4,h5,h6', root).find((h) => headingKey(h.textContent) === want) || null;
}
function goToTarget(sub) {
  if (sub && typeof sub === 'object') {
    if (sub.frac != null) { setFrac(sub.frac, false); return; }
    const info = (R.marks || []).find((x) => x.text.toLowerCase() === sub.hl.toLowerCase() && x.occ === (sub.occ || 0))
      || (R.marks || []).find((x) => x.text.toLowerCase().includes(sub.hl.toLowerCase()));
    if (info) requestAnimationFrame(() => showElement(info.mark, { anchor: true })); else setFrac(0, false);
    return;
  }
  const el = findTarget(sub);
  if (el) requestAnimationFrame(() => showElement(el, { anchor: true }));
  else setFrac(0, false);
}

function renderReaderBanner(n) {
  const b = $('#rdBanner');
  if (n.conflict) {
    b.innerHTML = '<div class="banner"><p><strong>This note changed in your vault while it was also edited here.</strong> Nothing has been overwritten. Switch to Edit to choose which version to keep.</p></div>';
  } else if (n.readOnly) b.innerHTML = `<div class="banner info"><p>${esc(n.readOnly)}</p></div>`;
  else b.innerHTML = '';
}

function renderLinks(n) {
  const box = $('#rdLinks');
  const hits = backlinks(n);
  box.hidden = !hits.length;
  box.innerHTML = hits.length ? `<h2>Linked mentions (${hits.length})</h2><ul class="rows">${hits.map((h) => `<li><button data-open="${esc(h.o.id)}"><span class="r-name">${esc(sy.baseName(h.o.path))}</span><span class="r-snip">${esc(h.line)}</span></button></li>`).join('')}</ul>` : '';
}

function backlinks(n) {
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = sy.baseName(n.path);
  const pats = [escRe(n.path.replace(/\.md$/i, ''))];
  if (sy.resolveNote(name)?.id === n.id) pats.push(escRe(name));
  const re = new RegExp(`\\[\\[(?:${pats.join('|')})(?:\\.md)?(?:#[^\\]|]*)?(?:\\\\?\\|[^\\]]*)?\\]\\]`, 'i');
  const hits = [];
  for (const o of V.notes.values()) {
    if (o.id === n.id) continue;
    const m = re.exec(o.local.normalize('NFC'));
    if (!m) continue;
    const ls = o.local.lastIndexOf('\n', m.index) + 1;
    let le = o.local.indexOf('\n', m.index);
    if (le < 0) le = o.local.length;
    hits.push({ o, line: o.local.slice(ls, le).replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/^[\s>*\-+#]+/, '').slice(0, 160) });
  }
  return hits.sort((a, b) => sy.baseName(a.o.path).localeCompare(sy.baseName(b.o.path)));
}

// Links: [[Note]], [[Note|alias]], [[Note#Heading]], [[Note#^block]], [[#Heading]], [text](Note.md)
async function followLink(target, sub) {
  const from = cur();
  if (!target) { const el = findTarget(sub); if (el) showElement(el); else toast('That heading isn’t in this note.'); return; }
  let n = sy.resolveNote(target, from?.path || '');
  if (!n) {
    const attach = sy.resolveFile(target, from?.path || '');
    if (attach) { toast(`“${attach.name}” is an attachment. Open it from OneDrive.`); return; }
    const name = await ask({ label: 'This note doesn’t exist yet', value: target.split('/').pop(), ok: 'Create note', hint: 'It will be created in your vault and opened for writing.' });
    if (name === null) return;
    const folder = target.includes('/') ? target.split('/').slice(0, -1).join('/') : '';
    const id = await sy.createNote(sy.uniquePath(`${folder ? folder + '/' : ''}${cleanName(name) || 'Untitled'}.md`), '');
    openNote(id, { mode: 'edit' });
    return;
  }
  if (from && n.id === from.id) { const el = findTarget(sub); if (el) showElement(el); return; }
  history.replaceState({ ...(history.state || {}), v: 'note', id: from?.id, mode: 'read' }, '');
  openNote(n.id, { mode: 'read', target: sub || null, backTo: from?.id || null });
}

async function openScripture(a) {
  if (P.logosMode === 'app' && !P.bibleVersion) {
    const v = await ask({ label: 'Which Bible should Logos open?', placeholder: 'ESV', ok: 'Save', hint: 'Use the abbreviation Logos uses, like ESV, NIV2011, NASB95, CSB or LEB. You can change this in Settings.' });
    if (!v) return;
    P.bibleVersion = v.trim().toUpperCase();
    savePrefs();
  }
  const [abbr, rest] = a.dataset.ref.split(' ');
  const [ch, v] = rest.split(':');
  const url = logosUrl({ abbr, ch, v }, { mode: P.logosMode, version: P.bibleVersion });
  if (url.startsWith('http')) window.open(url, '_blank', 'noopener');
  else window.location.href = url;
}

function onReaderTap(e) {
  if (R.selAtDown || !getSelection().isCollapsed) return;
  if (Date.now() - R.swipedAt < 450) return;
  if (e.target.closest('[data-open], [data-res]')) return;
  const a = e.target.closest('a');
  if (a) {
    e.preventDefault();
    if (a.classList.contains('scripture')) openScripture(a);
    else if (a.classList.contains('wikilink')) followLink(a.dataset.target, a.dataset.sub);
    else if (a.classList.contains('tag')) { saveReaderPos(); showTags(a.dataset.tag); }
    else if ((a.getAttribute('href') || '').startsWith('#')) {
      // In-page anchors, such as footnote links in notes converted from Word.
      let id = a.getAttribute('href').slice(1);
      try { id = decodeURIComponent(id); } catch { /* keep as is */ }
      const content = $('#rdContent');
      const el = id && (content.querySelector(`[id="${CSS.escape(id)}"], [name="${CSS.escape(id)}"]`) || findTarget(id));
      if (el) showElement(el); else toast('That link points to a spot that isn’t in this note.');
    }
    else if (a.href) window.open(a.href, '_blank', 'noopener');
    return;
  }
  const mark = e.target.closest('mark');
  if (mark && !mark.closest('.embed') && $('#rdContent').contains(mark)) { showRemovePop(mark); return; }
  if (!$('#hlPop').hidden) { hidePop(); return; }
  if (R.chrome) { hideChrome(); return; }
  const x = e.clientX / $('#rdFrame').clientWidth;
  if (P.layout === 'pages' && x < 0.28) turn(-1);
  else if (P.layout === 'pages' && x > 0.72) turn(1);
  else showChrome();
}

function bindReader() {
  const fr = $('#rdFrame');
  let sx = 0, sy0 = 0;
  fr.addEventListener('pointerdown', () => { R.selAtDown = !getSelection().isCollapsed; });
  fr.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy0 = e.touches[0].clientY; }, { passive: true });
  fr.addEventListener('touchend', (e) => {
    if (!getSelection().isCollapsed || P.layout !== 'pages') return;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy0;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) { R.swipedAt = Date.now(); turn(dx < 0 ? 1 : -1); }
  }, { passive: true });
  fr.addEventListener('click', onReaderTap);
  fr.addEventListener('touchmove', () => { R.anchor = null; R.userScrollAt = Date.now(); }, { passive: true });
  fr.addEventListener('wheel', () => { R.anchor = null; R.userScrollAt = Date.now(); }, { passive: true });
  fr.addEventListener('scroll', () => {
    // Only count scrolling you did yourself, not jumps to a highlight or heading.
    if (P.layout === 'scroll' && Date.now() - (R.userScrollAt || 0) < 800) {
      R.backScrolled += Math.abs(fr.scrollTop - (R.lastScrollTop ?? fr.scrollTop));
      if (R.backScrolled > fr.clientHeight * 0.6) dismissBack();
    }
    R.lastScrollTop = fr.scrollTop;
  }, { passive: true });
  fr.addEventListener('scroll', () => { if (P.layout === 'scroll') { updateProgress(); hidePop(); clearTimeout(R.saveT); R.saveT = setTimeout(saveReaderPos, 300); } }, { passive: true });
  $('#rdBanner').addEventListener('click', (e) => { if (e.target.closest('[data-res]')) setMode('edit'); });
  $('#rdFoot').onclick = () => {
    const order = ['page', 'time', 'percent', 'none'];
    P.progress = order[(order.indexOf(P.progress) + 1) % order.length];
    savePrefs(); updateProgress(); syncAaSheet();
  };
  $('#rdBack').onclick = () => history.back();
  $('#rdScrub').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#rdScrubLabel').textContent = P.layout === 'pages' ? `Page ${v + 1} of ${R.total}` : `${v}%`;
    if (P.layout === 'scroll') setFrac(v / 100, false);
  });
  $('#rdScrub').addEventListener('change', (e) => { if (P.layout === 'pages') goPage(Number(e.target.value), false); });
  document.addEventListener('keydown', (e) => {
    if (S.view !== 'reader' || S.ov.length || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    // Keyboards and Bluetooth page-turner remotes. Volume and media keys are included
    // for the rare browser that passes them through; phone browsers normally don't.
    const NEXT = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'AudioVolumeDown', 'MediaTrackNext', 'MediaFastForward'];
    const PREV = ['ArrowLeft', 'ArrowUp', 'PageUp', 'AudioVolumeUp', 'MediaTrackPrevious', 'MediaRewind'];
    const dir = NEXT.includes(e.key) ? 1 : PREV.includes(e.key) ? -1 : 0;
    if (!dir) return;
    if (P.layout === 'pages') { e.preventDefault(); turn(e.shiftKey && e.key === ' ' ? -1 : dir); }
  });
  document.addEventListener('selectionchange', () => { clearTimeout(R.selT); R.selT = setTimeout(onSelection, 180); });
  $('#hlPop').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#hlPop').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pop]');
    if (!b) return;
    const act = b.dataset.pop;
    if (act === 'hl') return addHighlight();
    if (act === 'note') return addHighlight({ thenNote: true });
    if (act === 'remove') return removeHighlight();
    if (act === 'tobook') { const info = (R.marks || []).find((x) => x.mark === R.popMark); hidePop(); if (info) openBookPicker({ noteId: R.id, text: info.text, occ: info.occ }); return; }
    if (act === 'editnote') { const info = (R.marks || []).find((x) => x.mark === R.popMark); hidePop(); if (info) openNoteEditor({ noteId: R.id, text: info.text, occ: info.occ }); return; }
    const excerpt = normalize(getSelection().toString()).trim();
    hidePop();
    if (!excerpt) return;
    if (act === 'define') { getSelection().removeAllRanges(); defineWord(excerpt); return; }
    if (act === 'cite') { getSelection().removeAllRanges(); openCite(excerpt); return; }
    try { await navigator.clipboard.writeText(excerpt); toast('Copied.'); } catch { toast('Copying isn’t allowed here. Use the phone’s own Copy instead.'); }
    getSelection().removeAllRanges();
  });
  window.addEventListener('resize', relayoutSoon);
  document.fonts?.ready.then(relayoutSoon);
  setInterval(updateClock, 20_000);
}

// ---------- highlights: the only thing reading writes back to the note ----------
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'TD', 'TH', 'UL', 'OL', 'HR', 'SECTION', 'DETAILS', 'FIGURE', 'DL', 'DT', 'DD']);
function flatText(root) {
  let out = '';
  const walk = (node) => {
    if (node.nodeType === 3) { out += node.data; return; }
    if (node.nodeType !== 1) return;
    if (node.matches('.embed, .callout-title, script, style')) return;
    if (node.tagName === 'BR') { out += '\n'; return; }
    const block = BLOCK_TAGS.has(node.tagName);
    if (block) out += '\n';
    for (const c of node.childNodes) walk(c);
    if (block) out += '\n';
  };
  walk(root);
  return out;
}
const contentMarks = (root) => $$('mark', root).filter((m) => !m.closest('.embed'));

function hidePop() { $('#hlPop').hidden = true; R.popMode = null; R.popMark = null; }
function popButtons(list) {
  $('#hlPop').classList.toggle('compact', list.length > 3);
  $('#hlPop').innerHTML = list.map(([act, icon, label]) => `<button data-pop="${act}">${list.length > 3 ? '' : `<svg class="ic"><use href="#i-${icon}"/></svg>`}${esc(label)}</button>`).join('');
}
function placePop(rect) {
  const pop = $('#hlPop');
  pop.hidden = false;
  const w = pop.offsetWidth || 150, h = pop.offsetHeight || 44;
  let top = rect.bottom + 14;
  if (top + h > innerHeight - 60) top = Math.max(60, rect.top - h - 14);
  pop.style.top = `${top}px`;
  pop.style.left = `${Math.max(10, Math.min(innerWidth - w - 10, rect.left + rect.width / 2 - w / 2))}px`;
}
function onSelection() {
  if (S.view !== 'reader' || S.ov.length) return;
  const sel = getSelection();
  if (sel.isCollapsed || !sel.rangeCount) { if (R.popMode === 'add') hidePop(); return; }
  const range = sel.getRangeAt(0);
  const content = $('#rdContent');
  if (!content.contains(range.commonAncestorContainer)) { if (R.popMode === 'add') hidePop(); return; }
  hideChrome();
  R.popMode = 'add';
  R.lastAct = Date.now();
  const word = normalize(sel.toString()).trim();
  const single = /^[\p{L}][\p{L}'’-]{0,39}$/u.test(word);
  popButtons([
    ['hl', 'marker', 'Highlight'],
    ['note', 'note2', 'Note'],
    R.src ? ['cite', 'quote', 'Cite'] : ['copy', 'copy', 'Copy'],
    ...(single ? [['define', 'define', 'Define']] : []),
  ]);
  placePop(range.getBoundingClientRect());
}
function showRemovePop(mark) {
  R.popMode = 'remove';
  R.popMark = mark;
  const info = (R.marks || []).find((x) => x.mark === mark);
  const has = info && findAnn(R.id, info.text, info.occ);
  popButtons([['editnote', 'note2', has ? 'Edit note' : 'Add note'], ['tobook', 'book', 'Notebook'], ['remove', 'x', 'Remove']]);
  placePop(mark.getBoundingClientRect());
}

function canWrite(n) {
  if (n.readOnly) { toast('This note can’t be changed, so highlighting is off.'); return false; }
  if (n.conflict) { toast('This note needs a sync choice first. Switch to Edit to resolve it.'); return false; }
  return true;
}

// Re-render the planned text and confirm that exactly the intended change happened.
function verifyHighlight(n, newText, delta, norm) {
  const before = document.createElement('div');
  before.innerHTML = renderNote(n.local, n.path);
  const after = document.createElement('div');
  after.innerHTML = renderNote(newText, n.path);
  if (normalize(flatText(after)).replace(/\s/g, '') !== normalize(flatText(before)).replace(/\s/g, '')) return false;
  const b = contentMarks(before), a = contentMarks(after);
  if (a.length !== b.length + delta) return false;
  if (norm) {
    const key = norm.replace(/\s/g, '');
    return a.some((m) => m.textContent.replace(/\s/g, '').includes(key));
  }
  return true;
}

function addHighlight({ thenNote = false } = {}) {
  const n = cur();
  const sel = getSelection();
  if (!n || sel.isCollapsed) return hidePop();
  if (!canWrite(n)) return hidePop();
  const range = sel.getRangeAt(0);
  const content = $('#rdContent');
  if (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer.closest?.('.embed') : range.commonAncestorContainer.parentElement?.closest('.embed')) {
    toast('Open the embedded note to highlight it.');
    return hidePop();
  }
  const A = document.createTextNode('\uE000'), B = document.createTextNode('\uE001');
  const r2 = range.cloneRange(); r2.collapse(false); r2.insertNode(B);
  const r1 = range.cloneRange(); r1.collapse(true); r1.insertNode(A);
  const full = flatText(content);
  A.remove(); B.remove(); content.normalize();
  sel.removeAllRanges();
  hidePop();
  const i = full.indexOf('\uE000'), j = full.indexOf('\uE001');
  if (i < 0 || j < 0 || j <= i) { toast('Select text inside this note to highlight it.'); return; }
  const selected = full.slice(i + 1, j);
  const plain = full.replace(/[\uE000\uE001]/g, '');
  const prefix = plain.slice(0, i) + (selected.match(/^\s*/)[0]);
  const norm = normalize(selected).trim();
  const fullNorm = normalize(plain);
  const at = normalize(prefix).length;
  if (!fullNorm.startsWith(norm, at)) { toast('Flint couldn’t match that selection. Try selecting a little differently.'); return; }
  const occ = occurrences(fullNorm, norm);
  const plan = planHighlight(n.local, selected, occ.filter((x) => x < at).length, occ.length);
  if (plan.error) { toast(plan.error, 4200); return; }
  if (!verifyHighlight(n, plan.text, 1, plan.norm)) { toast('Flint couldn’t add that highlight without changing other text, so it left the note as it was.', 4200); return; }
  sy.editLocal(n.id, plan.text);
  rerenderReader();
  if (thenNote) {
    const h = listHighlights(plan.text).find((x) => x.start === plan.start);
    if (h) { openNoteEditor({ noteId: n.id, text: h.text, occ: h.occ }); return; }
  }
  toast('Highlighted. It will sync to your vault.');
}

async function removeHighlight() {
  const n = cur();
  const mark = R.popMark;
  hidePop();
  if (!n || !mark || !canWrite(n)) return;
  const info = (R.marks || []).find((x) => x.mark === mark);
  const ann = info && findAnn(n.id, info.text, info.occ);
  if (ann) {
    const ok = await ask({ label: 'Remove this highlight?', input: false, ok: 'Remove', hint: 'Your note on it will be deleted too.' });
    if (!ok) return;
  }
  const marks = contentMarks($('#rdContent'));
  const plan = planRemove(n.local, marks.indexOf(mark), marks.length);
  if (plan.error) { toast(plan.error, 4200); return; }
  if (!verifyHighlight(n, plan.text, -1)) { toast('Flint couldn’t remove that highlight safely. You can remove it in Edit.', 4200); return; }
  sy.editLocal(n.id, plan.text);
  if (ann) fd.remove('notes', ann.key);
  rerenderReader();
  toast('Highlight removed.');
}

// ---------- contents sheet ----------
function openToc(tab = 'contents') {
  if (!R.id) return;
  pushOv('toc');
  renderToc(tab);
}
function renderToc(tab) {
  $$('#sheetToc [data-toctab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.toctab === tab)));
  const content = $('#rdContent');
  const pageLabel = (el) => (P.layout === 'pages' ? String(pageOf(el) + 1) : '');
  let items;
  if (tab === 'contents') {
    const hs = $$('h1,h2,h3', content).filter((h) => !h.closest('.embed'));
    items = hs.map((h, k) => `<li class="t-l${Math.min(3, Number(h.tagName[1]))}"><button data-tocel="h${k}"><span class="t-name">${esc(h.textContent)}</span><span class="t-page">${pageLabel(h)}</span></button></li>`);
    $('#tocList').innerHTML = items.join('') || '<li class="empty">This note has no headings.</li>';
    R.tocEls = Object.fromEntries(hs.map((h, k) => [`h${k}`, h]));
  } else if (tab === 'bookmarks') {
    const bms = fd.all('bookmarks').filter((b) => b.noteId === R.id).sort((a, b) => a.f - b.f);
    const label = (b) => (P.layout === 'pages' ? String(Math.round(b.f * (R.total - 1)) + 1) : `${Math.round(b.f * 100)}%`);
    $('#tocList').innerHTML = bms.map((b) => `<li class="bm-row"><button data-bmgo="${b.f}"><span class="t-name">${esc(b.label || 'Bookmark')}</span><span class="t-page">${label(b)}</span></button><button class="unpin" data-bmdel="${esc(b.key)}" aria-label="Delete bookmark"><svg class="ic"><use href="#i-x"/></svg></button></li>`).join('')
      || '<li class="empty">No bookmarks yet. Use ⋯, then Bookmark this page.</li>';
  } else {
    const ms = contentMarks(content);
    items = ms.map((m, k) => `<li class="t-hl"><button data-tocel="m${k}"><span class="t-name"><mark>${esc(m.textContent)}</mark></span><span class="t-page">${pageLabel(m)}</span></button></li>`);
    $('#tocList').innerHTML = items.join('') || '<li class="empty">No highlights yet. Press and hold on text, then tap Highlight.</li>';
    R.tocEls = Object.fromEntries(ms.map((m, k) => [`m${k}`, m]));
  }
}

// ---------- editor ----------
function loadEditor(n) {
  const ed = $('#editor');
  $('#edTitle').value = sy.baseName(n.path);
  $('#edTitle').readOnly = !!n.readOnly || !!n.conflict;
  ed.value = n.local;
  ed.readOnly = !!n.readOnly;
  S.editorId = n.id;
  renderEditorBanner(n);
  autosize();
  window.scrollTo(0, 0);
}
function commitEditor() {
  const ed = $('#editor');
  if (S.editorId && S.view === 'editor' && !ed.readOnly) sy.editLocal(S.editorId, ed.value);
}
function closeEditor() {
  commitEditor();
  S.editorId = null;
  const ed = $('#editor');
  ed.blur();
  ed.value = '';
  document.body.classList.remove('editing');
  $('#mdbar').hidden = true;
  hideSuggest();
}
function autosize() {
  const ed = $('#editor');
  const y = window.scrollY;
  ed.style.height = 'auto';
  ed.style.height = `${ed.scrollHeight + 4}px`;
  if (window.scrollY !== y) window.scrollTo(0, y);
}
function replaceEditorText(text) {
  const ed = $('#editor');
  const old = ed.value;
  if (old === text) return;
  const s = ed.selectionStart, e = ed.selectionEnd;
  let p = 0;
  while (p < old.length && p < text.length && old[p] === text[p]) p++;
  const delta = text.length - old.length;
  const map = (x) => (x <= p ? x : Math.max(p, x + delta));
  const y = window.scrollY;
  ed.value = text;
  if (document.activeElement === ed) ed.setSelectionRange(map(s), map(e));
  autosize();
  window.scrollTo(0, y);
}
function renderEditorBanner(n) {
  const b = $('#edBanner');
  if (n.conflict) {
    b.innerHTML = `<div class="banner"><p><strong>This note changed in your vault while it was also edited here.</strong> The edits overlap, so nothing has been overwritten.</p>
      <p>Keep both saves this phone’s version as a separate note next to it.</p>
      <div class="row"><button data-res="both">Keep both</button><button data-res="theirs">Use vault version</button><button data-res="mine">Use this phone’s version</button></div>
      <details><summary>See the vault version</summary><pre>${esc(n.conflict.text)}</pre></details></div>`;
  } else if (n.readOnly) b.innerHTML = `<div class="banner info"><p>${esc(n.readOnly)}</p></div>`;
  else if (n.deletedRemote) b.innerHTML = '<div class="banner info"><p>This note was deleted or moved in your vault, but it has edits from this phone. It will be saved back to the vault so nothing is lost.</p></div>';
  else b.innerHTML = '';
}

function insertText(text, selFrom, selTo) {
  const ed = $('#editor');
  ed.focus();
  const start = ed.selectionStart;
  if (!document.execCommand('insertText', false, text)) {
    ed.setRangeText(text, ed.selectionStart, ed.selectionEnd, 'end');
    ed.dispatchEvent(new Event('input'));
  }
  if (selFrom !== undefined) ed.setSelectionRange(start + selFrom, start + (selTo ?? selFrom));
}
function wrap(before, after) {
  const ed = $('#editor');
  const sel = ed.value.slice(ed.selectionStart, ed.selectionEnd);
  insertText(before + sel + after, before.length, before.length + sel.length);
}
function editLines(fn) {
  const ed = $('#editor');
  const v = ed.value;
  const a = v.lastIndexOf('\n', ed.selectionStart - 1) + 1;
  let b = v.indexOf('\n', ed.selectionEnd);
  if (b < 0) b = v.length;
  const block = v.slice(a, b);
  const next = block.split('\n').map(fn).join('\n');
  if (next === block) return;
  const caret = ed.selectionStart === ed.selectionEnd;
  ed.setSelectionRange(a, b);
  insertText(next);
  if (caret && !next.includes('\n')) ed.setSelectionRange(a + next.length, a + next.length);
}
const ACTIONS = {
  link() { wrap('[[', ']]'); suggestCheck(); },
  bold() { wrap('**', '**'); },
  italic() { wrap('*', '*'); },
  highlight() { wrap('==', '=='); },
  tag() { insertText('#'); },
  task() {
    editLines((l) => {
      if (/^(\s*)[-*+] \[[ xX]\] /.test(l)) return l.replace(/^(\s*)[-*+] \[[ xX]\] /, '$1');
      if (/^(\s*)[-*+] /.test(l)) return l.replace(/^(\s*)[-*+] /, '$1- [ ] ');
      return l.replace(/^(\s*)/, '$1- [ ] ');
    });
  },
  list() { editLines((l) => (/^(\s*)[-*+] (?!\[[ xX]\] )/.test(l) ? l.replace(/^(\s*)[-*+] /, '$1') : l.replace(/^(\s*)(?:[-*+] \[[ xX]\] )?/, '$1- '))); },
  heading() { editLines((l) => { const m = /^(#{1,6}) /.exec(l); if (!m) return `# ${l}`; return m[1].length >= 3 ? l.slice(m[0].length) : `#${l}`; }); },
  indent() { editLines((l) => `\t${l}`); },
  outdent() { editLines((l) => l.replace(/^(\t| {1,4})/, '')); },
  undo() { $('#editor').focus(); document.execCommand('undo'); },
  redo() { $('#editor').focus(); document.execCommand('redo'); },
  done() { $('#editor').blur(); },
};
function onBeforeInput(e) {
  if (e.isComposing || (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph')) return;
  const ed = e.target;
  if (ed.selectionStart !== ed.selectionEnd) return;
  const v = ed.value, pos = ed.selectionStart;
  const ls = v.lastIndexOf('\n', pos - 1) + 1;
  const line = v.slice(ls, pos);
  const m = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/.exec(line);
  if (!m) return;
  e.preventDefault();
  if (line.length === m[0].length) { ed.setSelectionRange(ls, pos); insertText(''); return; }
  let prefix = m[2];
  if (/\[[ xX]\]/.test(prefix)) prefix = prefix.replace(/\[[ xX]\]/, '[ ]');
  if (m[3]) prefix = `${Number(m[3]) + 1}${m[4]} `;
  insertText(`\n${m[1]}${prefix}`);
}
let sugg = [];
function hideSuggest() { $('#suggest').hidden = true; sugg = []; }
function suggestCheck() {
  const ed = $('#editor');
  const pos = ed.selectionStart;
  if (pos !== ed.selectionEnd) return hideSuggest();
  const m = /\[\[([^[\]\n|#]*)$/.exec(ed.value.slice(Math.max(0, pos - 120), pos));
  if (!m) return hideSuggest();
  const q = m[1].toLowerCase();
  sugg = [...V.notes.values()]
    .map((n) => ({ n, name: sy.baseName(n.path) }))
    .filter((x) => x.name.toLowerCase().includes(q) && x.n.id !== S.editorId)
    .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1) || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((x) => ({ ...x, typed: m[1].length }));
  if (!sugg.length) return hideSuggest();
  $('#suggest').innerHTML = sugg.map((s, i) => `<li><button data-i="${i}">${esc(s.name)}<small>${esc(sy.dirName(s.n.path) || 'Vault root')}</small></button></li>`).join('');
  $('#suggest').hidden = false;
  placeBar();
}
function chooseSuggestion(i) {
  const s = sugg[i];
  const ed = $('#editor');
  const pos = ed.selectionStart;
  const closeAfter = ed.value.slice(pos, pos + 2) === ']]';
  ed.setSelectionRange(pos - s.typed, closeAfter ? pos + 2 : pos);
  insertText(`${s.name}]]`);
  hideSuggest();
}
function placeBar() {
  const vv = window.visualViewport;
  const off = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  $('#mdbar').style.transform = `translateY(${-off}px)`;
  $('#suggest').style.bottom = `${48 + off + 8}px`;
}

const cleanName = (s) => s.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
function allFolders() {
  const set = new Set();
  for (const f of V.files.values()) if (f.folder && f.path) set.add(f.path);
  for (const n of V.notes.values()) {
    const parts = n.path.split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return [...set].sort((a, b) => byName(a, b));
}
function renderFolderPick() {
  const q = $('#folderFilter').value.trim().toLowerCase();
  const curDir = cur() ? sy.dirName(cur().path) : null;
  const rows = [''].concat(allFolders()).filter((p) => !q || p.toLowerCase().includes(q));
  $('#folderList').innerHTML = rows.map((p) => {
    const depth = p ? p.split('/').length - 1 : 0;
    const name = p ? p.split('/').pop() : 'Vault root';
    const parent = p.includes('/') ? sy.dirName(p) : '';
    return `<li><button data-folder="${esc(p)}" class="${p === curDir ? 'cur' : ''}" style="padding-left:${8 + (q ? 0 : depth * 18)}px"><svg class="ic"><use href="#i-folder"/></svg><span class="nm">${esc(name)}${q && parent ? `<br><small>${esc(parent)}</small>` : ''}</span>${p === curDir ? '<small>Current</small>' : ''}</button></li>`;
  }).join('') || '<li class="empty">No folders match.</li>';
}
function pickFolder() {
  return new Promise((resolve) => {
    folderResolve = resolve;
    $('#folderFilter').value = '';
    renderFolderPick();
    pushOv('folders');
    requestAnimationFrame(() => $('#folderList .cur')?.scrollIntoView({ block: 'center' }));
  });
}
async function newNote() {
  const folder = await pickFolder();
  if (folder === null) return;
  const name = await ask({ label: 'New note', ok: 'Create', hint: `It will be saved in ${folder || 'the vault root'}.` });
  if (name === null) return;
  const id = await sy.createNote(sy.uniquePath(`${folder ? folder + '/' : ''}${cleanName(name) || 'Untitled'}.md`), '');
  openNote(id, { mode: 'edit' });
}

// ---------- print, export, citations ----------
const PAPER_CSS = { letter: 'letter', a4: 'A4', legal: 'legal', a5: 'A5' };
const MARGIN_CSS = { narrow: '0.5in', normal: '1in', wide: '1.5in' };
const PRINT_SIZE = { small: '10.5pt', normal: '12pt', large: '14pt' };
const PRINT_LH = { single: 1.3, onehalf: 1.6, double: 2.1 };
const sourceLine = (src) => `Source: ${[src.site, src.url].filter(Boolean).join(', ')}`;

function openMore() {
  const n = cur();
  if (!n) return;
  $('#moreTitle').textContent = sy.baseName(n.path);
  const src = findSource(n.local, sy.baseName(n.path));
  $('#moreCiteRow').hidden = !src;
  if (src) $('#moreCiteSrc').textContent = `From ${src.site || src.url}`;
  $('#exportToRow').hidden = !navigator.canShare;
  const reading = S.view === 'reader';
  $('[data-act2="bookmark"]').parentElement.hidden = !reading;
  $('#moreBookmark').textContent = reading && currentBookmark() ? 'Remove bookmark' : 'Bookmark this page';
  const qs = queueState(n.id);
  $('#moreQueue').textContent = qs === 'toread' ? 'Remove from Up next' : qs === 'finished' ? 'Read again (add to Up next)' : 'Add to Up next';
  syncPrintPrefs();
  pushOv('more');
}
function syncPrintPrefs() {
  $$('[data-ppref]').forEach((g) => {
    const k = g.dataset.ppref;
    const v = k === 'exportTo' ? P.exportTo : P.print[k];
    $$('button', g).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  });
  $$('[data-pflag]').forEach((b) => b.setAttribute('aria-pressed', String(!!P.print[b.dataset.pflag])));
}
function openPrintSheet(mode) {
  R.printMode = mode;
  $('#printTitle').textContent = mode === 'pdf' ? 'Export as PDF' : 'Print';
  $('#printGo').textContent = mode === 'pdf' ? 'Continue' : 'Print';
  $('#printHint').textContent = mode === 'pdf' ? 'On the next screen, choose “Save as PDF” as the printer.' : 'Your phone’s print screen opens next, where you pick a printer.';
  syncPrintPrefs();
  pushOv('print');
}

async function printNote(n) {
  const o = P.print;
  const name = sy.baseName(n.path);
  const src = findSource(n.local, name);
  const root = $('#printRoot');
  const startsWithTitle = /^\s*# /.test(n.local.replace(FRONTMATTER, ''));
  root.innerHTML = `${o.title && !startsWithTitle ? `<h1 class="p-title">${esc(name)}</h1>` : ''}<div class="p-body">${renderNote(n.local, n.path)}</div>`;
  const firstH1 = startsWithTitle ? root.querySelector('.p-body > h1') : null;
  firstH1?.classList.add('p-title');
  if (o.source && src) {
    const line = Object.assign(document.createElement('p'), { className: 'p-source', textContent: sourceLine(src) });
    const after = firstH1 || root.querySelector('.p-title');
    if (after) after.after(line); else root.prepend(line);
  }
  hydrate(root.querySelector('.p-body'), n);
  root.classList.toggle('no-hl', !o.highlights);
  root.classList.toggle('no-img', !o.images);
  const fontStack = o.font === 'sans' ? '"Atkinson Hyperlegible", Arial, sans-serif' : o.font === 'reading' ? (FONTS[P.font] || FONTS.literata)[1] : '"Source Serif 4 Variable", Georgia, serif';
  root.style.setProperty('--print-font', fontStack);
  root.style.setProperty('--print-size', PRINT_SIZE[o.size]);
  root.style.setProperty('--print-lh', PRINT_LH[o.spacing]);
  $('#printPage').textContent = `@page { size: ${PAPER_CSS[o.paper]} ${o.orient}; margin: ${MARGIN_CSS[o.margin]}; }`;
  // Wait (briefly) for images and fonts so they make it onto the page.
  const until = Date.now() + 4000;
  while (Date.now() < until && $$('img', root).some((i) => !i.complete || !i.naturalWidth)) await new Promise((r) => setTimeout(r, 120));
  await document.fonts?.ready;
  const oldTitle = document.title;
  document.title = name; // becomes the suggested PDF file name
  window.print();
  setTimeout(() => { document.title = oldTitle; }, 3000);
}

async function deliverFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (P.exportTo === 'share' && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 20_000);
  toast(`Saved “${filename}” to your Downloads folder.`, 3500);
}

function exportMarkdown(n) {
  let text = n.eol === '\r\n' ? n.local.replace(/\n/g, '\r\n') : n.local;
  if (n.bom) text = `\uFEFF${text}`;
  deliverFile(new Blob([text], { type: 'text/markdown' }), `${sy.baseName(n.path)}.md`);
}

// Turns an image into data Word can use (PNG/JPEG/GIF/BMP; anything else becomes PNG).
async function imageForWord(blob) {
  const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' };
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || 600, h = img.naturalHeight || 400;
    if (types[blob.type]) return { data: await blob.arrayBuffer(), type: types[blob.type], w, h };
    const scale = Math.min(1, 2000 / w);
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    return { data: await png.arrayBuffer(), type: 'png', w, h };
  } finally { URL.revokeObjectURL(url); }
}

async function exportWord(n) {
  toast('Preparing the Word file…', 8000);
  try {
    const o = P.print;
    const name = sy.baseName(n.path);
    const src = findSource(n.local, name);
    const tmp = document.createElement('div');
    tmp.innerHTML = renderNote(n.local, n.path);
    hydrate(tmp, n);
    const images = new Map();
    if (o.images) {
      for (const img of $$('img[data-embed]', tmp)) {
        const f = sy.resolveFile(img.dataset.embed.split('|')[0].split('#')[0], n.path);
        if (!f) continue;
        let rec = await db.get('blobs', f.id).catch(() => null);
        if (!rec && navigator.onLine) {
          try { const { bytes } = await g.download(f.id); rec = { blob: new Blob([bytes], { type: MIME[f.name.split('.').pop().toLowerCase()] || '' }) }; } catch { /* skip */ }
        }
        if (rec) { try { images.set(img, await imageForWord(rec.blob)); } catch { /* skip unreadable image */ } }
      }
    }
    const startsWithTitle = /^\s*# /.test(n.local.replace(FRONTMATTER, ''));
    const blob = await buildDocx(tmp, {
      ...o, images, title: o.title && !startsWithTitle ? name : null, docTitle: name,
      sourceLine: o.source && src ? sourceLine(src) : null,
    });
    await deliverFile(blob, `${name}.docx`);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Couldn’t make the Word file.', 4500);
  }
}

const C = { src: null, excerpt: '' };
function openCite(excerpt) {
  const n = cur();
  if (!n) return;
  C.src = findSource(n.local, sy.baseName(n.path));
  if (!C.src) { toast('This note doesn’t say which website it came from.'); return; }
  C.excerpt = excerpt;
  renderCite();
  pushOv('cite');
}
function renderCite() {
  const s = C.src;
  const authors = s.authors.map((a) => a.org || `${a.first} ${a.last}`).join(', ');
  const pd = s.published;
  const pub = pd ? (pd.m ? new Date(pd.y, pd.m - 1, pd.d || 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long', ...(pd.d ? { day: 'numeric' } : {}) }) : String(pd.y)) : '';
  $('#citeSrc').innerHTML = `<b>${esc(s.title)}</b><br>${esc([authors, s.site, pub].filter(Boolean).join(', '))}<br>${esc(s.url)}`;
  $('#citeStyles').innerHTML = Object.entries(STYLES).map(([k, label]) => `<button data-v="${k}" aria-pressed="${k === P.citeStyle}">${label}</button>`).join('');
  $$('[data-cpref="citeKind"] button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === P.citeKind)));
  $('#citeNoteLabel').textContent = isFootnoteStyle(P.citeStyle) ? 'Footnote' : P.citeStyle === 'ieee' ? 'In-text [1]' : 'In-text';
  $('#citeExcerptRow').hidden = !C.excerpt;
  $('#citeExcerpt').checked = !!P.citeExcerpt;
  $('#citePreview').innerHTML = composeCopy(C.excerpt, s, P.citeStyle, P.citeKind, P.citeExcerpt, true);
}
async function copyCitation() {
  const args = [C.excerpt, C.src, P.citeStyle, P.citeKind, P.citeExcerpt];
  const text = composeCopy(...args, false);
  const html = composeCopy(...args, true);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
  } catch {
    try { await navigator.clipboard.writeText(text); } catch { toast('Copying isn’t allowed here. Select the text in the preview and copy it instead.', 4500); return; }
  }
  await popOv();
  toast(isFootnoteStyle(P.citeStyle) && P.citeKind === 'note' && P.citeExcerpt && C.excerpt
    ? 'Copied. When you paste, turn the ¹ into a real footnote in your document.' : 'Copied with citation.', 4000);
}

// ---------- notes on highlights (stored in Flint, never in the note) ----------
function findAnn(noteId, text, occ) {
  const k = (text || '').toLowerCase();
  return fd.all('notes').find((r) => r.noteId === noteId && r.hl.toLowerCase() === k && (r.occ || 0) === (occ || 0)) || null;
}
// Pair each highlight on screen with its text in the note, so notes stay attached to the right one.
function decorateMarks() {
  const n = cur();
  if (!n || S.view !== 'reader') { R.marks = []; return; }
  const marks = contentMarks($('#rdContent'));
  const src = listHighlights(n.local);
  let info;
  if (src.length === marks.length) info = marks.map((m, i) => ({ mark: m, text: src[i].text, occ: src[i].occ }));
  else {
    const seen = new Map();
    info = marks.map((m) => { const t = normalize(m.textContent).trim(); const k = t.toLowerCase(); const occ = seen.get(k) || 0; seen.set(k, occ + 1); return { mark: m, text: t, occ }; });
  }
  for (const x of info) x.mark.classList.toggle('has-note', !!findAnn(n.id, x.text, x.occ));
  R.marks = info;
}
const NE = { ctx: null, key: null };
function openNoteEditor(ctx) {
  const n = V.notes.get(sy.resolveId(ctx.noteId));
  NE.ctx = { ...ctx, notePath: n?.path || '' };
  const ann = findAnn(ctx.noteId, ctx.text, ctx.occ);
  NE.key = ann?.key || null;
  $('#noteQuote').textContent = ctx.text;
  $('#noteText').value = ann?.text || '';
  $('#noteDelete').hidden = !ann;
  pushOv('note');
  setTimeout(() => $('#noteText').focus(), 120);
}
async function saveNoteEditor() {
  const t = $('#noteText').value.trim();
  const c = NE.ctx;
  if (!c) return;
  if (!t) { if (NE.key) fd.remove('notes', NE.key); }
  else {
    const prev = NE.key ? fd.get('notes', NE.key) : null;
    fd.put('notes', NE.key || crypto.randomUUID(), { noteId: c.noteId, notePath: c.notePath, hl: c.text, occ: c.occ || 0, text: t, created: prev?.created || Date.now() });
  }
  await popOv();
  decorateMarks();
  toast(t ? 'Note saved.' : 'Note removed.');
}

// ---------- notebook: every highlight in the vault, with your notes ----------
const hlCache = new Map();
function highlightsOf(n) {
  const c = hlCache.get(n.id);
  if (c && c.text === n.local) return c.list;
  const list = listHighlights(n.local);
  hlCache.set(n.id, { text: n.local, list });
  return list;
}
const NB = { tab: 'all', notesOnly: false };
function showNotebook(h = 'push', y = 0, sub = {}) {
  leaveNote();
  const state = { v: 'notebook', note: sub.note || null, book: sub.book || null };
  S.curState = state;
  if (h === 'push') history.pushState(state, '');
  else if (h === 'replace') history.replaceState(state, '');
  NB.note = state.note;
  NB.book = state.book;
  showView('notebook');
  renderNotebook();
  window.scrollTo(0, y);
}
const books = () => fd.all('books').sort((a, b) => byName(a.name, b.name));
const bookItems = (bookId) => fd.all('bookItems').filter((r) => r.book === bookId).sort((a, b) => a.added - b.added);
const sameHl = (r, noteId, text, occ) => r.noteId === noteId && r.hl.toLowerCase() === text.toLowerCase() && (r.occ || 0) === (occ || 0);
// Find a saved highlight in its note again (it may have moved, or been removed in Obsidian).
function locateHl(noteId, text, occ) {
  const n = V.notes.get(sy.resolveId(noteId));
  if (!n) return null;
  const hs = highlightsOf(n);
  return hs.find((h) => h.text.toLowerCase() === text.toLowerCase() && h.occ === (occ || 0)) || hs.find((h) => h.text.toLowerCase() === text.toLowerCase()) || null;
}
function nbItem(n, h, a, side, missing = false) {
  const open = n ? `data-nbopen="${esc(n.id)}" data-hl="${esc(h.text)}" data-occ="${h.occ || 0}"` : 'disabled';
  return `<div class="nb-row"><button class="nb-item${missing ? ' orphan' : ''}" ${open}><q>${esc(h.text)}</q>${a ? `<span class="nb-note"><svg class="ic"><use href="#i-note2"/></svg><span>${esc(a.text)}</span></span>` : ''}${missing ? '<small>No longer highlighted in the note</small>' : ''}</button>${side || ''}</div>`;
}
const addBtn = (noteId, h) => `<button class="nb-side" data-tobook="${esc(noteId)}" data-hl="${esc(h.text)}" data-occ="${h.occ || 0}" aria-label="Add to a notebook"><svg class="ic"><use href="#i-plus"/></svg></button>`;
function renderNotebook() {
  if (S.view !== 'notebook') return;
  const q = $('#nbFilter').value.trim().toLowerCase();
  const anns = fd.all('notes');
  const annFor = (n, h) => anns.find((r) => sameHl(r, n.id, h.text, h.occ));
  const match = (n, h, a) => (!NB.notesOnly || a) && (!q || h.text.toLowerCase().includes(q) || a?.text.toLowerCase().includes(q) || sy.baseName(n.path).toLowerCase().includes(q));
  const head = $('#nbHead');
  const tabs = $('#nbTabs');
  const list = $('#nbList');
  $('#nbOnlyNotes').setAttribute('aria-pressed', String(NB.notesOnly));

  // One note's highlights, as its own notebook.
  if (NB.note) {
    const n = V.notes.get(sy.resolveId(NB.note));
    tabs.hidden = true;
    $('#nbTitle').textContent = 'Notebook';
    if (!n) { head.innerHTML = ''; list.innerHTML = '<p class="empty">That note isn’t on this phone any more.</p>'; return; }
    const items = highlightsOf(n).map((h) => ({ h, a: annFor(n, h) })).filter(({ h, a }) => match(n, h, a));
    head.innerHTML = `<h1 class="tag-head">${esc(sy.baseName(n.path))}</h1><p class="home-sub">${highlightsOf(n).length} highlight${highlightsOf(n).length === 1 ? '' : 's'}. <button class="linkbtn" data-open="${esc(n.id)}" data-openmode="read">Open note</button></p>`;
    list.innerHTML = items.map(({ h, a }) => nbItem(n, h, a, addBtn(n.id, h))).join('') || '<p class="empty">Nothing matches.</p>';
    return;
  }
  // A notebook you made.
  if (NB.book) {
    const bk = fd.get('books', NB.book);
    tabs.hidden = true;
    $('#nbTitle').textContent = 'Notebook';
    if (!bk) { head.innerHTML = ''; list.innerHTML = '<p class="empty">This notebook was deleted.</p>'; return; }
    const items = bookItems(NB.book).filter((r) => !q || r.hl.toLowerCase().includes(q));
    head.innerHTML = `<h1 class="tag-head">${esc(bk.name)}</h1><p class="home-sub">${bookItems(NB.book).length} highlight${bookItems(NB.book).length === 1 ? '' : 's'}. <button class="linkbtn" data-bookrename="${esc(NB.book)}">Rename</button><button class="linkbtn danger-link spaced" data-bookdelete="${esc(NB.book)}">Delete notebook</button></p>`;
    list.innerHTML = items.map((r) => {
      const n = V.notes.get(sy.resolveId(r.noteId));
      const h = locateHl(r.noteId, r.hl, r.occ);
      const a = n && anns.find((x) => sameHl(x, n.id, r.hl, r.occ));
      const from = `<span class="nb-from">${esc(n ? sy.baseName(n.path) : sy.baseName(r.notePath || 'Deleted note'))}</span>`;
      const side = `<button class="nb-side" data-bookremove="${esc(r.key)}" aria-label="Remove from this notebook"><svg class="ic"><use href="#i-x"/></svg></button>`;
      return from + nbItem(n, h || { text: r.hl, occ: r.occ }, a, side, !h);
    }).join('') || `<p class="empty">${q ? 'Nothing matches.' : 'Empty so far. In the Notebook or while reading, tap a highlight’s + and choose this notebook.'}</p>`;
    return;
  }
  // The main Notebook: All, By note, or My notebooks.
  tabs.hidden = false;
  head.innerHTML = '';
  $('#nbTitle').textContent = 'Notebook';
  $$('#nbTabs [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === NB.tab)));
  $('#nbOnlyNotes').hidden = NB.tab === 'books';
  if (NB.tab === 'books') {
    const bs = books().filter((b) => !q || b.name.toLowerCase().includes(q));
    list.innerHTML = `<button class="btn" data-booknew>New notebook</button><ul class="rows">${bs.map((b) => `<li><button data-bookopen="${esc(b.key)}"><span class="r-name">${esc(b.name)}</span><span class="r-meta">${bookItems(b.key).length} highlight${bookItems(b.key).length === 1 ? '' : 's'}</span></button></li>`).join('')}</ul>${bs.length ? '' : '<p class="empty">Make notebooks to collect highlights from different notes, like a commonplace book.</p>'}`;
    return;
  }
  const groups = [];
  for (const n of V.notes.values()) {
    const hs = highlightsOf(n);
    if (!hs.length) continue;
    const items = hs.map((h) => ({ h, a: annFor(n, h) })).filter(({ h, a }) => match(n, h, a));
    if (items.length) groups.push({ n, items, total: hs.length, notes: hs.filter((h) => annFor(n, h)).length });
  }
  groups.sort((a, b) => byName(sy.baseName(a.n.path), sy.baseName(b.n.path)));
  if (NB.tab === 'bynote') {
    list.innerHTML = groups.length ? `<ul class="rows">${groups.map((g) => `<li><button data-nbnote="${esc(g.n.id)}"><span class="r-name">${esc(sy.baseName(g.n.path))}</span><span class="r-meta">${g.total} highlight${g.total === 1 ? '' : 's'}${g.notes ? `, ${g.notes} with notes` : ''}</span></button></li>`).join('')}</ul>` : '<p class="empty">Nothing matches.</p>';
    return;
  }
  const usedKeys = new Set(groups.flatMap((g) => g.items.filter((x) => x.a).map((x) => x.a.key)));
  const orphans = NB.notesOnly || q ? anns.filter((a) => !usedKeys.has(a.key) && !locateHl(a.noteId, a.hl, a.occ) && (!q || a.text.toLowerCase().includes(q) || a.hl.toLowerCase().includes(q))) : [];
  let html = groups.map(({ n, items }) => `<section class="nb-group"><h3><button data-nbnote="${esc(n.id)}">${esc(sy.baseName(n.path))} <svg class="ic"><use href="#i-right"/></svg></button><span>${items.length}</span></h3>${items.map(({ h, a }) => nbItem(n, h, a, addBtn(n.id, h))).join('')}</section>`).join('');
  if (orphans.length) html += `<section class="nb-group"><h3><span>Notes whose highlight was removed</span><span>${orphans.length}</span></h3>${orphans.map((a) => `${nbItem(null, { text: a.hl }, a, `<button class="nb-side" data-annDel="${esc(a.key)}" aria-label="Delete note"><svg class="ic"><use href="#i-x"/></svg></button>`, true)}`).join('')}</section>`;
  list.innerHTML = html || `<p class="empty">${q ? 'Nothing matches.' : NB.notesOnly ? 'No notes yet. Tap a highlight while reading, then Add note.' : 'No highlights yet. While reading, press and hold on text, then tap Highlight.'}</p>`;
}

// Choose notebooks for one highlight (tick to add, untick to remove).
const BP = { ctx: null };
function openBookPicker(ctx) {
  BP.ctx = ctx;
  renderBookPicker();
  pushOv('books');
}
function renderBookPicker() {
  const { noteId, text, occ } = BP.ctx;
  $('#bookQuote').textContent = text;
  const bs = books();
  $('#bookList').innerHTML = bs.map((b) => {
    const has = bookItems(b.key).some((r) => sameHl(r, noteId, text, occ));
    return `<li><button data-booktoggle="${esc(b.key)}" aria-pressed="${has}"><span class="nm">${esc(b.name)}</span><span class="tick">${has ? '✓' : ''}</span></button></li>`;
  }).join('') || '<li class="empty">No notebooks yet. Make one below.</li>';
}
function toggleInBook(bookId) {
  const { noteId, text, occ } = BP.ctx;
  const found = bookItems(bookId).find((r) => sameHl(r, noteId, text, occ));
  if (found) fd.remove('bookItems', found.key);
  else {
    const n = V.notes.get(sy.resolveId(noteId));
    fd.put('bookItems', crypto.randomUUID(), { book: bookId, noteId, notePath: n?.path || '', hl: text, occ: occ || 0, added: Date.now() });
  }
  renderBookPicker();
}
async function newBook(after) {
  const name = await ask({ label: 'New notebook', placeholder: 'e.g. Sermon ideas', ok: 'Create' });
  if (!name || !name.trim()) return null;
  const id = crypto.randomUUID();
  fd.put('books', id, { name: name.trim(), created: Date.now() });
  after?.(id);
  return id;
}

// ---------- highlight review on the Library ----------
const REV = { shift: 0, cache: null, sig: '' };
function allHighlights() {
  const sig = `${V.notes.size}:${V.lastSync}:${hlCache.size}`;
  if (REV.cache && REV.sig === sig) return REV.cache;
  const out = [];
  for (const n of V.notes.values()) for (const h of highlightsOf(n)) if (h.text.length >= 15) out.push({ n, h });
  REV.cache = out; REV.sig = sig;
  return out;
}
function renderReview() {
  const all = allHighlights();
  const card = $('#reviewCard');
  card.hidden = !all.length;
  if (!all.length) return;
  const day = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60_000) / 86_400_000);
  const pickIdx = (Math.imul(day + 1, 2654435761) >>> 0) % all.length;
  const { n, h } = all[(pickIdx + REV.shift) % all.length];
  const a = findAnn(n.id, h.text, h.occ);
  $('#reviewBody').innerHTML = `<q>${esc(h.text)}</q><small>${esc(sy.baseName(n.path))}${a ? `. Your note: ${esc(a.text)}` : ''}</small>`;
  $('#reviewBody').dataset.nbopen = n.id;
  $('#reviewBody').dataset.hl = h.text;
  $('#reviewBody').dataset.occ = h.occ;
  $('#reviewNext').hidden = all.length < 2;
}

// ---------- Up next (reading queue) ----------
const QV = { tab: 'toread' };
function queueState(id) { return fd.get('queue', id)?.status || null; }
function showQueue(h = 'push', y = 0) {
  leaveNote();
  S.curState = { v: 'queue' };
  if (h === 'push') history.pushState({ v: 'queue' }, '');
  else if (h === 'replace') history.replaceState({ v: 'queue' }, '');
  showView('queue');
  renderQueue();
  window.scrollTo(0, y);
}
function minutesLeft(n) {
  const words = (n.local.replace(FRONTMATTER, '').match(/\S+/g) || []).length;
  return Math.max(1, Math.ceil((words * (1 - (posMap()[n.id] || 0))) / 230));
}
function renderQueue() {
  if (S.view !== 'queue') return;
  $$('#queueTab button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === QV.tab)));
  const rows = fd.all('queue').filter((q) => q.status === QV.tab)
    .map((q) => ({ q, n: V.notes.get(sy.resolveId(q.key)) })).filter((x) => x.n)
    .sort((a, b) => (QV.tab === 'toread' ? a.q.added - b.q.added : (b.q.at || 0) - (a.q.at || 0)));
  const unq = (id) => `<button class="unpin" data-unqueue="${esc(id)}" aria-label="Remove"><svg class="ic"><use href="#i-x"/></svg></button>`;
  $('#queueList').innerHTML = rows.map(({ q, n }) => {
    const f = posMap()[n.id] || 0;
    const meta = QV.tab === 'toread' ? `${f > 0.01 ? `${Math.round(f * 100)}% read, ` : ''}${minutesLeft(n)} min left` : `Finished ${new Date(q.at || q.u).toLocaleDateString()}`;
    return `<li><button data-open="${esc(n.id)}" data-openmode="read" data-backlabel="Up next"><span class="r-name">${esc(sy.baseName(n.path))}</span><span class="r-meta">${esc(meta)}</span>${QV.tab === 'toread' ? `<span class="queue-prog"><span style="width:${Math.max(2, f * 100)}%"></span></span>` : ''}</button>${unq(q.key)}</li>`;
  }).join('');
  $('#queueHint').textContent = rows.length ? '' : QV.tab === 'toread' ? 'Nothing queued. While reading a note, tap ⋯ and choose Add to Up next.' : 'Notes you finish from Up next appear here.';
}
function checkFinished(frac) {
  if (!R.id || R.finishedMarked) return;
  const atEnd = P.layout === 'pages' ? R.total > 1 && R.page >= R.total - 1 : frac > 0.985;
  if (!atEnd || (R.readSeconds || 0) < 20) return;
  R.finishedMarked = true;
  fd.put('finished', R.id, { at: Date.now() }, { quiet: true });
  const q = fd.get('queue', R.id);
  if (q?.status === 'toread') { fd.put('queue', R.id, { ...q, status: 'finished', at: Date.now() }); toast('Finished. Moved from Up next to Finished.'); }
}

// ---------- bookmarks ----------
function pageSnippet() {
  const content = $('#rdContent');
  const blocks = $$('p, li, h1, h2, h3, h4, h5, h6, blockquote, td', content).filter((el) => !el.closest('.embed') && el.textContent.trim());
  let el;
  if (P.layout === 'pages') el = blocks.find((b) => pageOf(b) === R.page) || blocks.find((b) => pageOf(b) > R.page);
  else { const top = $('#rdFrame').getBoundingClientRect().top; el = blocks.find((b) => b.getBoundingClientRect().bottom > top + 4); }
  const t = (el?.textContent || '').replace(/\s+/g, ' ').trim();
  return t.length > 90 ? `${t.slice(0, 88)}…` : t;
}
function currentBookmark() {
  if (!R.id) return null;
  const f = readerFrac();
  const tol = P.layout === 'pages' ? 0.5 / Math.max(1, R.total - 1) : 0.012;
  return fd.all('bookmarks').find((b) => b.noteId === R.id && Math.abs(b.f - f) <= tol + 1e-9) || null;
}
function updateRibbon() { $('#rdRibbon').toggleAttribute('hidden', !currentBookmark()); }
function toggleBookmark() {
  const b = currentBookmark();
  if (b) { fd.remove('bookmarks', b.key); toast('Bookmark removed.'); }
  else { fd.put('bookmarks', crypto.randomUUID(), { noteId: R.id, f: readerFrac(), label: pageSnippet(), created: Date.now() }); toast('Page bookmarked. Find it under Contents.'); }
  updateRibbon();
}

// ---------- reading stats ----------
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = (sec) => { const m = Math.round(sec / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };
function readingSummary() {
  const by = fd.secondsByDay();
  const today = by[dayKey()] || 0;
  let week = 0;
  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const s = by[dayKey(d)] || 0; week += s; days.push({ d, s }); }
  let streak = 0;
  const d = new Date();
  if ((by[dayKey(d)] || 0) < 60) d.setDate(d.getDate() - 1);
  while ((by[dayKey(d)] || 0) >= 60) { streak++; d.setDate(d.getDate() - 1); }
  const weekAgo = Date.now() - 7 * 86_400_000;
  const finished = fd.all('finished').filter((f) => f.at >= weekAgo).length;
  return { today, week, streak, finished, days };
}
function openStats() {
  const st = readingSummary();
  $('#statGrid').innerHTML = [
    [fmtTime(st.today), 'Today'], [fmtTime(st.week), 'Last 7 days'],
    [`${st.streak} day${st.streak === 1 ? '' : 's'}`, 'Reading streak'], [String(st.finished), 'Notes finished this week'],
  ].map(([b, l]) => `<div><b>${b}</b><span>${l}</span></div>`).join('');
  const max = Math.max(60, ...st.days.map((x) => x.s));
  $('#statBars').innerHTML = st.days.map(({ d, s }) => `<div class="${s < 60 ? 'zero' : ''}" style="height:${Math.max(3, (s / max) * 100)}%" title="${fmtTime(s)}"><span>${d.toLocaleDateString(undefined, { weekday: 'narrow' })}</span></div>`).join('');
  pushOv('stats');
}
function tickReading() {
  if (document.visibilityState !== 'visible') return;
  const active = (S.view === 'reader' && Date.now() - (R.lastAct || 0) < 120_000) || L.playing;
  if (!active) return;
  fd.addReadingTime(dayKey(), 15);
  R.readSeconds = (R.readSeconds || 0) + 15;
}

// ---------- dictionary ----------
const defCache = new Map();
async function defineWord(word) {
  const w = word.toLowerCase().replace(/[’']s$/, '');
  pushOv('define');
  const box = $('#defineBody');
  box.innerHTML = `<h3>${esc(w)}</h3><p class="empty">Looking it up…</p>`;
  if (!defCache.has(w)) {
    if (!navigator.onLine) { box.innerHTML = `<h3>${esc(w)}</h3><p class="empty">Definitions need an internet connection.</p>`; return; }
    try {
      const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`);
      defCache.set(w, r.status === 404 ? [] : r.ok ? await r.json() : null);
    } catch { defCache.set(w, null); }
  }
  const data = defCache.get(w);
  if (data === null) { defCache.delete(w); box.innerHTML = `<h3>${esc(w)}</h3><p class="empty">The dictionary couldn’t be reached. Try again in a moment.</p>`; return; }
  if (!data.length) { box.innerHTML = `<h3>${esc(w)}</h3><p class="empty">No definition found for “${esc(w)}”.</p>`; return; }
  const e = data[0];
  const phon = e.phonetic || e.phonetics?.find((p) => p.text)?.text || '';
  const meanings = data.flatMap((x) => x.meanings || []).slice(0, 4);
  box.innerHTML = `<h3>${esc(e.word || w)}</h3>${phon ? `<div class="phon">${esc(phon)}</div>` : ''}${meanings.map((m) => `<div class="pos">${esc(m.partOfSpeech || '')}</div><ol>${m.definitions.slice(0, 3).map((d) => `<li>${esc(d.definition)}${d.example ? `<span class="ex">“${esc(d.example)}”</span>` : ''}</li>`).join('')}</ol>`).join('')}<p class="aa-note">Definitions from Wiktionary, via the Free Dictionary API.</p>`;
}

// ---------- listen ----------
const L = new Listener({
  onSentence: (s) => {
    try { if (window.CSS?.highlights && window.Highlight) CSS.highlights.set('tts', new Highlight(s.range)); } catch { /* not supported */ }
    followRange(s.range);
    R.lastAct = Date.now();
  },
  onState: () => renderListenBar(),
});
function followRange(range) {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  if (P.layout === 'pages') {
    const cols = $('#rdCols').getBoundingClientRect();
    const p = Math.max(0, Math.min(R.total - 1, Math.floor((rect.left - cols.left + 1) / R.step)));
    if (p !== R.page) goPage(p);
  } else {
    const fr = $('#rdFrame');
    const box = fr.getBoundingClientRect();
    if (rect.top < box.top + 20 || rect.bottom > box.bottom - 70) fr.scrollTop += rect.top - box.top - box.height / 3;
  }
}
function pickVoice() {
  const list = ttsVoices();
  return list.find((v) => v.voiceURI === P.listenVoice) || null;
}
function startListening() {
  if (!ttsSupported) { toast('This phone doesn’t offer reading aloud in the browser.'); return; }
  const list = buildSentences($('#rdContent'));
  if (!list.length) { toast('There’s nothing to read aloud in this note.'); return; }
  let start = 0;
  if (P.layout === 'pages') {
    const cols = $('#rdCols').getBoundingClientRect();
    start = list.findIndex((s) => { const r = s.range.getBoundingClientRect(); return Math.floor((r.left - cols.left + 1) / R.step) >= R.page; });
  } else {
    const top = $('#rdFrame').getBoundingClientRect().top;
    start = list.findIndex((s) => s.range.getBoundingClientRect().bottom > top);
  }
  L.rate = P.listenRate;
  L.voice = pickVoice();
  L.load(list, Math.max(0, start));
  hideChrome();
  L.play();
}
function stopListening() {
  if (L.active) L.stop();
  try { CSS.highlights?.delete('tts'); } catch { /* ignore */ }
}
const RATES = [0.8, 1, 1.2, 1.4, 1.7, 2];
function renderListenBar() {
  $('#listenBar').hidden = !L.active;
  $('#reader').classList.toggle('listening', L.active);
  $('#listenIcon').setAttribute('href', L.playing ? '#i-pause' : '#i-play');
  $('#listenSpeed').textContent = `${String(P.listenRate).replace(/^0/, '')}×`;
  if (!L.active) { try { CSS.highlights?.delete('tts'); } catch { /* ignore */ } }
}
function fillVoices() {
  const sel = $('#setVoice');
  if (!sel) return;
  const list = ttsVoices();
  const lang = (navigator.language || 'en').slice(0, 2);
  const mine = list.filter((v) => v.lang?.toLowerCase().startsWith(lang));
  const rest = list.filter((v) => !mine.includes(v));
  sel.innerHTML = `<option value="">Phone’s default voice</option>${[...mine, ...rest].map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('')}`;
  sel.value = P.listenVoice;
}

// ---------- renaming ----------
function pathTaken(path, exceptId) {
  const k = path.normalize('NFC').toLowerCase();
  for (const n of V.notes.values()) if (n.id !== exceptId && n.path.normalize('NFC').toLowerCase() === k) return true;
  for (const f of V.files.values()) if (f.id !== exceptId && f.path && f.path.normalize('NFC').toLowerCase() === k) return true;
  return false;
}
// Find links that point at note n, and how they should read after renaming it (as Obsidian does).
function planLinkUpdates(n, newBase, newPath) {
  const sameNameElsewhere = [...V.notes.values()].some((o) => o.id !== n.id && sy.baseName(o.path).toLowerCase() === newBase.toLowerCase());
  const newTarget = (t) => {
    const usePath = t.includes('/') || sameNameElsewhere;
    return (usePath ? newPath.replace(/\.md$/i, '') : newBase) + (/\.md$/i.test(t) ? '.md' : '');
  };
  let count = 0;
  const notes = [];
  for (const o of V.notes.values()) {
    if (o.readOnly || o.conflict) continue;
    const hidden = hiddenRanges(o.local);
    const inside = (i) => hidden.some(([a, b]) => i >= a && i < b);
    let changed = 0;
    let text = o.local.replace(/(!?\[\[)([^\]|#\n]+)((?:#[^\]|\n]*)?(?:\\?\|[^\]\n]*)?\]\])/g, (m, a, t, rest, off) => {
      if (inside(off)) return m;
      const r = sy.resolveNote(t, o.path);
      if (r && r.id === n.id) { changed++; return a + newTarget(t.trim()) + rest; }
      return m;
    });
    text = text.replace(/(\[[^\]\n]*\]\()(<?)([^)\n>#]+?\.md)(>?\))/gi, (m, a, lt, href, b, off) => {
      if (inside(off) || /^[a-z][a-z0-9+.-]*:/i.test(href)) return m;
      let dec = href;
      try { dec = decodeURI(href); } catch { /* keep */ }
      const r = sy.resolveNote(dec, o.path);
      if (!r || r.id !== n.id) return m;
      changed++;
      const parts = dec.split('/');
      parts[parts.length - 1] = `${newBase}.md`;
      const nd = parts.join('/');
      return a + lt + (lt ? nd : encodeURI(nd)) + b;
    });
    if (changed) { count += changed; notes.push({ id: o.id, text }); }
  }
  return { count, notes };
}
async function commitTitle() {
  const inp = $('#edTitle');
  const n = cur();
  if (!n || S.view !== 'editor') return;
  const old = sy.baseName(n.path);
  const name = cleanName(inp.value);
  const revert = (msg) => { inp.value = old; if (msg) toast(msg, 4000); };
  if (!name) return revert('A note needs a name.');
  if (name === old) return revert();
  if (n.readOnly || n.conflict) return revert('This note can’t be renamed right now.');
  const dir = sy.dirName(n.path);
  const newPath = `${dir ? dir + '/' : ''}${name}.md`;
  if (pathTaken(newPath, n.id)) return revert('Another note in this folder already has that name.');
  if (!n.pendingCreate && !navigator.onLine) return revert('Renaming needs an internet connection. Try again when you’re online.');
  const plan = planLinkUpdates(n, name, newPath);
  if (plan.count) {
    const ok = await ask({
      label: `Rename to “${name}”?`, input: false, ok: 'Rename',
      hint: `${plan.count} link${plan.count === 1 ? '' : 's'} in ${plan.notes.length} note${plan.notes.length === 1 ? '' : 's'} point here. Flint will update ${plan.count === 1 ? 'it' : 'them'} so ${plan.count === 1 ? 'it keeps' : 'they keep'} working, just like Obsidian does.`,
    });
    if (!ok) return revert();
  }
  commitEditor();
  try {
    await sy.renameNote(n.id, newPath);
  } catch (e) {
    return revert(e.name === 'Offline' ? 'Renaming needs an internet connection. Try again when you’re online.' : e.message);
  }
  for (const u of plan.notes) {
    sy.editLocal(u.id, u.text);
    if (u.id === S.editorId) replaceEditorText(u.text);
  }
  inp.value = sy.baseName(cur().path);
  toast(plan.count ? `Renamed, and updated ${plan.count} link${plan.count === 1 ? '' : 's'}.` : 'Renamed.');
}

// ---------- backup of Flint-only data ----------
function exportBackup() {
  const d = new Date();
  const data = { app: 'flint', version: 2, saved: d.toISOString(), prefs: P, flint: fd.snapshot(), recent: S.recent, last: store.get('last', '') };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `flint-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast('Backup saved to your Downloads folder.');
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'flint') throw new Error('bad');
    for (const k of Object.keys(DEFAULTS)) if (data.prefs && k in data.prefs) P[k] = data.prefs[k];
    savePrefs();
    if (data.flint) fd.restore(data.flint);
    if (data.pins) savePins({ folders: [...pins().folders, ...(data.pins.folders || [])], notes: [...new Set([...pins().notes, ...(data.pins.notes || [])])] });
    if (data.pos) for (const [id, f] of Object.entries(data.pos)) if (!fd.get('pos', id)) savePosFor(id, f);
    if (Array.isArray(data.recent)) { S.recent = data.recent; store.set('recent', S.recent); }
    if (data.last) store.set('last', data.last);
    applyPrefs();
    fillSettings();
    toast('Backup restored.');
  } catch {
    toast('That file isn’t a Flint backup.');
  }
}

// ---------- files and search ----------
function setTab(tab) {
  $$('#drawer [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('#tabFiles').hidden = tab !== 'files';
  $('#tabSearch').hidden = tab !== 'search';
}
function openFiles() {
  const n = cur();
  if (n) { const parts = n.path.split('/'); for (let i = 1; i < parts.length; i++) S.openFolders.add(parts.slice(0, i).join('/')); }
  setTab('files');
  pushOv('drawer');
  requestAnimationFrame(() => $('#tree .row.cur')?.scrollIntoView({ block: 'center' }));
}
function openSearch(q = '') {
  if (!S.ov.includes('drawer')) pushOv('drawer');
  setTab('search');
  $('#q').value = q;
  runSearch();
  if (!q) setTimeout(() => $('#q').focus(), 80);
}
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
function buildTree() {
  const root = { kids: new Map(), notes: [] };
  const add = (path) => {
    let node = root, acc = '';
    for (const p of path.split('/')) {
      acc = acc ? `${acc}/${p}` : p;
      if (!node.kids.has(p)) node.kids.set(p, { name: p, path: acc, kids: new Map(), notes: [] });
      node = node.kids.get(p);
    }
    return node;
  };
  for (const f of V.files.values()) if (f.folder && f.path) add(f.path);
  for (const n of V.notes.values()) { const d = sy.dirName(n.path); (d ? add(d) : root).notes.push(n); }
  return root;
}
function treeEl(node) {
  const frag = document.createDocumentFragment();
  for (const f of [...node.kids.values()].sort((a, b) => byName(a.name, b.name))) {
    const d = document.createElement('details');
    d.innerHTML = `<summary class="row"><svg class="ic chev"><use href="#i-right"/></svg><span class="nm">${esc(f.name)}</span></summary>`;
    if (S.openFolders.has(f.path)) { d.open = true; d.append(kidsEl(f)); }
    d.addEventListener('toggle', () => {
      if (d.open) { S.openFolders.add(f.path); if (!d.querySelector(':scope > .kids')) d.append(kidsEl(f)); } else S.openFolders.delete(f.path);
      store.set('open', [...S.openFolders]);
    });
    frag.append(d);
  }
  for (const n of node.notes.sort((a, b) => byName(sy.baseName(a.path), sy.baseName(b.path)))) {
    const b = document.createElement('button');
    b.className = `row${n.id === S.current ? ' cur' : ''}`;
    b.dataset.open = n.id;
    b.innerHTML = `<svg class="ic"><use href="#i-note"/></svg><span class="nm">${esc(sy.baseName(n.path))}</span>${n.dirty || n.pendingCreate || n.conflict ? '<span class="badge" title="Not synced yet"></span>' : ''}`;
    frag.append(b);
  }
  return frag;
}
function kidsEl(f) { const k = document.createElement('div'); k.className = 'kids'; k.append(treeEl(f)); return k; }
function renderTree() {
  const t = $('#tree');
  const y = t.parentElement.scrollTop;
  t.replaceChildren(V.notes.size ? treeEl(buildTree()) : Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No notes on this phone yet. They’ll appear after the first sync.' }));
  t.parentElement.scrollTop = y;
}
function snippet(text, i, len) {
  const s = Math.max(0, i - 50), e = Math.min(text.length, i + len + 80);
  const clean = (x) => esc(x.replace(/\s+/g, ' '));
  return `${s > 0 ? '…' : ''}${clean(text.slice(s, i))}<mark>${clean(text.slice(i, i + len))}</mark>${clean(text.slice(i + len, e))}${e < text.length ? '…' : ''}`;
}
function runSearch() {
  const q = $('#q').value.trim();
  const out = $('#results');
  if (!q) { out.innerHTML = ''; return; }
  const ql = q.toLowerCase();
  const res = [];
  for (const n of V.notes.values()) {
    const name = sy.baseName(n.path), nl = name.toLowerCase();
    let score = nl === ql ? 100 : nl.startsWith(ql) ? 80 : nl.includes(ql) ? 60 : 0;
    const i = n.local.toLowerCase().indexOf(ql);
    if (i >= 0) score = Math.max(score, 20);
    if (score) res.push({ n, name, score, i });
  }
  res.sort((a, b) => b.score - a.score || byName(a.name, b.name));
  const folders = allFolders().filter((p) => p.split('/').pop().toLowerCase().includes(ql))
    .sort((a, b) => (a.split('/').pop().toLowerCase().startsWith(ql) ? 0 : 1) - (b.split('/').pop().toLowerCase().startsWith(ql) ? 0 : 1) || byName(a, b)).slice(0, 20);
  const folderRows = folders.map((p) => `<li><button data-folderopen="${esc(p)}"><span class="r-name r-folder"><svg class="ic"><use href="#i-folder"/></svg>${esc(folderLabel(p))}</span><span class="r-meta">Folder in ${esc(sy.dirName(p) || 'Vault root')}</span></button></li>`).join('');
  if (!res.length && folderRows) { out.innerHTML = folderRows; return; }
  out.innerHTML = folderRows + (res.length
    ? res.slice(0, 60).map((r) => `<li><button data-open="${esc(r.n.id)}"><span class="r-name">${esc(r.name)}</span>${r.i >= 0 ? `<span class="r-snip">${snippet(r.n.local, r.i, q.length)}</span>` : ''}<span class="r-meta">${esc(sy.dirName(r.n.path) || 'Vault root')}</span></button></li>`).join('')
    : `<li class="empty">No notes match “${esc(q)}”.</li>`);
}

// ---------- display settings sheet ----------
function syncAaSheet() {
  const list = $('#fontList');
  if (!list) return;
  if (!list.children.length) {
    list.innerHTML = Object.entries(FONTS).map(([k, [label, stack]]) => `<li><button data-font="${k}" style="font-family:${esc(stack)}">${esc(label)}</button></li>`).join('');
  }
  $$('[data-font]', list).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.font === P.font)));
  $('#sizeRange').value = P.size;
  $('#nightRows').hidden = P.nightOn !== 'on';
  $('#nightFrom').value = P.nightFrom;
  $('#nightTo').value = P.nightTo;
  $$('#sheetAa [data-pref]').forEach((group) => {
    const k = group.dataset.pref;
    $$('button', group).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(P[k]))));
  });
}
function prefsChanged() {
  if (S.view === 'reader' && R.frac == null) R.frac = readerFrac();
  savePrefs();
  applyPrefs();
  if (S.view === 'editor') autosize();
  if (S.view === 'reader') {
    const f = FONTS[P.font] || FONTS.literata;
    document.fonts?.load(`${fsPx()}px ${f[1]}`).finally(relayoutSoon);
    relayoutSoon();
  }
}
function bindAa() {
  $('#sheetAa').addEventListener('click', (e) => {
    const t = e.target.closest('[data-aatab]');
    if (t) {
      $$('#sheetAa [data-aatab]').forEach((b) => b.setAttribute('aria-selected', String(b === t)));
      $$('#sheetAa [data-aapane]').forEach((p) => { p.hidden = p.dataset.aapane !== t.dataset.aatab; });
      return;
    }
    const f = e.target.closest('[data-font]');
    if (f) { P.font = f.dataset.font; prefsChanged(); return; }
    const s = e.target.closest('[data-size]');
    if (s) { P.size = Math.max(0, Math.min(SIZES.length - 1, P.size + Number(s.dataset.size))); prefsChanged(); return; }
    const b = e.target.closest('[data-pref] [data-v]');
    if (b) {
      const k = b.closest('[data-pref]').dataset.pref;
      P[k] = k === 'weight' ? Number(b.dataset.v) : b.dataset.v;
      prefsChanged();
    }
  });
  $('#sizeRange').addEventListener('input', (e) => { P.size = Number(e.target.value); prefsChanged(); });
  $('#nightFrom').addEventListener('change', (e) => { P.nightFrom = e.target.value || '20:00'; prefsChanged(); });
  $('#nightTo').addEventListener('change', (e) => { P.nightTo = e.target.value || '07:00'; prefsChanged(); });
}

// ---------- settings ----------
function fillSettings() {
  $('#setScripture').value = P.scripture;
  $('#setLogosMode').value = P.logosMode;
  $('#setBible').value = P.bibleVersion;
  $('#setHtml').value = P.htmlMode;
  $('#setLangs').value = P.hideLangs;
  $('#setHiddenTags').value = P.hiddenTags;
  $('#setDataSync').value = P.dataSync;
  $('#setDataPath').textContent = fd.dataLocation() || '';
  $('#setDataLast').textContent = P.dataSync !== 'on' ? 'Off' : fd.lastSynced() ? new Date(fd.lastSynced()).toLocaleString() : 'Not yet';
  fillVoices();
  navigator.storage?.persisted?.().then((v) => { $('#setPersist').textContent = v ? 'Yes' : 'Not yet'; }).catch(() => { $('#setPersist').textContent = 'Unknown'; });
  $('#setOpen').value = P.openIn;
  $('#setCount').textContent = String(V.notes.size);
  const p = sy.pendingCount(), c = sy.conflicts().length;
  $('#setPending').textContent = p ? `${p} note${p === 1 ? '' : 's'}${c ? `, ${c} need${c === 1 ? 's' : ''} a choice` : ''}` : 'Nothing';
  $('#setLast').textContent = V.lastSync ? new Date(V.lastSync).toLocaleString() : 'Not yet';
  $('#setVault').textContent = V.vaultPath || 'OneDrive';
  $('#setClient').textContent = auth.clientId();
  $('#setRedirect').textContent = auth.redirectUri();
  $('#setReset').disabled = !!(p || c);
  $('#setSignOut').textContent = auth.hasTokens() ? 'Sign out' : 'Sign in';
  $('#setSignOut').classList.toggle('danger', auth.hasTokens());
  $('#setSignOut').classList.toggle('primary', !auth.hasTokens());
}
function bindSettings() {
  const reread = () => { savePrefs(); if (S.view === 'reader') rerenderReader(); };
  $('#setScripture').onchange = (e) => { P.scripture = e.target.value; reread(); };
  $('#setLogosMode').onchange = (e) => { P.logosMode = e.target.value; reread(); };
  $('#setBible').onchange = (e) => { P.bibleVersion = e.target.value.trim().toUpperCase(); e.target.value = P.bibleVersion; reread(); };
  $('#setHtml').onchange = (e) => { P.htmlMode = e.target.value; reread(); };
  $('#setLangs').onchange = (e) => { P.hideLangs = e.target.value; reread(); };
  $('#setHiddenTags').onchange = (e) => { P.hiddenTags = e.target.value; savePrefs(); };
  $('#setDataSync').onchange = async (e) => {
    P.dataSync = e.target.value; savePrefs();
    fd.setEnabled(P.dataSync === 'on');
    if (P.dataSync === 'on' && navigator.onLine) { try { await fd.syncData(); toast('Synced with your other phones.'); } catch { toast('Couldn’t reach OneDrive. Flint will try again later.'); } }
    fillSettings();
  };
  $('#setVoice').onchange = (e) => { P.listenVoice = e.target.value; savePrefs(); L.setVoice(pickVoice()); };
  $('#setExport').onclick = exportBackup;
  $('#setImport').onchange = (e) => { const f = e.target.files?.[0]; if (f) importBackup(f); e.target.value = ''; };
  $('#setOpen').onchange = (e) => { P.openIn = e.target.value; savePrefs(); };
  $('#setClose').onclick = () => popOv();
  $('#setSyncNow').onclick = async () => { await sy.sync(); fillSettings(); toast(statusMessage()); };
  $('#setReset').onclick = async () => {
    const ok = await ask({ label: 'Remove the offline copy?', input: false, ok: 'Remove and download again', hint: 'Notes are removed from this phone only, then downloaded again from OneDrive.' });
    if (!ok) return;
    try { await sy.resetLocal(); await popOv(); showHome('replace'); sy.sync(); } catch (e) { toast(e.message); }
  };
  $('#setSignOut').onclick = async () => {
    if (!auth.hasTokens()) { await sy.flushWrites(); auth.login(); return; }
    const p = sy.pendingCount();
    const ok = await ask({ label: 'Sign out of OneDrive?', input: false, ok: 'Sign out', hint: p ? `${p} edited note${p === 1 ? '' : 's'} will stay on this phone and sync after you sign in again.` : 'Your notes stay readable on this phone.' });
    if (!ok) return;
    auth.signOut();
    V.status = 'auth';
    renderSync();
    fillSettings();
  };
  $('#setChangeVault').onclick = async () => {
    if (sy.pendingCount() || sy.conflicts().length) { toast('Sync your changes before switching vaults.'); return; }
    await popOv();
    showOnboard('vault');
  };
  $('#setChangeClient').onclick = async () => { await popOv(); showOnboard('client'); };
}

// ---------- sync status ----------
function statusMessage() {
  const p = sy.pendingCount();
  switch (V.status) {
    case 'ok': return 'Everything is synced.';
    case 'pending': return `${p} note${p === 1 ? '' : 's'} waiting to sync.`;
    case 'offline': return p ? `Offline. ${p} edited note${p === 1 ? ' is' : 's are'} saved on this phone.` : 'Offline. You’re reading your vault from the last sync.';
    case 'conflict': return 'A note changed in two places and needs your choice.';
    case 'auth': return 'Sign in to OneDrive to sync.';
    case 'error': return `Sync stopped: ${V.error}`;
    case 'syncing': return 'Syncing…';
    default: return '';
  }
}
let syncFrame = 0;
function renderSync() {
  cancelAnimationFrame(syncFrame);
  syncFrame = requestAnimationFrame(() => {
    const p = sy.pendingCount();
    let s = V.status, label = '';
    if (s === 'syncing') label = V.progress ? `${V.progress.done}/${V.progress.total}` : '';
    else if (s === 'offline') label = p ? `Offline, ${p}` : 'Offline';
    else if (s === 'auth') label = 'Sign in';
    else if (s === 'conflict') label = 'Check';
    else if (s === 'error') label = 'Retry';
    else if (p) { s = 'pending'; label = String(p); }
    for (const b of $$('.sync')) {
      b.dataset.s = s;
      $('.sync-label', b).textContent = b.classList.contains('tool') ? (label || 'Synced') : label;
      b.setAttribute('aria-label', statusMessage() || 'Sync');
    }
    renderHome();
  });
}
function onSyncTap() {
  if (V.status === 'auth') { sy.flushWrites().then(() => auth.login()); return; }
  if (V.status === 'conflict' && sy.conflicts()[0]) { openNote(sy.conflicts()[0].id, { mode: 'edit' }); return; }
  sy.sync().then(() => toast(statusMessage()));
}

function onSyncEvent(type, data) {
  if (['status', 'progress', 'dirty', 'saved'].includes(type)) { renderSync(); return; }
  if (type === 'conflict') {
    const n = V.notes.get(data);
    if (n) toast(`“${sy.baseName(n.path)}” changed in two places. Open it in Edit to choose what to keep.`, 5000);
  }
  if (type === 'renamed') {
    if (S.editorId === data.from) S.editorId = data.to;
    if (R.id === data.from) R.id = data.to;
    if (S.current === data.from) { S.current = data.to; if (history.state?.id === data.from && !S.ov.length) history.replaceState({ ...history.state, id: data.to }, ''); }
    if (store.get('last', '') === data.from) store.set('last', data.to);
    const pm = posMap(); if (pm[data.from] !== undefined) { pm[data.to] = pm[data.from]; delete pm[data.from]; store.set('pos', pm); }
    S.recent = S.recent.map((x) => (x === data.from ? data.to : x));
    for (const col of ['pos', 'queue', 'finished', 'pinNotes']) { const r = fd.get(col, data.from); if (r) { const { u, ...rest } = r; fd.put(col, data.to, rest, { quiet: true }); fd.remove(col, data.from); } }
    for (const r of [...fd.all('notes'), ...fd.all('bookmarks')]) if (r.noteId === data.from) { const { key, u, ...rest } = r; fd.put(r.notePath !== undefined ? 'notes' : 'bookmarks', key, { ...rest, noteId: data.to }, { quiet: true }); }
    const pp = pins(); if (pp.notes.includes(data.from)) { pp.notes = pp.notes.map((x) => (x === data.from ? data.to : x)); savePins(pp); }
    store.set('recent', S.recent);
  }
  if (type === 'note' && data.id === S.current) {
    const n = cur();
    if (S.view === 'editor' && S.editorId === n.id) { if (data.external) replaceEditorText(n.local); renderEditorBanner(n); }
    if (S.view === 'reader' && (data.external || n.conflict)) rerenderReader();
  }
  if (type === 'tree' && S.view === 'tags') renderTags(history.state?.tag || null);
  if (type === 'tree' && S.view === 'pinned') renderPinned();
  if (type === 'tree' && S.view === 'notebook') renderNotebook();
  if (type === 'tree' && S.view === 'queue') renderQueue();
  if (type === 'tree' && !$('#sheetFolder').hidden) renderFolderSheet();
  if (['tree', 'note', 'renamed', 'conflict'].includes(type)) {
    if (!$('#drawer').hidden && !$('#tabFiles').hidden) renderTree();
    renderSync();
  }
}

// ---------- onboarding ----------
function showOnboard(step) {
  $('#app').hidden = true;
  $('#onboard').hidden = false;
  const box = $('#obStep');
  if (step === 'client') {
    box.innerHTML = `<h1>Welcome to Flint</h1>
      <p>Flint reads and edits the Obsidian vault in your OneDrive. To connect, it needs the ID of your own free Microsoft app registration. The setup guide that came with these files walks you through it.</p>
      <p>When the registration asks for a redirect URI, use this exact address:</p>
      <code>${esc(auth.redirectUri())}</code>
      <label for="obClient" style="display:block;margin-top:18px;font-weight:600">Application (client) ID</label>
      <input id="obClient" placeholder="00000000-0000-0000-0000-000000000000" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(auth.clientId())}">
      <p class="err" id="obErr"></p>
      <button class="btn primary" id="obNext">Continue</button>`;
    $('#obNext').onclick = () => {
      const v = $('#obClient').value.trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) { $('#obErr').textContent = 'That doesn’t look like an app ID. It has 36 characters, like 1a2b3c4d-0000-…'; return; }
      auth.setClientId(v);
      showOnboard('signin');
    };
  } else if (step === 'signin') {
    box.innerHTML = `<h1>Sign in to OneDrive</h1>
      <p>Use the personal Microsoft account that holds your vault. Flint only asks for access to your files so it can read and save notes. Nothing goes anywhere except your phone and your OneDrive.</p>
      <button class="btn primary" id="obSignIn">Sign in with Microsoft</button>
      <button class="btn" id="obBack">Use a different app ID</button>`;
    $('#obSignIn').onclick = () => auth.login();
    $('#obBack').onclick = () => showOnboard('client');
  } else if (step === 'vault') browse([{ id: null, name: 'OneDrive' }]);
}
async function browse(crumbs) {
  const box = $('#obStep');
  const here = crumbs[crumbs.length - 1];
  box.innerHTML = `<h1>Choose your vault</h1>
    <p>Open the folder that holds your Obsidian vault, then tap Use this folder.</p>
    <div class="crumbs">${crumbs.map((c, i) => `<button data-i="${i}">${esc(c.name)}</button>`).join('<span>/</span>')}</div>
    <div id="obList"><p class="empty">Loading folders…</p></div>
    <button class="btn primary" id="obUse" disabled>Use this folder</button>
    ${V.vaultId ? '<button class="btn" id="obCancel">Cancel</button>' : ''}`;
  $$('.crumbs button', box).forEach((b) => { b.onclick = () => browse(crumbs.slice(0, Number(b.dataset.i) + 1)); });
  if ($('#obCancel')) $('#obCancel').onclick = () => { $('#onboard').hidden = true; $('#app').hidden = false; };
  try {
    const items = await g.listFolders(here.id);
    const folders = items.filter((i) => i.folder && !i.name.startsWith('.')).sort((a, b) => byName(a.name, b.name));
    const isVault = items.some((i) => i.folder && i.name === '.obsidian');
    $('#obList').innerHTML = `${isVault ? '<div class="vault-hint">This folder looks like an Obsidian vault.</div>' : ''}
      ${folders.length ? `<ul class="folders">${folders.map((f) => `<li><button data-id="${esc(f.id)}" data-name="${esc(f.name)}"><svg class="ic"><use href="#i-files"/></svg><span class="nm">${esc(f.name)}</span><svg class="ic"><use href="#i-right"/></svg></button></li>`).join('')}</ul>` : '<p class="empty">No folders inside this one.</p>'}`;
    $$('.folders button', box).forEach((b) => { b.onclick = () => browse([...crumbs, { id: b.dataset.id, name: b.dataset.name }]); });
    const use = $('#obUse');
    use.disabled = false;
    use.onclick = async () => {
      use.disabled = true;
      try {
        const id = here.id || (await g.rootItem()).id;
        await sy.chooseVault(id, crumbs.slice(1).map((c) => c.name).join('/'));
        fd.setVaultPath(V.vaultPath);
        S.recent = []; store.set('recent', []); store.set('last', ''); store.set('pos', {});
        showApp();
        sy.sync();
      } catch (e) { toast(e.message); use.disabled = false; }
    };
  } catch (e) {
    if (e.name === 'AuthNeeded') { showOnboard('signin'); return; }
    $('#obList').innerHTML = `<p class="err">${esc(e.name === 'Offline' ? 'You’re offline. Connect to the internet to choose a folder.' : e.message)}</p><button class="btn" id="obRetry">Try again</button>`;
    $('#obRetry').onclick = () => browse(crumbs);
  }
}
function showApp() {
  $('#onboard').hidden = true;
  $('#app').hidden = false;
  showHome('replace');
  renderSync();
}

// ---------- wiring ----------
function bind() {
  sy.on(onSyncEvent);
  const ed = $('#editor');
  ed.addEventListener('input', () => { if (S.editorId) sy.editLocal(S.editorId, ed.value); autosize(); suggestCheck(); });
  ed.addEventListener('beforeinput', onBeforeInput);
  ed.addEventListener('click', suggestCheck);
  ed.addEventListener('focus', () => { if (ed.readOnly) return; document.body.classList.add('editing'); $('#mdbar').hidden = false; placeBar(); });
  ed.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== ed) { document.body.classList.remove('editing'); $('#mdbar').hidden = true; hideSuggest(); }
  }, 150));
  $('#mdbar').addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#mdbar').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) ACTIONS[b.dataset.act](); });
  $('#suggest').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#suggest').addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) chooseSuggestion(Number(b.dataset.i)); });
  window.visualViewport?.addEventListener('resize', placeBar);
  window.visualViewport?.addEventListener('scroll', placeBar);

  $('#edBanner').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-res]');
    if (!b) return;
    const choice = b.dataset.res;
    if (choice !== 'both') {
      const ok = await ask({
        label: choice === 'theirs' ? 'Use the vault version?' : 'Use this phone’s version?', input: false, ok: 'Yes, use it',
        hint: choice === 'theirs' ? 'The edits made on this phone will be discarded.' : 'The changes made elsewhere will be replaced in OneDrive.',
      });
      if (!ok) return;
    }
    await sy.resolveConflict(S.editorId, choice);
    toast(choice === 'both' ? 'Saved this phone’s version as a separate note.' : 'Done.');
  });

  document.addEventListener('click', (e) => {
    const m = e.target.closest('.modeswitch [data-mode]');
    if (m) { setMode(m.dataset.mode); return; }
    const fo = e.target.closest('[data-folderopen]');
    if (fo) { openFolderSheet(fo.dataset.folderopen); return; }
    const uf = e.target.closest('[data-unpinfolder]');
    if (uf) { toggleFolderPin(uf.dataset.unpinfolder); renderPinned(); return; }
    const un = e.target.closest('[data-unpinnote]');
    if (un) { const p = pins(); p.notes = p.notes.filter((x) => x !== un.dataset.unpinnote); savePins(p); renderPinned(); return; }
    if (e.target.closest('[data-back]')) { history.back(); return; }
    const ht = e.target.closest('[data-hidetag]');
    if (ht) {
      const t = ht.dataset.hidetag;
      P.hiddenTags = [P.hiddenTags.trim(), t].filter(Boolean).join(', ');
      savePrefs();
      toast(`#${t} is hidden. You can show it again in Settings.`, 4000);
      history.back();
      return;
    }
    if (e.target.closest('[data-pinnote]')) {
      if (!R.id) return;
      const on = toggleNotePin(R.id);
      $('[data-pinnote]').setAttribute('aria-pressed', String(on));
      toast(on ? 'Pinned. Find it under Pinned in the Library.' : 'Unpinned.');
      return;
    }
    const o = e.target.closest('[data-open]');
    if (o) { e.preventDefault(); openNote(o.dataset.open, { mode: o.dataset.openmode, backLabel: o.dataset.backlabel || null }); return; }
    const go = e.target.closest('[data-go]');
    if (go) {
      const act = go.dataset.go;
      if (act === 'home') showHome();
      else if (act === 'settings') pushOv('settings');
      else if (act === 'files') openFiles();
      else if (act === 'search') openSearch('');
      else if (act === 'new') newNote();
      else if (act === 'tags') showTags();
      else if (act === 'pinned') showPinned();
      else if (act === 'more') openMore();
      else if (act === 'notebook') showNotebook();
      else if (act === 'queue') showQueue();
      else if (act === 'stats') openStats();
      else if (act === 'listen') startListening();
      else if (act === 'aa') pushOv('aa');
      else if (act === 'toc') openToc();
      return;
    }
    if (e.target.closest('.sync')) { onSyncTap(); return; }
    const a = e.target.closest('[data-a]');
    if (a?.dataset.a === 'signin') sy.flushWrites().then(() => auth.login());
    if (a?.dataset.a === 'sync') sy.sync();
  });
  $('#sheetToc').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-toctab]');
    if (t) { renderToc(t.dataset.toctab); return; }
    const b = e.target.closest('[data-tocel]');
    if (b) { const el = R.tocEls?.[b.dataset.tocel]; await popOv(); showElement(el); }
  });
  $('#folderList').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-folder]');
    if (!b) return;
    const r = folderResolve;
    folderResolve = null;
    await popOv();
    r?.(b.dataset.folder);
  });
  $('#folderFilter').addEventListener('input', renderFolderPick);
  $('#fsList').addEventListener('click', (e) => {
    const f = e.target.closest('[data-fsfolder]');
    if (f) { FS.path = f.dataset.fsfolder; renderFolderSheet(); return; }
    const n = e.target.closest('[data-fsnote]');
    if (n) openNote(n.dataset.fsnote, { fromFolder: FS.path, backLabel: `“${folderLabel(FS.path)}”` });
  });
  $('#sheetMore').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act2]');
    if (!b) return;
    const n = cur();
    if (!n) return;
    commitEditor();
    const act = b.dataset.act2;
    await popOv();
    if (act === 'nbnote') showNotebook('push', 0, { note: n.id });
    else if (act === 'bookmark') toggleBookmark();
    else if (act === 'queue') {
      if (queueState(n.id) === 'toread') { fd.remove('queue', n.id); toast('Removed from Up next.'); }
      else { fd.put('queue', n.id, { status: 'toread', added: Date.now() }); toast('Added to Up next.'); }
    } else if (act === 'print' || act === 'pdf') openPrintSheet(act);
    else if (act === 'docx') exportWord(n);
    else if (act === 'md') exportMarkdown(n);
    else if (act === 'cite') openCite('');
  });
  document.addEventListener('click', (e) => {
    const seg = e.target.closest('[data-ppref] [data-v]');
    if (seg) {
      const k = seg.closest('[data-ppref]').dataset.ppref;
      if (k === 'exportTo') P.exportTo = seg.dataset.v; else P.print[k] = seg.dataset.v;
      savePrefs(); syncPrintPrefs(); return;
    }
    const flag = e.target.closest('[data-pflag]');
    if (flag) { P.print[flag.dataset.pflag] = !P.print[flag.dataset.pflag]; savePrefs(); syncPrintPrefs(); return; }
    const cp = e.target.closest('[data-cpref] [data-v]');
    if (cp) { P[cp.closest('[data-cpref]').dataset.cpref] = cp.dataset.v; savePrefs(); renderCite(); }
  });
  document.addEventListener('click', (e) => {
    const nn = e.target.closest('[data-nbnote]');
    if (nn) { history.replaceState({ ...(history.state || {}), y: scrollY }, ''); showNotebook('push', 0, { note: nn.dataset.nbnote }); return; }
    const bo = e.target.closest('[data-bookopen]');
    if (bo) { history.replaceState({ ...(history.state || {}), y: scrollY }, ''); showNotebook('push', 0, { book: bo.dataset.bookopen }); return; }
    if (e.target.closest('[data-booknew]')) { newBook((id) => showNotebook('push', 0, { book: id })); return; }
    const tb = e.target.closest('[data-tobook]');
    if (tb) { openBookPicker({ noteId: tb.dataset.tobook, text: tb.dataset.hl, occ: Number(tb.dataset.occ || 0) }); return; }
    const bt = e.target.closest('[data-booktoggle]');
    if (bt) { toggleInBook(bt.dataset.booktoggle); return; }
    const br = e.target.closest('[data-bookremove]');
    if (br) { fd.remove('bookItems', br.dataset.bookremove); renderNotebook(); return; }
    const bren = e.target.closest('[data-bookrename]');
    if (bren) {
      const bk = fd.get('books', bren.dataset.bookrename);
      ask({ label: 'Rename notebook', value: bk?.name || '', ok: 'Rename' }).then((name) => { if (name && name.trim() && bk) { const { u, ...rest } = bk; fd.put('books', bren.dataset.bookrename, { ...rest, name: name.trim() }); } });
      return;
    }
    const bdel = e.target.closest('[data-bookdelete]');
    if (bdel) {
      const id = bdel.dataset.bookdelete;
      ask({ label: 'Delete this notebook?', input: false, ok: 'Delete', hint: 'The highlights stay in your notes and in the main Notebook.' }).then((ok) => {
        if (!ok) return;
        for (const r of bookItems(id)) fd.remove('bookItems', r.key);
        fd.remove('books', id);
        history.back();
      });
      return;
    }
    const nb = e.target.closest('[data-nbopen]');
    if (nb) {
      if (S.view === 'notebook' || S.view === 'home') history.replaceState({ ...(history.state || {}), y: scrollY }, '');
      openNote(nb.dataset.nbopen, { mode: 'read', target: { hl: nb.dataset.hl, occ: Number(nb.dataset.occ || 0) }, backLabel: S.view === 'notebook' ? 'Notebook' : 'Library' });
      return;
    }
    const ad = e.target.closest('[data-annDel], [data-anndel]');
    if (ad) { fd.remove('notes', ad.dataset.anndel || ad.getAttribute('data-annDel')); renderNotebook(); return; }
    const uq = e.target.closest('[data-unqueue]');
    if (uq) { fd.remove('queue', uq.dataset.unqueue); renderQueue(); return; }
    const bg = e.target.closest('[data-bmgo]');
    if (bg) { const f = Number(bg.dataset.bmgo); popOv().then(() => setFrac(f, false)); return; }
    const bd = e.target.closest('[data-bmdel]');
    if (bd) { fd.remove('bookmarks', bd.dataset.bmdel); renderToc('bookmarks'); updateRibbon(); return; }
    const ls = e.target.closest('[data-listen]');
    if (ls) {
      const a = ls.dataset.listen;
      if (a === 'toggle') L.toggle();
      else if (a === 'prev') L.skip(-1);
      else if (a === 'next') L.skip(1);
      else if (a === 'stop') stopListening();
      else if (a === 'speed') { P.listenRate = RATES[(RATES.indexOf(P.listenRate) + 1) % RATES.length]; savePrefs(); L.setRate(P.listenRate); renderListenBar(); }
    }
  });
  $('#nbFilter').addEventListener('input', () => renderNotebook());
  $('#nbTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) { NB.tab = b.dataset.v; renderNotebook(); } });
  $('#nbOnlyNotes').onclick = () => { NB.notesOnly = !NB.notesOnly; renderNotebook(); };
  $('#bookNew').onclick = () => newBook((id) => toggleInBook(id));
  $('#queueTab').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) { QV.tab = b.dataset.v; renderQueue(); } });
  $('#reviewNext').onclick = () => { REV.shift++; renderReview(); };
  $('#noteSave').onclick = saveNoteEditor;
  $('#noteDelete').onclick = async () => { if (NE.key) fd.remove('notes', NE.key); await popOv(); decorateMarks(); toast('Note deleted.'); };
  fd.onChange(() => {
    if (S.view === 'home') renderHome();
    if (S.view === 'notebook') renderNotebook();
    if (S.view === 'queue') renderQueue();
    if (S.view === 'pinned') renderPinned();
    if (S.view === 'reader') { decorateMarks(); updateRibbon(); }
  });
  window.speechSynthesis?.addEventListener?.('voiceschanged', fillVoices);
  setInterval(tickReading, 15_000);
  setInterval(() => { if (document.documentElement.dataset.theme !== effectiveTheme()) applyPrefs(); }, 60_000);
  $('#printGo').onclick = async () => { const n = cur(); await popOv(); if (n) printNote(n); };
  $('#citeExcerpt').onchange = (e) => { P.citeExcerpt = e.target.checked; savePrefs(); renderCite(); };
  $('#citeCopy').onclick = copyCitation;
  $('#fsUp').onclick = () => { FS.path = sy.dirName(FS.path); renderFolderSheet(); };
  $('#fsPin').onclick = () => { const on = toggleFolderPin(FS.path); renderFolderSheet(); toast(on ? 'Folder pinned.' : 'Folder unpinned.'); };
  const title = $('#edTitle');
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { title.value = sy.baseName(cur()?.path || ''); title.blur(); }
  });
  title.addEventListener('change', commitTitle);
  $('#tagList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (b) { history.replaceState({ ...(history.state || {}), y: scrollY }, ''); showTags(b.dataset.tag); }
  });
  $('#tagFilter').addEventListener('input', () => renderTags(null));
  $('#tagsBack').onclick = () => history.back();
  $('#layoutSwitch').addEventListener('click', (e) => { const b = e.target.closest('[data-layoutpick]'); if (b) setLayout(b.dataset.layoutpick); });
  $('#scrim').onclick = () => popOv();
  $('#drawer [data-close]').onclick = () => popOv();
  $$('#drawer [data-tab]').forEach((b) => { b.onclick = () => { setTab(b.dataset.tab); if (b.dataset.tab === 'search') $('#q').focus(); else renderTree(); }; });
  let qTimer;
  $('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(runSearch, 120); });
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = modalResolve;
    modalResolve = null;
    const v = $('#modalInput').hidden ? true : $('#modalInput').value;
    await popOv();
    r?.(v);
  });
  $('#modalCancel').onclick = () => popOv();

  window.addEventListener('online', () => sy.sync());
  window.addEventListener('offline', () => { V.status = 'offline'; renderSync(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { commitEditor(); saveReaderPos(); sy.flushWrites(); fd.flush(); if (P.dataSync === 'on' && navigator.onLine) fd.syncData().catch(() => {}); } else { updateClock(); sy.sync(); }
  });
  window.addEventListener('pagehide', () => { commitEditor(); saveReaderPos(); sy.flushWrites(); });
  setInterval(() => { if (document.visibilityState === 'visible') sy.sync(); }, 60_000);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyPrefs);

  bindReader();
  bindAa();
  bindSettings();
}

// Earlier versions kept pins and positions on the phone only; move them into the synced data once.
function migrateLocalData() {
  if (localStorage.getItem('flint.migrated2')) return;
  const oldPins = store.get('pins', null);
  if (oldPins && (oldPins.notes?.length || oldPins.folders?.length)) savePins({ folders: [...pins().folders, ...(oldPins.folders || [])], notes: [...new Set([...pins().notes, ...(oldPins.notes || [])])] });
  const oldPos = store.get('pos', null);
  if (oldPos) for (const [id, f] of Object.entries(oldPos)) if (!fd.get('pos', id)) fd.put('pos', id, { f }, { quiet: true });
  localStorage.setItem('flint.migrated2', '1');
}

async function start() {
  applyPrefs();
  bind();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  let redirect = null;
  try { redirect = await auth.handleRedirect(); } catch (e) { setTimeout(() => toast(e.message, 6000), 300); }
  await sy.loadLocal();
  await fd.load();
  migrateLocalData();
  fd.setVaultPath(V.vaultPath);
  fd.setEnabled(P.dataSync === 'on');
  sy.setAfterSync(() => fd.syncData());
  if (!auth.clientId()) return showOnboard('client');
  if (!V.vaultId) return showOnboard(auth.hasTokens() ? 'vault' : 'signin');
  showApp();
  // Always start on the Library; "Continue reading" there reopens the last note at the same spot.
  // Sync runs in the background. If it can't, the last downloaded vault stays fully usable.
  await sy.sync();
  if (V.status === 'auth' && navigator.onLine && redirect !== 'silent-failed' && !sessionStorage.getItem('flint.silentTried')) {
    sessionStorage.setItem('flint.silentTried', '1');
    await sy.flushWrites();
    saveReaderPos();
    auth.login({ silent: true });
  }
}

// If anything goes wrong while starting, show a way out instead of a blank screen.
start().catch((e) => {
  console.error(e);
  $('#app').hidden = true;
  $('#onboard').hidden = false;
  $('#obStep').innerHTML = `<h1>Flint couldn’t start</h1><p>Your notes in OneDrive are safe. ${esc(e.message || '')}</p><button class="btn primary" onclick="location.reload()">Try again</button>`;
});
