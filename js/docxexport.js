// Builds a real Word document (.docx) from a note's reading view.
// The Word library loads only when it's first needed.
let loading = null;
export function loadDocx() {
  if (window.docx) return Promise.resolve(window.docx);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/docx.min.js';
      s.onload = () => resolve(window.docx);
      s.onerror = () => { loading = null; reject(new Error('Couldn’t load the Word exporter. Check your connection and try again.')); };
      document.head.append(s);
    });
  }
  return loading;
}

export const PAPER_DXA = { letter: [12240, 15840], a4: [11906, 16838], legal: [12240, 20160], a5: [8391, 11906] };
export const MARGIN_DXA = { narrow: 720, normal: 1440, wide: 2160 };
const SIZE_HALFPT = { small: 21, normal: 24, large: 28 };
const LINE = { single: 264, onehalf: 360, double: 480 };
const FONT = { serif: 'Georgia', sans: 'Calibri', reading: 'Georgia' };
const BLOCK = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR', 'SECTION', 'DETAILS', 'FIGURE', 'DL']);

// images: Map(img element -> { data: ArrayBuffer, type: 'png'|'jpg'|'gif'|'bmp', w, h })
export async function buildDocx(root, opts) {
  const D = await loadDocx();
  const [pw, ph] = PAPER_DXA[opts.paper] || PAPER_DXA.letter;
  const landscape = opts.orient === 'landscape';
  const margin = MARGIN_DXA[opts.margin] || 1440;
  const contentDxa = (landscape ? ph : pw) - 2 * margin;
  const contentPx = Math.floor((contentDxa / 1440) * 96);
  const images = opts.images || new Map();
  let numInstance = 0;

  const textRun = (text, st) => new D.TextRun({
    text, bold: st.b || undefined, italics: st.i || undefined, strike: st.s || undefined,
    shading: st.hl && opts.highlights !== false ? { type: D.ShadingType.CLEAR, fill: 'FFF09A', color: 'auto' } : undefined,
    font: st.code ? 'Courier New' : undefined, size: st.code ? Math.round((SIZE_HALFPT[opts.size] || 24) * 0.85) : undefined,
    color: st.link ? '0563C1' : undefined, underline: st.link ? {} : undefined,
    superScript: st.sup || undefined, subScript: st.sub || undefined,
  });

  const imageRun = (img) => {
    const d = images.get(img);
    if (!d) return null;
    const scale = Math.min(1, contentPx / d.w, 700 / d.h);
    return new D.ImageRun({ type: d.type, data: d.data, transformation: { width: Math.round(d.w * scale), height: Math.round(d.h * scale) } });
  };

  function inline(node, st, out) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        const t = c.data.replace(/\s+/g, ' ');
        if (t) out.push(textRun(t, st));
        continue;
      }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName;
      if (tag === 'BR') { out.push(new D.TextRun({ break: 1 })); continue; }
      if (tag === 'IMG') { const r = imageRun(c); if (r) out.push(r); continue; }
      if (tag === 'INPUT') { if (c.type === 'checkbox') out.push(textRun(c.checked ? '☑ ' : '☐ ', st)); continue; }
      const ns = { ...st };
      if (tag === 'STRONG' || tag === 'B') ns.b = true;
      if (tag === 'EM' || tag === 'I') ns.i = true;
      if (tag === 'DEL' || tag === 'S') ns.s = true;
      if (tag === 'MARK') ns.hl = true;
      if (tag === 'CODE') ns.code = true;
      if (tag === 'SUP') ns.sup = true;
      if (tag === 'SUB') ns.sub = true;
      if (tag === 'A') {
        const href = c.getAttribute('href') || '';
        if (/^https?:/i.test(href)) {
          const kids = [];
          inline(c, { ...ns, link: true }, kids);
          if (kids.length) out.push(new D.ExternalHyperlink({ link: href, children: kids }));
          continue;
        }
      }
      if (BLOCK.has(tag) && out.length) out.push(new D.TextRun({ break: 1 }));
      inline(c, ns, out);
    }
    return out;
  }
  const trimRuns = (runs) => runs;

  function para(runs, ctx, extra = {}) {
    const p = { children: trimRuns(runs), ...extra };
    if (ctx.quote) {
      p.indent = { left: 567 * ctx.quote };
      p.border = { left: { style: D.BorderStyle.SINGLE, size: 12, color: ctx.callout ? '6A55E3' : 'BBBBBB', space: 8 } };
    }
    return new D.Paragraph(p);
  }

  function blocks(node, ctx, out) {
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const tmp = document.createElement('div');
      buf.forEach((n) => tmp.append(n.cloneNode(true)));
      buf = [];
      if (tmp.textContent.trim() || tmp.querySelector('img')) out.push(para(inline(tmp, {}, []), ctx));
    };
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3 || (c.nodeType === 1 && !BLOCK.has(c.tagName) && !c.classList.contains('embed'))) {
        if (c.nodeType === 1 && c.tagName === 'IMG') { flush(); const r = imageRun(c); if (r) out.push(new D.Paragraph({ children: [r] })); continue; }
        buf.push(c);
        continue;
      }
      if (c.nodeType !== 1) continue;
      flush();
      const tag = c.tagName;
      if (/^H[1-6]$/.test(tag)) {
        out.push(new D.Paragraph({ heading: D.HeadingLevel[`HEADING_${tag[1]}`], children: inline(c, {}, []) }));
      } else if (tag === 'P') {
        out.push(para(inline(c, {}, []), ctx));
      } else if (tag === 'UL' || tag === 'OL') {
        const inst = ++numInstance;
        for (const li of c.children) {
          if (li.tagName !== 'LI') continue;
          const own = li.cloneNode(true);
          own.querySelectorAll(':scope > ul, :scope > ol').forEach((x) => x.remove());
          const isTask = !!own.querySelector(':scope > input[type=checkbox]');
          const level = Math.min(ctx.level || 0, 5);
          out.push(new D.Paragraph({
            children: inline(own, {}, []),
            ...(isTask ? { indent: { left: 720 * (level + 1) } } : { numbering: { reference: tag === 'OL' ? 'num' : 'bul', level, instance: tag === 'OL' ? inst : undefined } }),
          }));
          for (const sub of li.querySelectorAll(':scope > ul, :scope > ol')) {
            const holder = document.createElement('div');
            holder.append(sub.cloneNode(true));
            blocks(holder, { ...ctx, level: level + 1 }, out);
          }
        }
      } else if (tag === 'BLOCKQUOTE') {
        const isCallout = c.classList.contains('callout');
        blocks(c, { ...ctx, quote: (ctx.quote || 0) + 1, callout: isCallout }, out);
      } else if (tag === 'DIV' && c.classList.contains('callout-title')) {
        out.push(para([textRun(c.textContent, { b: true })], ctx));
      } else if (tag === 'PRE') {
        const lines = c.textContent.replace(/\n$/, '').split('\n');
        const runs = [];
        lines.forEach((l, i) => { if (i) runs.push(new D.TextRun({ break: 1 })); runs.push(textRun(l || ' ', { code: true })); });
        out.push(new D.Paragraph({ children: runs, shading: { type: D.ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } }));
      } else if (tag === 'TABLE') {
        const rows = [...c.querySelectorAll('tr')];
        const cols = Math.max(1, ...rows.map((r) => r.children.length));
        const w = Math.floor(contentDxa / cols);
        const widths = Array(cols).fill(w);
        out.push(new D.Table({
          width: { size: w * cols, type: D.WidthType.DXA },
          columnWidths: widths,
          rows: rows.map((r) => new D.TableRow({
            children: Array.from({ length: cols }, (_, k) => {
              const cell = r.children[k];
              const head = cell?.tagName === 'TH';
              return new D.TableCell({
                width: { size: w, type: D.WidthType.DXA },
                shading: head ? { type: D.ShadingType.CLEAR, fill: 'EDEDED', color: 'auto' } : undefined,
                margins: { top: 60, bottom: 60, left: 100, right: 100 },
                children: [new D.Paragraph({ children: cell ? inline(cell, head ? { b: true } : {}, []) : [] })],
              });
            }),
          })),
        }));
        out.push(new D.Paragraph({ children: [] }));
      } else if (tag === 'HR') {
        out.push(new D.Paragraph({ children: [], border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: 'BBBBBB', space: 1 } } }));
      } else if (c.classList.contains('embed-head')) {
        out.push(para([textRun(c.textContent, { i: true })], ctx));
      } else {
        blocks(c, ctx, out);
      }
    }
    flush();
    return out;
  }

  const children = [];
  if (opts.title) children.push(new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun(opts.title)] }));
  const sourcePara = opts.sourceLine && new D.Paragraph({ children: [new D.TextRun({ text: opts.sourceLine, italics: true, color: '666666', size: 20 })], spacing: { after: 240 } });
  // The source line goes right under the title (the note's own first heading, if it has one).
  const firstH1 = !opts.title ? root.querySelector(':scope > h1') : null;
  if (sourcePara && !firstH1) children.push(sourcePara);
  if (firstH1) {
    children.push(new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: inline(firstH1, {}, []) }));
    if (sourcePara) children.push(sourcePara);
    firstH1.remove();
  }
  blocks(root, {}, children);

  const font = FONT[opts.font] || 'Georgia';
  const size = SIZE_HALFPT[opts.size] || 24;
  const bullet = ['•', '◦', '▪'];
  const numFmt = [D.LevelFormat.DECIMAL, D.LevelFormat.LOWER_LETTER, D.LevelFormat.LOWER_ROMAN];
  const doc = new D.Document({
    creator: 'Flint',
    title: opts.title || opts.docTitle || 'Note',
    styles: {
      default: {
        document: { run: { font, size }, paragraph: { spacing: { after: 160, line: LINE[opts.spacing] || 264, lineRule: D.LineRuleType.AUTO } } },
        title: { run: { font, size: size + 16, bold: true }, paragraph: { spacing: { after: 120 } } },
        heading1: { run: { font, size: size + 10, bold: true }, paragraph: { spacing: { before: 360, after: 120 } } },
        heading2: { run: { font, size: size + 6, bold: true }, paragraph: { spacing: { before: 280, after: 100 } } },
        heading3: { run: { font, size: size + 3, bold: true }, paragraph: { spacing: { before: 240, after: 80 } } },
        heading4: { run: { font, size, bold: true } },
        heading5: { run: { font, size, bold: true, italics: true } },
        heading6: { run: { font, size, italics: true } },
      },
    },
    numbering: {
      config: [
        { reference: 'bul', levels: [0, 1, 2, 3, 4, 5].map((l) => ({ level: l, format: D.LevelFormat.BULLET, text: bullet[l % 3], alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } } })) },
        { reference: 'num', levels: [0, 1, 2, 3, 4, 5].map((l) => ({ level: l, format: numFmt[l % 3], text: `%${l + 1}.`, alignment: D.AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } } })) },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: pw, height: ph, orientation: landscape ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT },
          margin: { top: margin, bottom: margin, left: margin, right: margin },
        },
      },
      children,
    }],
  });
  return D.Packer.toBlob(doc);
}
