// Verse text for Scripture popups. Seven public-domain translations ship with Flint
// (one file each, downloaded the first time it's used, then kept offline).
// The ESV comes from Crossway's free online service and needs your ESV key.
import { bookNumber, bookName } from './scripture.js';

export const TRANSLATIONS = [
  ['esv', 'ESV', 'English Standard Version (online)'],
  ['kjv', 'KJV', 'King James Version'],
  ['web', 'WEB', 'World English Bible'],
  ['nheb', 'NHEB', 'New Heart English Bible'],
  ['asv', 'ASV', 'American Standard Version'],
  ['ylt', 'YLT', 'Young’s Literal Translation'],
  ['bbe', 'BBE', 'Bible in Basic English'],
  ['webster', 'Webster', 'Webster Bible'],
];
export const shortName = (code) => (TRANSLATIONS.find((t) => t[0] === code) || [, code.toUpperCase()])[1];

const loaded = new Map();
export function loadTranslation(code) {
  if (!loaded.has(code)) {
    const p = fetch(`bible/${code}.json`).then((r) => { if (!r.ok) throw new Error('missing'); return r.json(); });
    loaded.set(code, p);
    p.catch(() => loaded.delete(code));
  }
  return loaded.get(code);
}

export function refText(ref) {
  const name = bookName(ref.abbr).replace(/^Psalms$/, 'Psalm');
  const ch2 = ref.ch2 || ref.ch;
  if (!ref.v) return ch2 !== ref.ch ? `${name} ${ref.ch}–${ch2}` : `${name} ${ref.ch}`;
  if (ch2 !== ref.ch) return `${name} ${ref.ch}:${ref.v}–${ch2}:${ref.v2 || ''}`.replace(/:$/, '');
  return ref.v2 && ref.v2 !== ref.v ? `${name} ${ref.ch}:${ref.v}–${ref.v2}` : `${name} ${ref.ch}:${ref.v}`;
}

// Returns { verses: [{ c, v, t }] } for offline translations, or { text } for ESV.
export async function passage(code, ref, esvKey) {
  if (code === 'esv') return esv(ref, esvKey);
  const bible = await loadTranslation(code);
  const book = bible[bookNumber(ref.abbr) - 1] || [];
  const verses = [];
  const last = ref.ch2 || ref.ch;
  for (let c = ref.ch; c <= last && verses.length < 250; c++) {
    const chap = book[c - 1];
    if (!chap) break;
    const from = c === ref.ch && ref.v ? ref.v : 1;
    const to = c === last && ref.v2 ? ref.v2 : c === ref.ch && ref.v && !ref.v2 && last === ref.ch ? ref.v : chap.length;
    for (let v = from; v <= Math.min(to, chap.length); v++) if (chap[v - 1]) verses.push({ c, v, t: chap[v - 1] });
  }
  return { verses };
}

const esvCache = new Map();
async function esv(ref, key) {
  if (!key) { const e = new Error('Add your ESV key under Settings → Scripture to see the ESV.'); e.code = 'nokey'; throw e; }
  const q = refText(ref).replace(/–/g, '-');
  if (esvCache.has(q)) return esvCache.get(q);
  const params = new URLSearchParams({
    q, 'include-passage-references': 'false', 'include-verse-numbers': 'true', 'include-first-verse-numbers': 'true',
    'include-footnotes': 'false', 'include-headings': 'false', 'include-short-copyright': 'true',
    'indent-paragraphs': '0', 'indent-poetry': 'false', 'indent-declares': '0', 'indent-psalm-doxology': '0',
  });
  let r;
  try { r = await fetch(`https://api.esv.org/v3/passage/text/?${params}`, { headers: { Authorization: `Token ${key.replace(/^Token\s+/i, '').trim()}` } }); }
  catch { const e = new Error('The ESV needs an internet connection.'); e.code = 'offline'; throw e; }
  if (r.status === 401 || r.status === 403) { const e = new Error('The ESV key wasn’t accepted. Check it under Settings → Scripture.'); e.code = 'badkey'; throw e; }
  if (!r.ok) { const e = new Error('The ESV service didn’t respond. Try again in a moment.'); e.code = 'down'; throw e; }
  const j = await r.json();
  const out = { text: (j.passages || []).join('\n').trim() };
  esvCache.set(q, out);
  return out;
}
