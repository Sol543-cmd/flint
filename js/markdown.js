// Renders Obsidian-flavoured markdown to safe HTML.
// Supports [[wikilinks]], ![[embeds]], #tags, ==highlights==, %%comments%%,
// callouts (handled after render in app.js) and frontmatter (hidden).
const { marked, DOMPurify } = window;

let ctx = { htmlMode: 'text', hideLangs: new Set(), resolve: () => true };

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const decodeURISafe = (s) => { try { return decodeURI(s); } catch { return s; } };
const splitPipe = (s) => { const i = s.indexOf('|'); return i < 0 ? [s, ''] : [s.slice(0, i).replace(/\\$/, ''), s.slice(i + 1)]; };
const display = (p) => p.split('/').pop().replace(/\.md$/i, '');

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

marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
marked.use({
  extensions: [
    {
      name: 'embed', level: 'inline',
      start(src) { const i = src.indexOf('![['); return i < 0 ? undefined : i; },
      tokenizer(src) { const m = /^!\[\[([^\]\n]+?)\]\]/.exec(src); if (m) return { type: 'embed', raw: m[0], target: m[1] }; },
      renderer(t) {
        const [link, alias] = splitPipe(t.target);
        const file = link.split('#')[0];
        if (IMG_RE.test(file)) {
          const alt = alias && !/^\d+(x\d+)?$/.test(alias) ? alias : display(file);
          return `<img data-embed="${esc(t.target)}" alt="${esc(alt)}">`;
        }
        return `<span class="embed" data-embed="${esc(link)}"></span>`;
      },
    },
    {
      name: 'wikilink', level: 'inline',
      start(src) { const i = src.indexOf('[['); return i < 0 ? undefined : i; },
      tokenizer(src) { const m = /^\[\[([^\]\n]+?)\]\]/.exec(src); if (m) return { type: 'wikilink', raw: m[0], target: m[1] }; },
      renderer(t) {
        const [link, alias] = splitPipe(t.target);
        const [page, ...rest] = link.split('#');
        const heading = rest.join('#');
        const label = alias || (page ? display(page) + (heading && !heading.startsWith('^') ? ` › ${heading}` : '') : heading);
        const ok = !page || ctx.resolve(page);
        return `<a class="wikilink${ok ? '' : ' unresolved'}" href="#" data-target="${esc(page)}" data-heading="${esc(heading)}">${esc(label)}</a>`;
      },
    },
    {
      // Obsidian block IDs (" ^abc123" at the end of a paragraph) become invisible link anchors.
      name: 'blockid', level: 'inline',
      start(src) { const m = / \^[A-Za-z0-9-]+(?=\n|$)/.exec(src); return m ? m.index : undefined; },
      tokenizer(src) { const m = /^ \^([A-Za-z0-9-]+)(?=\n|$)/.exec(src); if (m) return { type: 'blockid', raw: m[0], id: m[1] }; },
      renderer(t) { return `<span class="blockid" data-block="${esc(t.id)}"></span>`; },
    },
    {
      name: 'highlight', level: 'inline',
      start(src) { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
        if (m) return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer(t) { return `<mark>${this.parser.parseInline(t.tokens)}</mark>`; },
    },
    {
      name: 'tag', level: 'inline',
      start(src) { const m = /(^|[\s(])#[^\s#]/.exec(src); return m ? m.index + m[1].length : undefined; },
      tokenizer(src) {
        const m = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(src);
        if (m) return { type: 'tag', raw: m[0], tag: m[1] };
      },
      renderer(t) { return `<a class="tag" href="#" data-tag="${esc(t.tag)}">#${esc(t.tag)}</a>`; },
    },
  ],
  renderer: {
    html(html) {
      if (ctx.htmlMode === 'render') return html;
      const block = BLOCK_HTML.test(html) || /\n./.test(html.trim());
      if (ctx.htmlMode === 'hide' && block) return '';
      const text = htmlToText(html).trim();
      if (!text || ctx.htmlMode === 'hide') return '';
      return block ? `<p>${esc(text).replace(/\n+/g, '<br>')}</p>` : esc(text);
    },
    code(code, info) {
      const lang = (info || '').trim().split(/\s+/)[0].toLowerCase();
      if (lang && ctx.hideLangs.has(lang)) return '';
      return false;
    },
    image(href, title, text) {
      if (href && !/^(https?:|data:|blob:)/i.test(href)) return `<img data-embed="${esc(decodeURISafe(href))}" alt="${esc(text || '')}">`;
      return false;
    },
    link(href, title, text) {
      if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#')) {
        const [page, ...h] = decodeURISafe(href).split('#');
        return `<a class="wikilink" href="#" data-target="${esc(page.replace(/\.md$/i, ''))}" data-heading="${esc(h.join('#'))}">${text}</a>`;
      }
      return false;
    },
  },
});

// Run fn on the parts of the text that are outside fenced code blocks.
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

export function renderMarkdown(text, opts = {}) {
  ctx = { ...ctx, ...opts };
  let src = text.replace(FRONTMATTER, '');
  src = outsideFences(src, (s) => s.replace(/%%[\s\S]*?%%/g, ''));
  const html = marked.parse(src);
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
