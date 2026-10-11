import * as db from './db.js';
import * as auth from './auth.js';
import * as g from './graph.js';
import * as sy from './sync.js';
import { V } from './sync.js';
import { renderMarkdown, esc, FRONTMATTER } from './markdown.js';
import { linkScripture, logosUrl } from './scripture.js';
import { planHighlight, planRemove, normalize, occurrences } from './highlight.js';

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
  openIn: 'read', dailyFolder: '', newIn: 'current',
  scripture: 'on', logosMode: 'app', bibleVersion: '',
};
const P = { ...DEFAULTS, ...store.get('prefs', {}) };
const savePrefs = () => store.set('prefs', P);
const langSet = () => new Set(P.hideLangs.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const fsPx = () => Math.round(SIZES[P.size] * (FONTS[P.font] || FONTS.literata)[2]);

function applyPrefs() {
  const r = document.documentElement;
  const f = FONTS[P.font] || FONTS.literata;
  r.style.setProperty('--read', f[1]);
  r.style.setProperty('--fs', `${fsPx()}px`);
  r.style.setProperty('--wt', WEIGHTS[P.weight]);
  r.style.setProperty('--lh', SPACING[P.spacing]);
  r.style.setProperty('--m', `${MARGINS[P.margin]}px`);
  r.style.setProperty('--align', P.align);
  r.dataset.theme = P.theme;
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
const posMap = () => store.get('pos', {});
const savePosFor = (id, frac) => { const m = posMap(); m[id] = Math.max(0, Math.min(1, frac)); store.set('pos', m); };

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
const popWaiters = [];
const OV = {
  drawer: { show() { $('#drawer').hidden = false; renderTree(); }, hide() { $('#drawer').hidden = true; } },
  aa: { show() { $('#sheetAa').hidden = false; syncAaSheet(); }, hide() { $('#sheetAa').hidden = true; } },
  toc: { show() { $('#sheetToc').hidden = false; }, hide() { $('#sheetToc').hidden = true; } },
  settings: { show() { fillSettings(); $('#settings').hidden = false; }, hide() { $('#settings').hidden = true; } },
  modal: {
    show() { $('#modal').hidden = false; },
    hide() { $('#modal').hidden = true; if (modalResolve) { const r = modalResolve; modalResolve = null; r(null); } },
  },
};
function updateScrim() {
  const top = S.ov[S.ov.length - 1];
  $('#scrim').hidden = !['drawer', 'aa', 'toc', 'modal'].includes(top);
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
  if (st.v === 'note' && V.notes.has(sy.resolveId(st.id))) openNote(st.id, { history: 'none', mode: st.mode });
  else showHome('none');
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
  $('#reader').hidden = v !== 'reader';
  $('#editorView').hidden = v !== 'editor';
  document.body.dataset.view = v;
  $$('.modeswitch [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === (v === 'editor' ? 'edit' : 'read'))));
  if (v !== 'reader') hidePop();
}

function showHome(h = 'push') {
  closeEditor();
  saveReaderPos();
  S.current = null;
  R.id = null;
  if (h === 'push') history.pushState({ v: 'home' }, '');
  else if (h === 'replace') history.replaceState({ v: 'home' }, '');
  showView('home');
  renderHome();
  window.scrollTo(0, 0);
}

function renderHome() {
  if (S.view !== 'home') return;
  $('#homeVault').textContent = V.vaultPath.split('/').pop() || 'OneDrive';
  const count = V.notes.size;
  $('#homeSub').textContent = count
    ? `${count} note${count === 1 ? '' : 's'} on this phone${V.lastSync ? `, synced ${ago(V.lastSync)}` : ''}`
    : V.status === 'offline' ? 'Connect to the internet to download your notes.' : 'Getting your notes ready…';
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
  $('#recent').innerHTML = rec.length
    ? rec.map((n) => `<li><button data-open="${esc(n.id)}"><span class="r-name">${esc(sy.baseName(n.path))}</span><span class="r-meta">${esc(sy.dirName(n.path) || 'Vault root')}${n.dirty || n.pendingCreate ? ', not synced yet' : ''}</span></button></li>`).join('')
    : `<li class="empty">${count ? 'Notes you open will show up here. Tap Files to browse your vault.' : ''}</li>`;
}

function openNote(id, { history: h = 'push', mode, target = null, keepOv = false, backTo = null } = {}) {
  id = sy.resolveId(id);
  const n = V.notes.get(id);
  if (!n) { toast('That note isn’t on this phone yet. It will appear after the next sync.'); return false; }
  closeEditor();
  saveReaderPos();
  if (!keepOv && S.ov.length) { dropAllOv(); if (h === 'push') h = 'replace'; }
  S.current = id;
  addRecent(id);
  store.set('last', id);
  const m = mode || P.openIn;
  const state = { v: 'note', id, mode: m, backTo };
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
  $('#rdBack').hidden = !back;
  if (back) $('#rdBack').textContent = `‹ Back to “${sy.baseName(back.path)}”`;
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

function layout() {
  const fr = $('#rdFrame'), cols = $('#rdCols');
  document.documentElement.style.setProperty('--pageH', `${fr.clientHeight}px`);
  if (P.layout === 'scroll') {
    cols.removeAttribute('style');
    R.total = 1;
    return;
  }
  const W = fr.clientWidth, H = fr.clientHeight;
  const colW = Math.floor(Math.min(W - 2 * MARGINS[P.margin], fsPx() * 34));
  const gap = W - colW;
  Object.assign(cols.style, { width: `${colW}px`, height: `${H}px`, columnWidth: `${colW}px`, columnGap: `${gap}px`, marginLeft: `${gap / 2}px` });
  R.step = W;
  R.total = Math.max(1, Math.round((cols.scrollWidth + gap) / W));
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
function turn(d) {
  hidePop();
  if (P.layout !== 'pages') return;
  if ((d > 0 && R.page >= R.total - 1) || (d < 0 && R.page <= 0)) return;
  goPage(R.page + d);
  hideChrome();
}

function updateProgress() {
  const frac = readerFrac();
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
  const frac = readerFrac();
  layout();
  setFrac(frac, false);
}
let relayoutTimer;
function relayoutSoon() { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(relayout, 120); }

function showChrome() { R.chrome = true; $('#reader').classList.add('show-chrome'); updateProgress(); hidePop(); }
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
function showElement(el) {
  if (!el) return;
  if (P.layout === 'pages') goPage(pageOf(el), false);
  else { const fr = $('#rdFrame'); fr.scrollTop += el.getBoundingClientRect().top - fr.getBoundingClientRect().top - 12; updateProgress(); }
  el.classList.remove('target-flash'); void el.offsetWidth; el.classList.add('target-flash');
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
  const el = findTarget(sub);
  if (el) requestAnimationFrame(() => showElement(el));
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
    else if (a.classList.contains('tag')) openSearch(`#${a.dataset.tag}`);
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
  $('#hlBtn').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#hlBtn').onclick = () => (R.popMode === 'remove' ? removeHighlight() : addHighlight());
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
  $('#hlLabel').textContent = 'Highlight';
  placePop(range.getBoundingClientRect());
}
function showRemovePop(mark) {
  R.popMode = 'remove';
  R.popMark = mark;
  $('#hlLabel').textContent = 'Remove highlight';
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

function addHighlight() {
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
  toast('Highlighted. It will sync to your vault.');
}

function removeHighlight() {
  const n = cur();
  const mark = R.popMark;
  hidePop();
  if (!n || !mark || !canWrite(n)) return;
  const marks = contentMarks($('#rdContent'));
  const plan = planRemove(n.local, marks.indexOf(mark), marks.length);
  if (plan.error) { toast(plan.error, 4200); return; }
  if (!verifyHighlight(n, plan.text, -1)) { toast('Flint couldn’t remove that highlight safely. You can remove it in Edit.', 4200); return; }
  sy.editLocal(n.id, plan.text);
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
  $('#edTitle').textContent = sy.baseName(n.path);
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
async function newNote() {
  const folder = P.newIn === 'current' && cur() ? sy.dirName(cur().path) : '';
  const name = await ask({ label: 'New note', ok: 'Create', hint: folder ? `It will be saved in ${folder}.` : 'It will be saved in the vault root.' });
  if (name === null) return;
  const id = await sy.createNote(sy.uniquePath(`${folder ? folder + '/' : ''}${cleanName(name) || 'Untitled'}.md`), '');
  openNote(id, { mode: 'edit' });
}
async function todayNote() {
  const d = new Date();
  const folder = P.dailyFolder.trim().replace(/^\/+|\/+$/g, '');
  const path = `${folder ? folder + '/' : ''}${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`;
  const existing = [...V.notes.values()].find((n) => n.path.toLowerCase() === path.toLowerCase());
  if (existing) { openNote(existing.id); return; }
  openNote(await sy.createNote(path, ''), { mode: 'edit' });
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
  out.innerHTML = res.length
    ? res.slice(0, 60).map((r) => `<li><button data-open="${esc(r.n.id)}"><span class="r-name">${esc(r.name)}</span>${r.i >= 0 ? `<span class="r-snip">${snippet(r.n.local, r.i, q.length)}</span>` : ''}<span class="r-meta">${esc(sy.dirName(r.n.path) || 'Vault root')}</span></button></li>`).join('')
    : `<li class="empty">No notes match “${esc(q)}”.</li>`;
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
  $$('#sheetAa [data-pref]').forEach((group) => {
    const k = group.dataset.pref;
    $$('button', group).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(P[k]))));
  });
}
function prefsChanged() {
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
}

// ---------- settings ----------
function fillSettings() {
  $('#setScripture').value = P.scripture;
  $('#setLogosMode').value = P.logosMode;
  $('#setBible').value = P.bibleVersion;
  $('#setHtml').value = P.htmlMode;
  $('#setLangs').value = P.hideLangs;
  $('#setOpen').value = P.openIn;
  $('#setDaily').value = P.dailyFolder;
  $('#setNewIn').value = P.newIn;
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
  $('#setOpen').onchange = (e) => { P.openIn = e.target.value; savePrefs(); };
  $('#setDaily').onchange = (e) => { P.dailyFolder = e.target.value; savePrefs(); };
  $('#setNewIn').onchange = (e) => { P.newIn = e.target.value; savePrefs(); };
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
    store.set('recent', S.recent);
  }
  if (type === 'note' && data.id === S.current) {
    const n = cur();
    if (S.view === 'editor' && S.editorId === n.id) { if (data.external) replaceEditorText(n.local); renderEditorBanner(n); }
    if (S.view === 'reader' && (data.external || n.conflict)) rerenderReader();
  }
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
    const o = e.target.closest('[data-open]');
    if (o) { e.preventDefault(); openNote(o.dataset.open, { mode: o.dataset.openmode }); return; }
    const go = e.target.closest('[data-go]');
    if (go) {
      const act = go.dataset.go;
      if (act === 'home') showHome();
      else if (act === 'settings') pushOv('settings');
      else if (act === 'files') openFiles();
      else if (act === 'search') openSearch('');
      else if (act === 'new') newNote();
      else if (act === 'today') todayNote();
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
    if (document.visibilityState === 'hidden') { commitEditor(); saveReaderPos(); sy.flushWrites(); } else { updateClock(); sy.sync(); }
  });
  window.addEventListener('pagehide', () => { commitEditor(); saveReaderPos(); sy.flushWrites(); });
  setInterval(() => { if (document.visibilityState === 'visible') sy.sync(); }, 60_000);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyPrefs);

  bindReader();
  bindAa();
  bindSettings();
}

async function start() {
  applyPrefs();
  bind();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  let redirect = null;
  try { redirect = await auth.handleRedirect(); } catch (e) { setTimeout(() => toast(e.message, 6000), 300); }
  await sy.loadLocal();
  if (!auth.clientId()) return showOnboard('client');
  if (!V.vaultId) return showOnboard(auth.hasTokens() ? 'vault' : 'signin');
  showApp();
  // Pick up where you left off, like a Kindle: reopen the last note at the same spot.
  const last = sy.resolveId(store.get('last', ''));
  if (last && V.notes.has(last)) openNote(last, { mode: 'read' });
  // Then sync in the background. If it can't, the last downloaded vault stays fully usable.
  await sy.sync();
  if (V.status === 'auth' && navigator.onLine && redirect !== 'silent-failed' && !sessionStorage.getItem('flint.silentTried')) {
    sessionStorage.setItem('flint.silentTried', '1');
    await sy.flushWrites();
    saveReaderPos();
    auth.login({ silent: true });
  }
}

start();
