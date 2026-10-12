// Reads a note aloud with the phone's own voices, one sentence at a time,
// highlighting the sentence being read. Works offline.
const synth = window.speechSynthesis;
export const supported = !!synth && 'SpeechSynthesisUtterance' in window;

const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, dd, dt, .callout-title, blockquote';
const SKIP = 'pre, .embed, script, style, .missing';

// Split the visible text under root into sentences, each with a DOM Range.
export function buildSentences(root) {
  const groups = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const block = node.parentElement.closest(BLOCK) || root;
    if (!groups.has(block)) groups.set(block, []);
    groups.get(block).push(node);
  }
  const seg = window.Intl?.Segmenter ? new Intl.Segmenter(document.documentElement.lang || 'en', { granularity: 'sentence' }) : null;
  const out = [];
  for (const nodes of groups.values()) {
    let text = '';
    const starts = [];
    for (const n of nodes) { starts.push(text.length); text += n.data; }
    const pieces = seg ? [...seg.segment(text)].map((s) => [s.index, s.index + s.segment.length])
      : [...text.matchAll(/[^.!?]+[.!?]*["”’)]*\s*/g)].map((m) => [m.index, m.index + m[0].length]);
    for (let [a, b] of pieces) {
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      const said = text.slice(a, b);
      if (!/[\p{L}\p{N}]/u.test(said)) continue;
      const at = (pos, end) => {
        let i = starts.length - 1;
        while (i > 0 && (end ? starts[i] >= pos : starts[i] > pos)) i--;
        return [nodes[i], pos - starts[i]];
      };
      const range = document.createRange();
      range.setStart(...at(a, false));
      range.setEnd(...at(b, true));
      out.push({ text: said, range });
    }
  }
  return out;
}

export class Listener {
  constructor({ onSentence, onState }) {
    this.onSentence = onSentence;
    this.onState = onState;
    this.list = [];
    this.i = 0;
    this.playing = false;
    this.rate = 1;
    this.voice = null;
    this.lock = null;
    this.token = 0;
  }
  load(list, start = 0) { this.stop(); this.list = list; this.i = Math.max(0, Math.min(start, list.length - 1)); }
  get active() { return this.list.length > 0; }
  async keepAwake(on) {
    try {
      if (on && !this.lock && navigator.wakeLock) { this.lock = await navigator.wakeLock.request('screen'); this.lock.addEventListener?.('release', () => { this.lock = null; }); }
      if (!on && this.lock) { await this.lock.release(); this.lock = null; }
    } catch { /* not available */ }
  }
  speak() {
    const s = this.list[this.i];
    if (!s) { this.stop(); return; }
    const token = ++this.token;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(s.text);
    u.rate = this.rate;
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; }
    u.onend = () => {
      if (token !== this.token || !this.playing) return;
      if (this.i < this.list.length - 1) { this.i++; this.speak(); } else this.stop();
    };
    u.onerror = (e) => { if (token === this.token && e.error !== 'interrupted' && e.error !== 'canceled') this.stop(); };
    this.onSentence?.(s, this.i);
    synth.speak(u);
  }
  play() {
    if (!this.list.length) return;
    this.playing = true;
    this.keepAwake(true);
    this.speak();
    this.onState?.();
  }
  pause() {
    this.playing = false;
    this.token++;
    synth.cancel();
    this.keepAwake(false);
    this.onState?.();
  }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  skip(d) {
    this.i = Math.max(0, Math.min(this.list.length - 1, this.i + d));
    if (this.playing) this.speak(); else this.onSentence?.(this.list[this.i], this.i);
  }
  setRate(r) { this.rate = r; if (this.playing) this.speak(); }
  setVoice(v) { this.voice = v; if (this.playing) this.speak(); }
  stop() {
    this.playing = false;
    this.token++;
    synth?.cancel();
    this.keepAwake(false);
    this.list = [];
    this.i = 0;
    this.onState?.();
  }
}

export function voices() {
  if (!supported) return [];
  return synth.getVoices();
}
