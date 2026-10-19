// Renders Obsidian-flavoured Markdown to safe HTML using markdown-it, which follows
// the CommonMark standard closely (so emphasis and bold behave like Obsidian).
// Adds [[wikilinks]], ![[embeds]], #tags, ==highlights==, %%comments%%, block IDs,
// task lists and footnotes ([^1] and ^[inline]). Callouts are finished in app.js.
const { markdownit, markdownitFootnote, DOMPurify } = window;

let ctx = { htmlMode: 'text', hideLangs: new Set(), resolve: () => true };

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const decodeURISafe = (s) => { try { return decodeURI(s); } catch { return s; } };
const splitPipe = (s) => { const i = s.indexOf('|'); return i < 0 ? [s, ''] : [s.slice(0, i).replace(/\\$/, ''), s.slice(i + 1)]; };
const display = (p) => p.split('/').pop().replace(/\.md$/i, '');

export function isRealTag(t) {
  if (!/\p{L}/u.test(t)) return false;
  if (/^_/.test(t) && (/^_(ftn|edn|ftnref|ednref|toc|ref|hlk|heading|goback|gjdgxs|msocom|anchor|bookmark|cmnt)/i.test(t) || /\d$/.test(t))) return false;
  return true;
}

const decoder = document.createElement('textarea');
function htmlToText(html) {
  const s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|iframe|object|svg|button)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|details|summary|dt|dd)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  decoder.innerHTML = s;
  return decoder.value;
}
const BLOCK_HTML = /^\s*<(div|p|table|details|section|center|h[1-6]|ul|ol|pre|blockquote|figure|aside|article|header|footer|nav|dl|form|fieldset|hr|style|script|iframe)\b/i;

const md = markdownit({ html: true, breaks: true, linkify: true, typographer: false }).use(markdownitFootnote);
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

// ---------- inline rules ----------
function embedRule(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x21 || !state.src.startsWith('![[', state.pos)) return false;
  const m = /^!\[\[([^\]\n]+?)\]\]/.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) state.push('obs_embed', '', 0).meta = { target: m[1] };
  state.pos += m[0].length;
  return true;
}
function wikiRule(state, silent) {
  if (!state.src.startsWith('[[', state.pos)) return false;
  const m = /^\[\[([^\]\n]+?)\]\]/.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (!silent) state.push('obs_wikilink', '', 0).meta = { target: m[1] };
  state.pos += m[0].length;
  return true;
}
function markRule(state, silent) {
  const src = state.src, start = state.pos;
  if (!src.startsWith('==', start) || src[start + 2] === '=' || /\s/.test(src[start + 2] || ' ')) return false;
  let e = start + 2;
  for (;;) {
    e = src.indexOf('==', e + 1);
    if (e < 0 || e >= state.posMax) return false;
    if (!/\s/.test(src[e - 1]) && src[e + 2] !== '=') break;
  }
  if (/\n[ \t]*\n/.test(src.slice(start, e))) return false;
  if (!silent) {
    state.push('mark_open', 'mark', 1);
    const max = state.posMax;
    state.pos = start + 2;
    state.posMax = e;
    state.md.inline.tokenize(state);
    state.posMax = max;
    state.push('mark_close', 'mark', -1);
  }
  state.pos = e + 2;
  return true;
}
function tagRule(state, silent) {
  const pos = state.pos;
  if (state.src.charCodeAt(pos) !== 0x23) return false;
  if (pos > 0 && !/[\s(]/.test(state.src[pos - 1])) return false;
  const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(state.src.slice(pos));
  if (!m || !isRealTag(m[1])) return false;
  if (!silent) state.push('obs_tag', '', 0).meta = { tag: m[1] };
  state.pos += m[0].length;
  return true;
}
function blockIdRule(state, silent) {
  const pos = state.pos;
  if (state.src.charCodeAt(pos) !== 0x5e || state.src[pos - 1] !== ' ') return false;
  const m = /^\^([A-Za-z0-9-]+)(?=\n|$)/.exec(state.src.slice(pos, state.posMax));
  if (!m) return false;
  if (!silent) state.push('obs_blockid', '', 0).meta = { id: m[1] };
  state.pos += m[0].length;
  return true;
}
md.inline.ruler.before('image', 'obs_embed', embedRule);
md.inline.ruler.before('link', 'obs_wikilink', wikiRule);
md.inline.ruler.before('emphasis', 'obs_mark', markRule);
md.inline.ruler.before('emphasis', 'obs_tag', tagRule);
md.inline.ruler.before('emphasis', 'obs_blockid', blockIdRule);

// GFM task lists: "- [ ] item" and "- [x] item".
md.core.ruler.after('inline', 'obs_tasks', (state) => {
  const t = state.tokens;
  for (let i = 2; i < t.length; i++) {
    if (t[i].type !== 'inline' || t[i - 1].type !== 'paragraph_open' || t[i - 2].type !== 'list_item_open') continue;
    const first = t[i].children[0];
    const m = first && first.type === 'text' && /^\[([ xX])\][ \t]/.exec(first.content);
    if (!m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
    box.meta = { task: true };
    t[i].children.unshift(box);
  }
});

// Every block remembers which lines of the note it came from (used for fast, exact highlighting).
md.core.ruler.push('obs_lines', (state) => {
  for (const t of state.tokens) {
    if (t.map && t.nesting === 1 && /^(paragraph|heading|list_item|tr)_open$/.test(t.type)) { t.attrSet('data-sl', String(t.map[0])); t.attrSet('data-el', String(t.map[1])); }
  }
});

// ---------- rendering ----------
const R = md.renderer.rules;
R.obs_embed = (tokens, i) => {
  const [link, alias] = splitPipe(tokens[i].meta.target);
  const file = link.split('#')[0];
  if (IMG_RE.test(file)) {
    const alt = alias && !/^\d+(x\d+)?$/.test(alias) ? alias : display(file);
    return `<img data-embed="${esc(tokens[i].meta.target)}" alt="${esc(alt)}">`;
  }
  return `<span class="embed" data-embed="${esc(link)}"></span>`;
};
R.obs_wikilink = (tokens, i) => {
  const [link, alias] = splitPipe(tokens[i].meta.target);
  const [page, ...rest] = link.split('#');
  const heading = rest.join('#');
  const label = alias || (page ? display(page) + (heading && !heading.startsWith('^') ? ` › ${heading}` : '') : heading);
  const ok = !page || ctx.resolve(page);
  return `<a class="wikilink${ok ? '' : ' unresolved'}" href="#" data-target="${esc(page)}" data-heading="${esc(heading)}">${esc(label)}</a>`;
};
R.obs_tag = (tokens, i) => `<a class="tag" href="#" data-tag="${esc(tokens[i].meta.tag)}">#${esc(tokens[i].meta.tag)}</a>`;
R.obs_blockid = (tokens, i) => `<span class="blockid" data-block="${esc(tokens[i].meta.id)}"></span>`;

function cleanHtml(html, inline) {
  if (ctx.htmlMode === 'render') return html;
  const block = !inline && (BLOCK_HTML.test(html) || /\n./.test(html.trim()));
  if (ctx.htmlMode === 'hide' && block) return '';
  const text = htmlToText(html).trim();
  if (!text || ctx.htmlMode === 'hide') return '';
  return block ? `<p>${esc(text).replace(/\n+/g, '<br>')}</p>` : esc(text);
}
R.html_block = (tokens, i) => cleanHtml(tokens[i].content, false);
R.html_inline = (tokens, i) => (tokens[i].meta?.task ? tokens[i].content : cleanHtml(tokens[i].content, true));

const fence = R.fence;
R.fence = (tokens, i, opts, env, self) => {
  const lang = (tokens[i].info || '').trim().split(/\s+/)[0].toLowerCase();
  if (lang && ctx.hideLangs.has(lang)) return '';
  return fence(tokens, i, opts, env, self);
};
R.image = (tokens, i, opts, env, self) => {
  const src = tokens[i].attrGet('src') || '';
  if (src && !/^(https?:|data:|blob:)/i.test(src)) return `<img data-embed="${esc(decodeURISafe(src))}" alt="${esc(tokens[i].content || '')}">`;
  return self.renderToken(tokens, i, opts);
};
R.link_open = (tokens, i, opts, env, self) => {
  const href = tokens[i].attrGet('href') || '';
  if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#')) {
    const [page, ...h] = decodeURISafe(href).split('#');
    return `<a class="wikilink" href="#" data-target="${esc(page.replace(/\.md$/i, ''))}" data-heading="${esc(h.join('#'))}">`;
  }
  return self.renderToken(tokens, i, opts);
};
// Footnote numbers without brackets, and no "↩︎" arrows (Flint adds its own controls).
R.footnote_caption = (tokens, i) => String(Number(tokens[i].meta.id + 1));
R.footnote_anchor = () => '';
R.footnote_block_open = () => '<section class="footnotes"><ol class="footnotes-list">\n';
R.footnote_block_close = () => '</ol></section>\n';

function outsideFences(text, fn) {
  const out = [];
  let buf = [];
  let fence = null;
  const flush = () => { if (buf.length) { out.push(fn(buf.join('\n'))); buf = []; } };
  for (const line of text.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^\s{0,3}[`~]+\s*$/.test(line)) fence = null;
    } else if (m) { flush(); fence = m[1]; out.push(line); } else buf.push(line);
  }
  flush();
  return out.join('\n');
}

export const FRONTMATTER = /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/;

let docCounter = 0;
export function renderMarkdown(text, opts = {}) {
  ctx = { ...ctx, ...opts };
  // Hidden parts are blanked out rather than removed, so line numbers still match the note.
  let src = text.replace(FRONTMATTER, (m) => m.replace(/[^\n]/g, ''));
  src = outsideFences(src, (s) => s.replace(/%%[\s\S]*?%%/g, (m) => m.replace(/[^\n]/g, '')));
  const html = md.render(src, { docId: `d${++docCounter}` });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'dialog'] });
}

// Lines that hold "- [ ]" style tasks, in document order, skipping code and frontmatter.
export function findTaskLines(text) {
  const lines = text.split('\n');
  const out = [];
  let k = 0;
  const fm = FRONTMATTER.exec(text);
  if (fm) k = fm[0].split('\n').length - (fm[0].endsWith('\n') ? 1 : 0);
  let fence = null;
  for (; k < lines.length; k++) {
    const line = lines[k];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && /^\s{0,3}[`~]+\s*$/.test(line)) fence = null; continue; }
    if (f) { fence = f[1]; continue; }
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]\s/.exec(line + ' ');
    if (m) out.push({ line: k, col: m[1].length, checked: m[2] !== ' ' });
  }
  return out;
}
