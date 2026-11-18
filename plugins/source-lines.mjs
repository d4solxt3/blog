// Studio-only helpers for the live split preview: where each rendered block
// came from in the source, so the preview can scroll beside the cursor and a
// double-click can jump back to the line. Never used for the real site.

/**
 * A text that remembers, for every character, which offset of the original
 * text it came from — kept up to date through a series of regex replaces.
 * Replaced spans map entirely to the start of what they replaced.
 */
export class MappedText {
  constructor(text) {
    this.text = String(text);
    // pieces: [tStart, length, oStart, fixed] — fixed: every char maps to oStart
    this.pieces = [[0, this.text.length, 0, false]];
  }

  /** Original offset of transformed offset `t`. */
  origin(t) {
    let prev = null;
    for (const p of this.pieces) {
      const [s, len, o, fixed] = p;
      if (len > 0 && t >= s && t < s + len) return fixed ? o : o + (t - s);
      if (s <= t) prev = p;
    }
    // Past the end (or on an empty piece): the end of the nearest piece before it.
    return prev ? (prev[3] ? prev[2] : prev[2] + prev[1]) : 0;
  }

  /** Pieces of the current map covering [a, b), re-based to output position `at`. */
  slice(a, b, at) {
    const out = [];
    for (const [s, len, o, fixed] of this.pieces) {
      const lo = Math.max(a, s);
      const hi = Math.min(b, s + len);
      if (hi <= lo) continue;
      out.push([at + (lo - a), hi - lo, fixed ? o : o + (lo - s), fixed]);
    }
    return out;
  }

  replace(re, fn) {
    const src = this.text;
    let out = '';
    const pieces = [];
    let last = 0;
    for (const m of src.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      pieces.push(...this.slice(last, start, out.length));
      out += src.slice(last, start);
      const rep = String(fn(...m, start, src));
      pieces.push([out.length, rep.length, this.origin(start), true]);
      out += rep;
      last = end;
    }
    pieces.push(...this.slice(last, src.length, out.length));
    out += src.slice(last);
    this.text = out;
    this.pieces = pieces.length ? pieces : [[0, 0, 0, true]];
    return this;
  }
}

/** rehype: tag each top-level block with the source offset it starts at. */
export function rehypeSourceOffsets() {
  const first = (node) => {
    if (node.position?.start?.offset !== undefined) return node.position.start.offset;
    for (const c of node.children ?? []) {
      const o = first(c);
      if (o !== undefined) return o;
    }
    return undefined;
  };
  return (tree) => {
    for (const node of tree.children) {
      if (node.type !== 'element') continue;
      const o = first(node);
      if (o !== undefined) node.properties = { ...node.properties, dataSrc: String(o) };
    }
  };
}

/** Turn data-src="offset" (in transformed text) into data-line="n" (1-based, original text). */
export function offsetsToLines(html, mapped, original) {
  const starts = [0];
  for (let i = 0; i < original.length; i++) if (original[i] === '\n') starts.push(i + 1);
  const lineOf = (o) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return html.replace(/ data-src="(\d+)"/g, (_, t) => ` data-line="${lineOf(mapped.origin(Number(t)))}"`);
}
