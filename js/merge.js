// Three-way merge of plain text by lines.
// base   = the version both sides started from
// local  = this device's version
// remote = the vault's current version
// Returns { ok: true, text } when the edits don't touch the same lines,
// otherwise { ok: false } so the user decides. It never guesses.

const MAX_CELLS = 6_500_000;

// Edits that turn `a` into `b`, as hunks over a's line range [s, e).
export function diffHunks(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  const W = m + 1;
  const L = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const hunks = [];
  let i = 0, j = 0, cur = null;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      if (cur) { hunks.push(cur); cur = null; }
      i++; j++;
    } else if (j < m && (i === n || L[i * W + j + 1] >= L[(i + 1) * W + j])) {
      if (!cur) cur = { s: pre + i, e: pre + i, lines: [] };
      cur.lines.push(B[j]); j++;
    } else {
      if (!cur) cur = { s: pre + i, e: pre + i, lines: [] };
      i++; cur.e = pre + i;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

const same = (x, y) => x.s === y.s && x.e === y.e && x.lines.length === y.lines.length && x.lines.every((l, k) => l === y.lines[k]);

export function merge3(base, local, remote) {
  if (local === remote) return { ok: true, text: local };
  if (base === local) return { ok: true, text: remote };
  if (base === remote) return { ok: true, text: local };
  const B = base.split('\n');
  const hl = diffHunks(B, local.split('\n'));
  const hr = diffHunks(B, remote.split('\n'));
  if (!hl || !hr) return { ok: false };
  const out = [];
  let pos = 0, i = 0, j = 0;
  const apply = (h) => { for (let k = pos; k < h.s; k++) out.push(B[k]); out.push(...h.lines); pos = h.e; };
  while (i < hl.length || j < hr.length) {
    const a = hl[i], b = hr[j];
    if (a && b) {
      // Conservative: touching or overlapping ranges count as a conflict.
      if (a.s <= b.e && b.s <= a.e) {
        if (same(a, b)) { apply(a); i++; j++; continue; }
        return { ok: false };
      }
      if (a.s < b.s) { apply(a); i++; } else { apply(b); j++; }
    } else if (a) { apply(a); i++; } else { apply(b); j++; }
  }
  for (let k = pos; k < B.length; k++) out.push(B[k]);
  return { ok: true, text: out.join('\n') };
}
