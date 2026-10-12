// Finds where a clipped note came from (in its properties) and formats citations.
// Personal notes without a web source return null, and no citation is offered.

const KEYS = {
  url: ['source', 'url', 'link', 'source_url', 'sourceurl', 'source-url', 'origin', 'canonical', 'canonical_url', 'original_url', 'web', 'href', 'clipped_from', 'from'],
  title: ['title', 'headline', 'source_title'],
  author: ['author', 'authors', 'creator', 'creators', 'by', 'byline', 'writer'],
  site: ['site', 'site_name', 'sitename', 'publisher', 'website', 'publication', 'source_name', 'domain'],
  published: ['published', 'date_published', 'publish_date', 'published_date', 'pubdate', 'date_posted', 'date'],
  accessed: ['clipped', 'date_clipped', 'clip_date', 'accessed', 'date_accessed', 'saved', 'captured', 'created'],
};
const unquote = (s) => s.trim().replace(/^["']|["']$/g, '').trim();
const unlink = (s) => s.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/^@/, '').trim();

export function parseFrontmatter(text) {
  const out = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_\- ]+?)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase().replace(/\s+/g, '_');
    let val = kv[2].trim();
    if (!val) {
      const list = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) list.push(unquote(lines[++i].replace(/^\s*-\s+/, '')));
      out[key] = list;
    } else if (/^\[.*\]$/.test(val)) {
      out[key] = val.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else out[key] = unquote(val);
  }
  return out;
}

const pick = (fm, kind) => {
  for (const k of KEYS[kind]) {
    const v = fm[k];
    if (Array.isArray(v) ? v.length : v) return v;
  }
  return null;
};
const URL_RE = /https?:\/\/[^\s<>)"'\]]+/i;

function parseDate(v) {
  if (!v) return null;
  const s = String(Array.isArray(v) ? v[0] : v).trim();
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return { y: +m[1], m: +m[2] };
  m = /^(\d{4})$/.exec(s);
  if (m) return { y: +m[1] };
  const t = Date.parse(s);
  if (!Number.isNaN(t)) { const d = new Date(t); return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }; }
  return null;
}

const ORG_HINT = /\b(inc|llc|ltd|news|press|team|staff|editors|editorial|university|institute|association|society|church|ministries|foundation|council|department|times|post|journal|magazine|bbc|cnn|npr|reuters)\b|&/i;
export function parseName(raw) {
  const s = unlink(raw).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (ORG_HINT.test(s) || s.split(' ').length > 4) return { org: s };
  if (s.includes(',')) { const [last, first] = s.split(',').map((x) => x.trim()); return { first, last }; }
  const parts = s.split(' ');
  if (parts.length === 1) return { org: s };
  const last = parts.pop();
  return { first: parts.join(' '), last };
}

function siteFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Returns source details, or null for personal notes.
export function findSource(text, noteName) {
  const fm = parseFrontmatter(text);
  let url = pick(fm, 'url');
  if (Array.isArray(url)) url = url.find((u) => URL_RE.test(u)) || null;
  url = url && URL_RE.exec(url)?.[0];
  if (!url) {
    // Some clippers put "Source: https://…" near the top of the note instead.
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split(/\r?\n/).slice(0, 20);
    for (const line of body) {
      if (/^\s*(?:>\s*)?(?:[*_]{1,2})?(source|url|link|original|clipped from|saved from|from)(?:[*_]{1,2})?\s*[:\-–]/i.test(line)) {
        const u = URL_RE.exec(line);
        if (u) { url = u[0]; break; }
      }
    }
  }
  if (!url) return null;
  url = url.replace(/[.,;:]+$/, '');
  let authors = pick(fm, 'author');
  if (typeof authors === 'string') authors = authors.split(/\s*(?:;| and |&)\s*/);
  authors = (authors || []).map(parseName).filter(Boolean);
  const h1 = /^#\s+(.+)$/m.exec(text.replace(/^---\r?\n[\s\S]*?\r?\n---/, ''));
  const title = unlink(String(pick(fm, 'title') || h1?.[1] || noteName || '')).trim();
  let site = pick(fm, 'site');
  site = site ? unlink(String(Array.isArray(site) ? site[0] : site)) : siteFromUrl(url);
  return { url, title, authors, site, published: parseDate(pick(fm, 'published')), accessed: parseDate(pick(fm, 'accessed')) };
}

// ---------- formatting ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MLA_MON = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const IEEE_MON = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
const today = () => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }; };
const dMla = (t) => [t.d, t.m && MLA_MON[t.m - 1], t.y].filter(Boolean).join(' ');
const dLong = (t) => (t.m ? `${MONTHS[t.m - 1]}${t.d ? ` ${t.d}` : ''}, ${t.y}` : String(t.y));
const dDMY = (t) => [t.d, t.m && MONTHS[t.m - 1], t.y].filter(Boolean).join(' ');
const dIeee = (t) => (t.m ? `${IEEE_MON[t.m - 1]}${t.d ? ` ${t.d}` : ''}, ${t.y}` : String(t.y));
const noProto = (u) => u.replace(/^https?:\/\//, '');
const initials = (first) => first.split(/[\s-]+/).filter(Boolean).map((w) => `${w[0].toUpperCase()}.`).join(' ');
const shortTitle = (t) => { const w = t.split(/\s+/); return w.length > 4 ? `${w.slice(0, 4).join(' ')}…` : t; };
const endDot = (s) => (/[.?!]$/.test(s) ? s : `${s}.`);
const I = (s, html) => (html ? `<i>${s}</i>` : s);
const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const fullName = (a) => a.org || `${a.first} ${a.last}`;
const invName = (a) => a.org || `${a.last}, ${a.first}`;
const lastName = (a) => a.org || a.last;
const apaName = (a) => a.org || `${a.last}, ${initials(a.first)}`;
const ieeeName = (a) => a.org || `${initials(a.first)} ${a.last}`;
const harvardName = (a) => a.org || `${a.last}, ${initials(a.first).replace(/ /g, '')}`;
const joinAnd = (list, and = 'and', oxford = true) => (list.length < 2 ? list.join('') : list.length === 2 ? `${list[0]} ${and} ${list[1]}` : `${list.slice(0, -1).join(', ')}${oxford ? ',' : ''} ${and} ${list[list.length - 1]}`);

export const STYLES = { mla: 'MLA', apa: 'APA', chicago: 'Chicago', turabian: 'Turabian', harvard: 'Harvard', ieee: 'IEEE' };

// kind: 'bib' (works cited / reference list / bibliography) or 'note' (footnote or in-text citation)
export function formatCitation(src, style, kind, html = false) {
  const e = (s) => (html ? escHtml(s) : s);
  const A = src.authors;
  const title = e(src.title);
  const site = e(src.site || '');
  const url = e(src.url);
  const pub = src.published;
  const acc = src.accessed || today();
  const sameAsSite = A.length === 1 && A[0].org && A[0].org.toLowerCase() === (src.site || '').toLowerCase();

  if (style === 'mla') {
    if (kind === 'note') {
      const who = A.length === 0 || sameAsSite ? `“${e(shortTitle(src.title))}”` : A.length === 1 ? e(lastName(A[0])) : A.length === 2 ? `${e(lastName(A[0]))} and ${e(lastName(A[1]))}` : `${e(lastName(A[0]))} et al.`;
      return `(${who})`;
    }
    const who = A.length === 0 || sameAsSite ? '' : A.length === 1 ? `${endDot(e(invName(A[0])))} ` : A.length === 2 ? `${e(invName(A[0]))}, and ${e(fullName(A[1]))}. ` : `${e(invName(A[0]))}, et al. `;
    const parts = [`${who}“${endDot(title)}” ${site ? `${I(site, html)}, ` : ''}${pub ? `${dMla(pub)}, ` : ''}${e(noProto(src.url))}.`];
    if (!pub) parts.push(`Accessed ${dMla(acc)}.`);
    return parts.join(' ');
  }

  if (style === 'apa') {
    const year = pub ? pub.y : 'n.d.';
    if (kind === 'note') {
      const who = A.length === 0 ? I(e(shortTitle(src.title)), html) : A.length === 1 ? e(lastName(A[0])) : A.length === 2 ? `${e(lastName(A[0]))} & ${e(lastName(A[1]))}` : `${e(lastName(A[0]))} et al.`;
      return `(${who}, ${year})`;
    }
    const date = pub ? (pub.m ? `(${pub.y}, ${MONTHS[pub.m - 1]}${pub.d ? ` ${pub.d}` : ''})` : `(${pub.y})`) : '(n.d.)';
    const names = A.map((a) => e(apaName(a)));
    const who = names.length === 0 ? '' : names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
    const siteBit = site && !sameAsSite ? ` ${endDot(site)}` : '';
    const t = /[?!]$/.test(title) ? I(title, html) : `${I(title, html)}.`;
    return who
      ? `${endDot(who)} ${date}. ${t}${siteBit} ${url}`
      : `${t} ${date}.${siteBit} ${url}`;
  }

  if (style === 'chicago' || style === 'turabian') {
    if (kind === 'note') {
      const names = A.map((a) => e(fullName(a)));
      const who = names.length === 0 || sameAsSite ? '' : names.length <= 3 ? `${joinAnd(names)}, ` : `${names[0]} et al., `;
      const when = pub ? `${dLong(pub)}` : `accessed ${dLong(acc)}`;
      return `${who}“${title},” ${site ? `${site}, ` : ''}${when}, ${url}.`;
    }
    const names = A.map((a, i) => e(i === 0 ? invName(a) : fullName(a)));
    // First author inverted, so even two names take a comma: "Doe, Jane, and John Smith."
    const list = names.length === 2 && !A[0].org ? `${names[0]}, and ${names[1]}` : joinAnd(names);
    const who = names.length === 0 || sameAsSite ? '' : `${endDot(list)} `;
    const when = pub ? `${dLong(pub)}.` : `Accessed ${dLong(acc)}.`;
    return `${who}“${endDot(title)}” ${site ? `${endDot(site)} ` : ''}${when} ${url}.`;
  }

  if (style === 'harvard') {
    const year = pub ? pub.y : 'no date';
    if (kind === 'note') {
      const who = A.length === 0 ? I(e(shortTitle(src.title)), html) : A.length === 1 ? e(lastName(A[0])) : A.length === 2 ? `${e(lastName(A[0]))} and ${e(lastName(A[1]))}` : `${e(lastName(A[0]))} et al.`;
      return `(${who}, ${year})`;
    }
    const names = A.map((a) => e(harvardName(a)));
    const who = names.length ? `${joinAnd(names, 'and', false)} ` : '';
    return `${who}(${year}) ${I(title, html)}. Available at: ${url} (Accessed: ${dDMY(acc)}).`;
  }

  // IEEE
  if (kind === 'note') return '[1]';
  const names = A.map((a) => e(ieeeName(a)));
  const who = names.length ? `${joinAnd(names)}, ` : '';
  return `[1] ${who}“${title},” ${site ? `${I(site, html)}. ` : ''}Accessed: ${dIeee(acc)}. [Online]. Available: ${url}`;
}

export const isFootnoteStyle = (style) => style === 'chicago' || style === 'turabian';

// The text to paste: the quoted excerpt with its citation.
export function composeCopy(excerpt, src, style, kind, withExcerpt, html = false) {
  const cite = formatCitation(src, style, kind, html);
  const q = excerpt ? (html ? `“${escHtml(excerpt)}”` : `“${excerpt}”`) : '';
  if (!withExcerpt || !q) {
    if (kind === 'note' && isFootnoteStyle(style)) return html ? `<p>1. ${cite}</p>` : `1. ${cite}`;
    return html ? `<p>${cite}</p>` : cite;
  }
  if (kind === 'note' && isFootnoteStyle(style)) {
    return html ? `<p>${q}<sup>1</sup></p><p>1. ${cite}</p>` : `${q}¹\n\n1. ${cite}`;
  }
  if (kind === 'note') return html ? `<p>${q} ${cite}</p>` : `${q} ${cite}`;
  return html ? `<p>${q}</p><p>${cite}</p>` : `${q}\n\n${cite}`;
}
