// Finds Bible references in rendered text ("John 3:16", "1 Cor 13:4–7", "Ps. 23",
// "Rom 8:28; 12:1-2") and turns them into links that open Logos.
// This only changes what's shown on screen, never the note file.

// [Logos abbreviation, chapters, names (longest first), numbered prefix]
const BOOKS = [
  ['Ge', 50, ['Genesis', 'Gen', 'Gn', 'Ge']],
  ['Ex', 40, ['Exodus', 'Exod', 'Exo', 'Ex']],
  ['Le', 27, ['Leviticus', 'Lev', 'Lv', 'Le']],
  ['Nu', 36, ['Numbers', 'Num', 'Nm', 'Nb', 'Nu']],
  ['Dt', 34, ['Deuteronomy', 'Deut', 'Dt', 'De']],
  ['Jos', 24, ['Joshua', 'Josh', 'Jsh', 'Jos']],
  ['Jdg', 21, ['Judges', 'Judg', 'Jdgs', 'Jdg', 'Jg']],
  ['Ru', 4, ['Ruth', 'Rth', 'Ru']],
  ['1Sa', 31, ['Samuel', 'Sam', 'Sm', 'Sa'], 1],
  ['2Sa', 24, ['Samuel', 'Sam', 'Sm', 'Sa'], 2],
  ['1Ki', 22, ['Kings', 'Kgs', 'Kin', 'Ki'], 1],
  ['2Ki', 25, ['Kings', 'Kgs', 'Kin', 'Ki'], 2],
  ['1Ch', 29, ['Chronicles', 'Chron', 'Chr', 'Ch'], 1],
  ['2Ch', 36, ['Chronicles', 'Chron', 'Chr', 'Ch'], 2],
  ['Ezr', 10, ['Ezra', 'Ezr']],
  ['Ne', 13, ['Nehemiah', 'Neh', 'Ne']],
  ['Es', 10, ['Esther', 'Esth', 'Est', 'Es']],
  ['Job', 42, ['Job', 'Jb']],
  ['Ps', 150, ['Psalms', 'Psalm', 'Pslm', 'Psa', 'Pss', 'Ps']],
  ['Pr', 31, ['Proverbs', 'Prov', 'Prv', 'Pro', 'Pr']],
  ['Ec', 12, ['Ecclesiastes', 'Eccles', 'Eccl', 'Ecc', 'Qoh', 'Ec']],
  ['So', 8, ['Song of Solomon', 'Song of Songs', 'Song of Sol', 'Canticles', 'Song', 'Cant', 'SoS', 'Sg']],
  ['Is', 66, ['Isaiah', 'Isa', 'Is']],
  ['Je', 52, ['Jeremiah', 'Jer', 'Jr', 'Je']],
  ['La', 5, ['Lamentations', 'Lam', 'La']],
  ['Eze', 48, ['Ezekiel', 'Ezek', 'Ezk', 'Eze']],
  ['Da', 12, ['Daniel', 'Dan', 'Dn', 'Da']],
  ['Ho', 14, ['Hosea', 'Hos', 'Ho']],
  ['Joe', 3, ['Joel', 'Jl']],
  ['Am', 9, ['Amos', 'Am']],
  ['Ob', 1, ['Obadiah', 'Obad', 'Ob']],
  ['Jon', 4, ['Jonah', 'Jnh', 'Jon']],
  ['Mic', 7, ['Micah', 'Mic', 'Mc']],
  ['Na', 3, ['Nahum', 'Nah', 'Na']],
  ['Hab', 3, ['Habakkuk', 'Hab', 'Hb']],
  ['Zep', 3, ['Zephaniah', 'Zeph', 'Zep', 'Zp']],
  ['Hag', 2, ['Haggai', 'Hag', 'Hg']],
  ['Zec', 14, ['Zechariah', 'Zech', 'Zec', 'Zc']],
  ['Mal', 4, ['Malachi', 'Mal', 'Ml']],
  ['Mt', 28, ['Matthew', 'Matt', 'Mat', 'Mt']],
  ['Mk', 16, ['Mark', 'Mrk', 'Mar', 'Mk', 'Mr']],
  ['Lk', 24, ['Luke', 'Luk', 'Lk']],
  ['Jn', 21, ['John', 'Jhn', 'Jn']],
  ['Ac', 28, ['Acts', 'Act', 'Ac']],
  ['Ro', 16, ['Romans', 'Rom', 'Rm', 'Ro']],
  ['1Co', 16, ['Corinthians', 'Cor', 'Co'], 1],
  ['2Co', 13, ['Corinthians', 'Cor', 'Co'], 2],
  ['Ga', 6, ['Galatians', 'Gal', 'Ga']],
  ['Eph', 6, ['Ephesians', 'Ephes', 'Eph']],
  ['Php', 4, ['Philippians', 'Phil', 'Php', 'Pp']],
  ['Col', 4, ['Colossians', 'Col']],
  ['1Th', 5, ['Thessalonians', 'Thess', 'Thes', 'Th'], 1],
  ['2Th', 3, ['Thessalonians', 'Thess', 'Thes', 'Th'], 2],
  ['1Ti', 6, ['Timothy', 'Tim', 'Ti'], 1],
  ['2Ti', 4, ['Timothy', 'Tim', 'Ti'], 2],
  ['Tt', 3, ['Titus', 'Tit']],
  ['Phm', 1, ['Philemon', 'Philem', 'Phm', 'Pm']],
  ['Heb', 13, ['Hebrews', 'Heb']],
  ['Jas', 5, ['James', 'Jas', 'Jm']],
  ['1Pe', 5, ['Peter', 'Pet', 'Pt', 'Pe'], 1],
  ['2Pe', 3, ['Peter', 'Pet', 'Pt', 'Pe'], 2],
  ['1Jn', 5, ['John', 'Jhn', 'Joh', 'Jn'], 1],
  ['2Jn', 1, ['John', 'Jhn', 'Joh', 'Jn'], 2],
  ['3Jn', 1, ['John', 'Jhn', 'Joh', 'Jn'], 3],
  ['Jud', 1, ['Jude', 'Jud']],
  ['Re', 22, ['Revelation', 'Revelations', 'Rev', 'Rv', 'Re']],
];

const PREFIX = {
  1: '(?:1st|First|1|I(?!I))',
  2: '(?:2nd|Second|2|II(?!I))',
  3: '(?:3rd|Third|3|III)',
};

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');

// Short names that are also everyday words need a verse ("Is 53:5", not "Is 5").
const NEEDS_VERSE = new Set(['Is', 'Am', 'Ex', 'Ob', 'Na', 'Ac', 'Act', 'Ge', 'Le', 'De', 'Ne', 'Es', 'Da', 'Ho', 'La', 'Je', 'Co', 'Ti', 'Pe', 'Th', 'Sa', 'Ch', 'Ki', 'Pp', 'Mr', 'Mar', 'Mat', 'Pro', 'Song', 'Job', 'Jb', 'Jon', 'Mic', 'Col', 'Tit', 'Cant', 'Sg', 'Rm', 'Ro', 'Jm', 'Pm', 'Re', 'Rv', 'Mc', 'Ml', 'Hg', 'Hb', 'Zp', 'Zc', 'Jl', 'Jr', 'Dn', 'Lv', 'Nb', 'Nm', 'Gn', 'Dt', 'Jg', 'Ru', 'Kin']);

const entries = [];
for (const [abbr, chapters, names, num] of BOOKS) {
  for (const name of names) {
    const src = num ? `${PREFIX[num]}\\s?${escRe(name)}` : escRe(name);
    entries.push({ abbr, chapters, name, src, re: new RegExp(`^${src}$`), oneChapter: chapters === 1, needsVerse: NEEDS_VERSE.has(name) });
  }
}
// Numbered books first so "1 John" wins over "John"; then longer names first.
entries.sort((a, b) => (/^\(\?:/.test(b.src) ? 1 : 0) - (/^\(\?:/.test(a.src) ? 1 : 0) || b.name.length - a.name.length);

const DASH = '\\s?[-–—]\\s?';
const MAIN = new RegExp(
  `(?<![\\p{L}\\p{N}])(${entries.map((e) => e.src).join('|')})\\.?\\s?(\\d{1,3})(?:\\s?[:.]\\s?(\\d{1,3})[a-c]?(?:${DASH}(\\d{1,3})(?:[:.](\\d{1,3}))?)?|${DASH}(\\d{1,3})(?![:.]\\d))?(?![\\p{L}\\d])`,
  'gu',
);
const MORE = /^(\s*[;,]\s*)(\d{1,3})(?:[:.](\d{1,3})[a-c]?(?:\s?[-–—]\s?(\d{1,3}))?|\s?[-–—]\s?(\d{1,3}))?(?![\p{L}\d]|[:.]\d)/u;

function whichBook(text) {
  const t = text.replace(/\s+/g, ' ');
  return entries.find((e) => e.re.test(t));
}

// A reference: { abbr, ch, v } plus the text it came from.
export function findReferences(text) {
  const out = [];
  MAIN.lastIndex = 0;
  let m;
  while ((m = MAIN.exec(text))) {
    const book = whichBook(m[1]);
    if (!book) continue;
    let ch = Number(m[2]);
    let v = m[3] ? Number(m[3]) : null;
    if (book.oneChapter && !v) { v = ch; ch = 1; }
    if (book.needsVerse && !m[3]) continue;
    if (ch < 1 || ch > book.chapters || (v !== null && (v < 1 || v > 176))) continue;
    out.push({ start: m.index, end: m.index + m[0].length, abbr: book.abbr, ch, v });
    // Follow-on references that reuse the book: "Rom 8:28; 12:1-2" or "John 3:16, 18".
    let pos = m.index + m[0].length;
    let lastCh = ch, hadVerse = v !== null;
    for (;;) {
      const r = MORE.exec(text.slice(pos));
      if (!r) break;
      let c, vv;
      if (r[3]) { c = Number(r[2]); vv = Number(r[3]); }
      else if (r[1].includes(',') && hadVerse) { c = lastCh; vv = Number(r[2]); }
      else if (r[1].includes(';')) { c = Number(r[2]); vv = null; }
      else break;
      if (c < 1 || c > book.chapters || (vv !== null && vv > 176)) break;
      const s = pos + r[1].length;
      out.push({ start: s, end: pos + r[0].length, abbr: book.abbr, ch: c, v: vv });
      pos += r[0].length;
      lastCh = c; hadVerse = vv !== null;
    }
    MAIN.lastIndex = pos;
  }
  return out;
}

export function logosUrl(ref, { mode = 'app', version = '' } = {}) {
  const loc = `${ref.abbr}${ref.ch}${ref.v ? `.${ref.v}` : ''}`;
  if (mode === 'refly') return `https://ref.ly/${loc}${version ? `;${version.toLowerCase()}` : ''}`;
  return `logosres:${version || 'ESV'};ref=Bible.${loc}`;
}

const SKIP = 'a, code, pre, .callout-title, .embed-head, script, style';

// Wrap references in text nodes under root with <a class="scripture">.
export function linkScripture(root, opts) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : /\d/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const refs = findReferences(node.data);
    if (!refs.length) continue;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const r of refs) {
      if (r.start > at) frag.append(node.data.slice(at, r.start));
      const a = document.createElement('a');
      a.className = 'scripture';
      a.href = logosUrl(r, opts);
      a.dataset.ref = `${r.abbr} ${r.ch}${r.v ? `:${r.v}` : ''}`;
      a.textContent = node.data.slice(r.start, r.end);
      frag.append(a);
      at = r.end;
    }
    if (at < node.data.length) frag.append(node.data.slice(at));
    node.replaceWith(frag);
  }
}
