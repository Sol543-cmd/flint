// Reads Word documents (.docx) for the reading view, and writes back only two kinds
// of change: yellow highlights and Word comments. Nothing else in the file is touched.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kids = (el, name) => [...(el?.children || [])].filter((c) => c.namespaceURI === W && (!name || c.localName === name));
const kid = (el, name) => kids(el, name)[0] || null;
const wv = (el) => el?.getAttributeNS(W, 'val') ?? el?.getAttribute('w:val');
const parse = (s) => new DOMParser().parseFromString(s, 'application/xml');
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const serialize = (xml) => DECL + new XMLSerializer().serializeToString(xml).replace(/^<\?xml[^>]*\?>\s*/, '');

export async function openDocx(buf) {
  const zip = await window.JSZip.loadAsync(buf);
  const main = zip.file('word/document.xml');
  if (!main) throw new Error('This isn’t a Word document Flint can read.');
  const d = { zip, xml: parse(await main.async('string')), rels: new Map(), styles: new Map(), num: new Map(), footnotes: new Map(), comments: new Map(), commentsXml: null, media: new Map() };
  if (d.xml.getElementsByTagName('parsererror').length) throw new Error('This Word document couldn’t be read.');
  const relsFile = zip.file('word/_rels/document.xml.rels');
  if (relsFile) for (const r of parse(await relsFile.async('string')).getElementsByTagNameNS(PKG, 'Relationship')) d.rels.set(r.getAttribute('Id'), { type: r.getAttribute('Type'), target: r.getAttribute('Target'), external: r.getAttribute('TargetMode') === 'External' });
  const stylesFile = zip.file('word/styles.xml');
  if (stylesFile) for (const st of parse(await stylesFile.async('string')).getElementsByTagNameNS(W, 'style')) {
    const name = wv(kid(st, 'name')) || '';
    d.styles.set(st.getAttributeNS(W, 'styleId'), { name: name.toLowerCase(), outline: wv(kid(kid(st, 'pPr'), 'outlineLvl')) });
  }
  const numFile = zip.file('word/numbering.xml');
  if (numFile) {
    const nx = parse(await numFile.async('string'));
    const abs = new Map();
    for (const a of nx.getElementsByTagNameNS(W, 'abstractNum')) abs.set(a.getAttributeNS(W, 'abstractNumId'), new Map(kids(a, 'lvl').map((l) => [l.getAttributeNS(W, 'ilvl'), wv(kid(l, 'numFmt')) || 'bullet'])));
    for (const n of nx.getElementsByTagNameNS(W, 'num')) d.num.set(n.getAttributeNS(W, 'numId'), abs.get(wv(kid(n, 'abstractNumId'))) || new Map());
  }
  const fnFile = zip.file('word/footnotes.xml');
  if (fnFile) for (const f of parse(await fnFile.async('string')).getElementsByTagNameNS(W, 'footnote')) d.footnotes.set(f.getAttributeNS(W, 'id'), f);
  const cmFile = zip.file('word/comments.xml');
  if (cmFile) {
    d.commentsXml = parse(await cmFile.async('string'));
    for (const c of d.commentsXml.getElementsByTagNameNS(W, 'comment')) d.comments.set(c.getAttributeNS(W, 'id'), c);
  }
  return d;
}

// ---------- rendering ----------
const listMark = (fmt, n) => {
  if (fmt === 'bullet') return '•';
  if (fmt === 'lowerLetter') return `${String.fromCharCode(96 + ((n - 1) % 26) + 1)}.`;
  if (fmt === 'upperLetter') return `${String.fromCharCode(64 + ((n - 1) % 26) + 1)}.`;
  if (fmt === 'lowerRoman' || fmt === 'upperRoman') {
    const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let x = n, r = '';
    for (const [v, s] of map) while (x >= v) { r += s; x -= v; }
    return `${fmt === 'upperRoman' ? r.toUpperCase() : r}.`;
  }
  return `${n}.`;
};
// Characters a run shows (must match what the reading view displays for it).
const charLen = (c) => (c.localName === 't' ? c.textContent.length : ['tab', 'noBreakHyphen', 'sym'].includes(c.localName) ? 1 : 0);
const runChars = (r) => kids(r).reduce((t, c) => t + charLen(c), 0);

// Turns the document into reading HTML. Every text run becomes <span data-r="k">, where
// k is its place in d.runs, so a selection maps back to the exact run and character.
export function renderDocx(d, media) {
  d.runs = [];
  const counters = new Map();
  const fnOrder = new Map();
  const open = new Set();
  const out = [];
  const cmt = (id) => `<button class="doc-cbadge" data-cid="${esc(id)}" aria-label="Comment"></button>`;
  function runHtml(r, index) {
    const rPr = kid(r, 'rPr');
    let html = '';
    let text = '';
    const flush = () => { if (text) { html += esc(text); text = ''; } };
    for (const c of kids(r)) {
      const n = c.localName;
      if (n === 't') text += c.textContent;
      else if (n === 'tab') text += '\t';
      else if (n === 'br') { flush(); if (c.getAttributeNS(W, 'type') !== 'page') html += '<br>'; }
      else if (n === 'noBreakHyphen') text += '‑';
      else if (n === 'sym') text += String.fromCharCode(parseInt(c.getAttributeNS(W, 'char') || '20', 16));
      else if (n === 'footnoteReference') {
        flush();
        const id = c.getAttributeNS(W, 'id');
        if (!fnOrder.has(id)) fnOrder.set(id, fnOrder.size + 1);
        html += `<sup class="footnote-ref"><a href="#dfn-${esc(id)}">${fnOrder.get(id)}</a></sup>`;
      } else if (n === 'commentReference') { flush(); html += cmt(c.getAttributeNS(W, 'id')); }
      else if (n === 'drawing' || n === 'pict') {
        flush();
        const blip = c.getElementsByTagNameNS(A_NS, 'blip')[0];
        const rid = blip?.getAttributeNS(RNS, 'embed') || c.getElementsByTagName('v:imagedata')[0]?.getAttributeNS(RNS, 'id');
        const rel = rid && d.rels.get(rid);
        if (rel && !rel.external) html += `<img data-docimg="${esc(`word/${rel.target.replace(/^\/?word\//, '')}`)}" alt="">`;
      }
    }
    flush();
    if (!html) return '';
    const has = (name) => { const e = kid(rPr, name); return e && wv(e) !== '0' && wv(e) !== 'false' && wv(e) !== 'none'; };
    if (index != null && /[^\s]/.test(html.replace(/<[^>]+>/g, ''))) {
      const hl = has('highlight');
      html = `<${hl ? 'mark' : 'span'} data-r="${index}"${open.size ? ` class="doc-cm" data-cids="${[...open].join(' ')}"` : ''}>${html}</${hl ? 'mark' : 'span'}>`;
    } else if (index != null) html = `<span data-r="${index}">${html}</span>`;
    if (has('b')) html = `<strong>${html}</strong>`;
    if (has('i')) html = `<em>${html}</em>`;
    if (has('u')) html = `<u>${html}</u>`;
    if (has('strike') || has('dstrike')) html = `<s>${html}</s>`;
    const va = wv(kid(rPr, 'vertAlign'));
    if (va === 'superscript') html = `<sup>${html}</sup>`;
    if (va === 'subscript') html = `<sub>${html}</sub>`;
    return html;
  }
  function inline(el, index) {
    let html = '';
    for (const c of kids(el)) {
      const n = c.localName;
      if (n === 'r') html += runHtml(c, index ? d.runs.push(c) - 1 : null);
      else if (n === 'hyperlink') {
        const rel = d.rels.get(c.getAttributeNS(RNS, 'id'));
        const inner = inline(c, index);
        html += rel?.external ? `<a href="${esc(rel.target)}">${inner}</a>` : inner;
      } else if (['ins', 'smartTag', 'customXml', 'fldSimple', 'sdtContent', 'moveTo'].includes(n)) html += inline(c, index);
      else if (n === 'sdt') html += inline(kid(c, 'sdtContent'), index);
      else if (n === 'commentRangeStart' && index) open.add(c.getAttributeNS(W, 'id'));
      else if (n === 'commentRangeEnd' && index) open.delete(c.getAttributeNS(W, 'id'));
      else if (n === 'bookmarkStart') { const nm = c.getAttributeNS(W, 'name'); if (nm && !nm.startsWith('_')) html += `<span id="bm-${esc(nm)}"></span>`; }
    }
    return html;
  }
  function paragraph(p, index = true) {
    const pPr = kid(p, 'pPr');
    const st = d.styles.get(wv(kid(pPr, 'pStyle'))) || { name: '' };
    const body = inline(p, index);
    const numPr = kid(pPr, 'numPr');
    if (numPr && kid(numPr, 'numId') && wv(kid(numPr, 'numId')) !== '0') {
      const numId = wv(kid(numPr, 'numId')), lvl = Number(wv(kid(numPr, 'ilvl')) || 0);
      const c = counters.get(numId) || [];
      c[lvl] = (c[lvl] || 0) + 1;
      c.length = lvl + 1;
      counters.set(numId, c);
      const fmt = d.num.get(numId)?.get(String(lvl)) || 'bullet';
      return `<p class="doc-li" style="padding-left:${1.5 * (lvl + 1)}em"><span class="doc-mk">${esc(listMark(fmt, c[lvl]))}</span>${body}</p>`;
    }
    const m = /^heading (\d)/.exec(st.name);
    const level = m ? Number(m[1]) : st.outline != null && Number(st.outline) < 6 ? Number(st.outline) + 1 : 0;
    if (st.name === 'title') return `<h1 class="doc-title">${body}</h1>`;
    if (st.name === 'subtitle') return `<p class="doc-subtitle">${body}</p>`;
    if (level) return `<h${Math.min(6, level)}>${body}</h${Math.min(6, level)}>`;
    if (/quote/.test(st.name)) return `<blockquote><p>${body}</p></blockquote>`;
    const align = wv(kid(pPr, 'jc'));
    return `<p${align === 'center' ? ' class="doc-center"' : ''}>${body || '<br>'}</p>`;
  }
  function blocks(el, index = true) {
    let html = '';
    for (const c of kids(el)) {
      const n = c.localName;
      if (n === 'p') html += paragraph(c, index);
      else if (n === 'tbl') html += `<table>${kids(c, 'tr').map((tr) => `<tr>${kids(tr, 'tc').map((tc) => `<td>${blocks(tc, index)}</td>`).join('')}</tr>`).join('')}</table>`;
      else if (n === 'sdt') html += blocks(kid(c, 'sdtContent'), index);
      else if (['customXml', 'ins', 'moveTo'].includes(n)) html += blocks(c, index);
    }
    return html;
  }
  out.push(blocks(d.xml.getElementsByTagNameNS(W, 'body')[0]));
  if (fnOrder.size) {
    out.push('<hr class="footnotes-sep"><section class="footnotes"><ol class="footnotes-list">');
    for (const [id] of [...fnOrder].sort((a, b) => a[1] - b[1])) out.push(`<li id="dfn-${esc(id)}">${blocks(d.footnotes.get(id), false)}</li>`);
    out.push('</ol></section>');
  }
  return out.join('');
}

export function commentHtml(d, id) {
  const c = d.comments.get(String(id));
  if (!c) return '';
  const who = c.getAttributeNS(W, 'author') || '';
  const when = c.getAttributeNS(W, 'date');
  const text = kids(c, 'p').map((p) => kids(p, 'r').map((r) => kids(r, 't').map((t) => t.textContent).join('')).join('')).filter(Boolean);
  return `<div class="doc-comment"><b>${esc(who)}</b>${when ? ` <small>${esc(new Date(when).toLocaleDateString())}</small>` : ''}${text.map((t) => `<p>${esc(t)}</p>`).join('')}</div>`;
}

// ---------- writing highlights and comments back ----------
const RPR_AFTER_HIGHLIGHT = ['u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'];
function el(xml, name, attrs = {}) {
  const e = xml.createElementNS(W, `w:${name}`);
  for (const [k, v] of Object.entries(attrs)) e.setAttributeNS(W, `w:${k}`, v);
  return e;
}
// Split a run so that characters [s, e) are in a run of their own; returns that run.
function isolate(xml, r, s, e) {
  const total = runChars(r);
  s = Math.max(0, Math.min(s, total)); e = Math.max(s, Math.min(e, total));
  if (s === 0 && e === total) return r;
  const make = (from, to) => {
    const n = r.cloneNode(false);
    const rPr = kid(r, 'rPr');
    if (rPr) n.append(rPr.cloneNode(true));
    let pos = 0;
    for (const c of kids(r)) {
      if (c.localName === 'rPr') continue;
      const len = charLen(c);
      const a = Math.max(from, pos), b = Math.min(to, pos + len);
      if (len === 0) { if ((pos >= from && pos < to) || (pos === total && to === total && from < to)) n.append(c.cloneNode(true)); }
      else if (a < b) {
        if (c.localName === 't') { const t = el(xml, 't'); t.setAttribute('xml:space', 'preserve'); t.textContent = c.textContent.slice(a - pos, b - pos); n.append(t); }
        else n.append(c.cloneNode(true));
      }
      pos += len;
    }
    return n;
  };
  const parts = [s > 0 && make(0, s), make(s, e), e < total && make(e, total)].filter(Boolean);
  for (const p of parts) r.parentNode.insertBefore(p, r);
  r.remove();
  return parts[s > 0 ? 1 : 0];
}
function setHighlight(xml, r, on) {
  let rPr = kid(r, 'rPr');
  if (!rPr) { if (!on) return; rPr = el(xml, 'rPr'); r.insertBefore(rPr, r.firstChild); }
  for (const h of kids(rPr).filter((c) => c.localName === 'highlight' || c.localName === 'highlightCs')) h.remove();
  if (!on) return;
  const before = kids(rPr).find((c) => RPR_AFTER_HIGHLIGHT.includes(c.localName));
  rPr.insertBefore(el(xml, 'highlight', { val: 'yellow' }), before || null);
}
// segs: [{ k, s, e }] in document order. Returns the isolated runs.
function isolateSegs(d, segs) {
  const runs = segs.map((g) => ({ g, r: d.runs[g.k] }));
  return runs.map(({ g, r }) => isolate(d.xml, r, g.s, g.e));
}
export function snapshot(d) {
  return { doc: serialize(d.xml), comments: d.commentsXml ? serialize(d.commentsXml) : null };
}
export function restore(d, snap) {
  d.xml = parse(snap.doc);
  d.commentsXml = snap.comments ? parse(snap.comments) : null;
  d.comments = new Map(d.commentsXml ? [...d.commentsXml.getElementsByTagNameNS(W, 'comment')].map((c) => [c.getAttributeNS(W, 'id'), c]) : []);
}
export function highlight(d, segs, on = true) {
  for (const r of isolateSegs(d, segs)) setHighlight(d.xml, r, on);
}
export function unhighlightRuns(d, ks) {
  for (const k of ks) if (d.runs[k]) setHighlight(d.xml, d.runs[k], false);
}
export function addComment(d, segs, text, author) {
  const runs = isolateSegs(d, segs);
  const first = runs[0], last = runs[runs.length - 1];
  let id = 0;
  for (const k of d.comments.keys()) id = Math.max(id, Number(k) + 1);
  for (const x of d.xml.getElementsByTagNameNS(W, 'commentRangeStart')) id = Math.max(id, Number(x.getAttributeNS(W, 'id')) + 1);
  const sid = String(id);
  first.parentNode.insertBefore(el(d.xml, 'commentRangeStart', { id: sid }), first);
  const end = el(d.xml, 'commentRangeEnd', { id: sid });
  last.parentNode.insertBefore(end, last.nextSibling);
  const ref = el(d.xml, 'r');
  ref.append(el(d.xml, 'commentReference', { id: sid }));
  end.parentNode.insertBefore(ref, end.nextSibling);
  if (!d.commentsXml) d.commentsXml = parse(`<w:comments xmlns:w="${W}"/>`);
  const c = el(d.commentsXml, 'comment', { id: sid, author: author || 'Flint', date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), initials: (author || 'F').split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() });
  for (const line of text.split(/\n+/)) {
    const p = el(d.commentsXml, 'p'), r = el(d.commentsXml, 'r'), t = el(d.commentsXml, 't');
    t.setAttribute('xml:space', 'preserve');
    t.textContent = line;
    r.append(t); p.append(r); c.append(p);
  }
  d.commentsXml.documentElement.append(c);
  d.comments.set(sid, c);
  return sid;
}

// The file to upload: the original package with only document.xml (and comments) replaced.
export async function packDocx(d) {
  const z = d.zip;
  z.file('word/document.xml', serialize(d.xml));
  if (d.commentsXml) {
    z.file('word/comments.xml', serialize(d.commentsXml));
    const relPath = 'word/_rels/document.xml.rels';
    let rels = await z.file(relPath)?.async('string') || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"></Relationships>`;
    if (!/relationships\/comments"/.test(rels)) {
      rels = rels.replace('</Relationships>', '<Relationship Id="rIdFlintComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>');
      z.file(relPath, rels);
      d.rels.set('rIdFlintComments', { type: 'comments', target: 'comments.xml' });
    }
    let ct = await z.file('[Content_Types].xml').async('string');
    if (!/PartName="\/word\/comments\.xml"/.test(ct)) {
      ct = ct.replace('</Types>', '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>');
      z.file('[Content_Types].xml', ct);
    }
  }
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

export async function mediaUrl(d, path) {
  if (d.media.has(path)) return d.media.get(path);
  const f = d.zip.file(path);
  if (!f) return '';
  const ext = path.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(new Blob([await f.async('arraybuffer')], { type: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' }[ext] || '' }));
  d.media.set(path, url);
  return url;
}
