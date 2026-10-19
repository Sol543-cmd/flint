// Turns a text selection in the reading view into an Obsidian highlight (==text==)
// at the exact matching spot in the markdown source, or removes one.
// Every plan is checked again by app.js (re-render and compare) before it's saved.
// If anything is ambiguous, nothing is changed and an explanation is returned.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Markdown that can sit between visible characters without being visible itself.
const GAP = String.raw`(?:\*\*|__|\*|_|~~|==|\x60|\[\^[^\]\n]+\]|\^\[[^\]\n]*\]|!?\[\[(?:[^\]|\n]*\|)?|\]\]|\]\([^)\n]*\)|\[|<[^>\n]*>)*`;
const LINK_RE = /!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)/g;
const CODE_RE = /(`+)[^`\n][\s\S]*?\1/g;
const TAG_RE = /(?<![^\s(])#[\p{L}\p{N}_\-/]+/gu;
const HL_RE = /==(?=\S)((?:(?!\n[ \t]*\n)[\s\S])*?\S)==/g;
const WORD = /[\p{L}\p{N}_]/u;

const overlaps = (ranges, a, b) => ranges.some(([s, e]) => a < e && s < b);
const spans = (src, re) => { const out = []; re.lastIndex = 0; let m; while ((m = re.exec(src))) out.push([m.index, m.index + m[0].length]); return out; };

// Parts of the source that never show as normal text: frontmatter, code blocks, comments.
export function hiddenRanges(src) {
  const out = [];
  const fm = /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(src);
  if (fm) out.push([0, fm[0].length]);
  let pos = 0, fence = null, fstart = 0;
  for (const line of src.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^\s{0,3}[`~]+\s*$/.test(line)) { out.push([fstart, pos + line.length]); fence = null; }
    } else if (m && !(fm && pos < fm[0].length)) { fence = m[1]; fstart = pos; }
    pos += line.length + 1;
  }
  if (fence) out.push([fstart, src.length]);
  for (const re of [/%%[\s\S]*?%%/g, /<!--[\s\S]*?-->/g]) {
    for (const [a, b] of spans(src, re)) if (!overlaps(out, a, a + 1)) out.push([a, b]);
  }
  return out;
}

export const normalize = (s) => s.replace(/\s+/g, ' ');

// Count possibly-overlapping occurrences, the same way matches are found in the source.
export function occurrences(hay, needle) {
  const out = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

function existingHighlights(src, hidden) {
  const code = spans(src, CODE_RE);
  return spans(src, HL_RE).filter(([a, b]) => !overlaps(hidden, a, b) && !code.some(([s, e]) => a >= s && b <= e));
}

export function planHighlight(src, selected, occurrence, renderedCount) {
  const norm = normalize(selected).trim();
  if (!norm) return { error: 'Select some text first.' };
  if (norm.length > 2000) return { error: 'That’s a lot of text. Highlight one paragraph at a time.' };
  const parts = [...norm].map((ch) => (ch === ' ' ? String.raw`\s+(?:>\s*)*` : (/[^\p{L}\p{N}\s]/u.test(ch) ? String.raw`\\?` : '') + esc(ch)));
  const re = new RegExp(parts.join(GAP), 'gu');
  const hidden = hiddenRanges(src);
  const matches = [];
  let m;
  while ((m = re.exec(src))) {
    if (!overlaps(hidden, m.index, m.index + m[0].length)) matches.push([m.index, m.index + m[0].length]);
    re.lastIndex = m.index + 1;
  }
  if (!matches.length) return { error: 'Flint couldn’t match that selection to the note’s text. Try selecting within one paragraph.' };
  let pick = null;
  if (matches.length === renderedCount) pick = matches[occurrence];
  else if (matches.length === 1 && renderedCount === 1) pick = matches[0];
  if (!pick) return { error: 'That text appears more than once in this note. Select a few more words so Flint can find the right spot.' };

  let [s, e] = pick;
  // Snap to whole words, like Kindle.
  while (s > 0 && WORD.test(src[s - 1]) && WORD.test(src[s])) s--;
  while (e < src.length && WORD.test(src[e]) && WORD.test(src[e - 1])) e++;
  // Never cut through a link, inline code or a tag.
  const whole = [...spans(src, LINK_RE), ...spans(src, CODE_RE), ...spans(src, TAG_RE)];
  for (let k = 0; k < 3; k++) {
    for (const [a, b] of whole) {
      if (a < s && s < b) s = a;
      if (a < e && e < b) e = b;
    }
  }
  // Keep bold/italic/strike markers balanced.
  for (const mk of ['**', '__', '~~', '*', '_']) {
    const seg = src.slice(s, e).replace(mk.length === 1 ? /\*\*|__/g : /$^/g, '');
    const count = seg.split(mk).length - 1;
    if (count % 2) {
      if (src.slice(s - mk.length, s) === mk) s -= mk.length;
      else if (src.slice(e, e + mk.length) === mk) e += mk.length;
    }
  }
  while (s < e && /\s/.test(src[s])) s++;
  while (e > s && /\s/.test(src[e - 1])) e--;
  const seg = src.slice(s, e);
  if (!seg) return { error: 'Select some text first.' };
  if (existingHighlights(src, hidden).some(([a, b]) => a < e && s < b) || seg.includes('==')) {
    return { error: 'Part of that is already highlighted. Tap the highlight to remove it first.' };
  }
  if (/\n[ \t]*\n/.test(seg) || /\n[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|#{1,6}[ \t]|>|\|)/.test(seg)) {
    return { error: 'Highlight within one paragraph or list item at a time.' };
  }
  if (src[s - 1] === '=' || src[e] === '=') return { error: 'Flint can’t place a highlight right there.' };
  return { text: `${src.slice(0, s)}==${seg}==${src.slice(e)}`, norm, start: s };
}

export function planRemove(src, index, renderedCount) {
  const list = existingHighlights(src, hiddenRanges(src));
  if (list.length !== renderedCount || !list[index]) return { error: 'Flint couldn’t find that highlight in the note. You can remove it in edit view.' };
  const [a, b] = list[index];
  return { text: src.slice(0, a) + src.slice(a + 2, b - 2) + src.slice(b) };
}

// Readable text of a bit of markdown (for the notebook and for matching notes to highlights).
export function plainOf(md) {
  return md
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, (m, a, b) => (a ? b : b.split('#')[0].split('/').pop()))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|[^\p{L}\p{N}])[*_]([^*_\n]+)[*_](?=[^\p{L}\p{N}]|$)/gu, '$1$2')
    .replace(/\\([^\w\s])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every ==highlight== in a note, in order: { start, end, text } with readable text,
// plus "occ": how many identical highlights came before it in the same note.
export function listHighlights(src) {
  const list = existingHighlights(src, hiddenRanges(src)).map(([a, b]) => ({ start: a, end: b, text: plainOf(src.slice(a + 2, b - 2)) }));
  const seen = new Map();
  for (const h of list) { const k = h.text.toLowerCase(); h.occ = seen.get(k) || 0; seen.set(k, h.occ + 1); }
  return list;
}
