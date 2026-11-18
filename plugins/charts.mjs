// Charts and diagrams drawn as plain inline SVG at build time (no browser JS).
// Used by remark-charts.mjs, which runs in the one Markdown pipeline shared
// by the site, MDX and the studio / admin previews — so they all match.
//
// Colours come from CSS variables (--chart-1…4, see src/styles/prose.css), so
// both themes work without re-rendering. Series also differ by dash pattern
// and marker shape and are labelled directly, never by colour alone.

// ---------------------------------------------------------------- hast helpers
/** Element with hast-style properties (className, strokeDasharray, ariaLabel…). */
export const el = (tagName, properties = {}, children = []) => ({
  type: 'element',
  tagName,
  properties,
  children: children.filter((c) => c !== null && c !== undefined && c !== false).map((c) => (typeof c === 'string' || typeof c === 'number' ? { type: 'text', value: String(c) } : c)),
});
const r1 = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- data parsing
/**
 * Data as CSV text, a Markdown table, or a YAML list of objects.
 * Returns { columns: string[], rows: (string|number)[][] }.
 */
export function parseData(data) {
  // JSON text (from a <Chart data={`...`} /> or a pasted export)
  if (typeof data === 'string' && /^\s*[[{]/.test(data)) {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error('data: looks like JSON but does not parse');
    }
  }
  // { columns: [...], rows: [[...], ...] }
  if (data && !Array.isArray(data) && typeof data === 'object' && Array.isArray(data.columns) && Array.isArray(data.rows)) {
    return { columns: data.columns.map(String), rows: data.rows.map((r) => data.columns.map((_, i) => cell(r[i]))) };
  }
  if (Array.isArray(data)) {
    if (!data.length || typeof data[0] !== 'object') throw new Error('data: expected a list of rows');
    const columns = Object.keys(data[0]);
    return { columns, rows: data.map((o) => columns.map((c) => cell(o[c]))) };
  }
  const text = String(data ?? '').trim();
  if (!text) throw new Error('data: empty');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let table;
  if (lines[0].startsWith('|')) {
    table = lines
      .filter((l) => !/^\|?\s*:?-{2,}/.test(l))
      .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  } else {
    const header = lines[0].replace(/"(?:[^"]|"")*"/g, '');
    const separator = header.includes('\t') ? '\t' : header.includes(';') && !header.includes(',') ? ';' : ',';
    table = delimitedRows(text, separator);
  }
  const [columns, ...body] = table;
  if (!body.length) throw new Error('data: needs a header row and at least one data row');
  const badRow = body.findIndex((row) => row.length !== columns.length);
  if (badRow >= 0) throw new Error('data: row ' + (badRow + 2) + ' has a different number of columns');
  return { columns, rows: body.map((row) => row.map(cell)) };
}

// CSV cells may contain delimiters, line breaks and escaped double quotes.
function delimitedRows(text, separator) {
  const result = [];
  let row = [], value = '', quoted = false;
  function finishRow() {
    row.push(value.trim());
    if (row.some((cell) => cell !== '')) result.push(row);
    row = [];
    value = '';
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === separator) {
      row.push(value.trim());
      value = '';
    } else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      finishRow();
    } else value += ch;
  }
  if (quoted) throw new Error('data: unclosed quotation mark in a CSV cell');
  finishRow();
  return result;
}
const cell = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  const s = String(v ?? '').trim();
  return s !== '' && Number.isFinite(Number(s)) ? Number(s) : s;
};

// ---------------------------------------------------------------- scales
/** "Nice" ticks for [lo, hi]: steps of 1, 2 or 5 × 10^k, about `count` of them. */
export function niceTicks(lo, hi, count = 5) {
  if (lo === hi) [lo, hi] = lo === 0 ? [0, 1] : [Math.min(0, lo), Math.max(0, hi)];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  // Computing each tick by index also works when adjacent values are so
  // close that adding one step to a large number rounds back to itself.
  if (!(step > 0) || ![start, end, end - start].every(Number.isFinite)) {
    throw new Error('data: axis range exceeds floating-point precision; rescale the values');
  }
  const ticks = new Set();
  const intervals = Math.min(Math.round((end - start) / step), count + 3);
  for (let i = 0; i <= intervals; i++) ticks.add(start + step * i);
  return { ticks: [...ticks], lo: start, hi: end, step };
}
const fmt = (n) => n !== 0 && Math.abs(n) < 0.001 ? n.toExponential(2) : n.toLocaleString('en', { maximumSignificantDigits: 8 });
const linear = (d0, d1, r0, r1_) => (v) => (d1 === d0 ? (r0 + r1_) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1_ - r0));

// ---------------------------------------------------------------- chart
const DASH = ['', '6 4', '2 3', '10 3 2 3'];
const MARK = ['circle', 'square', 'triangle', 'diamond'];
const TYPES = new Set(['line', 'area', 'bar', 'hbar', 'scatter']);

function marker(shape, x, y, size = 3.6) {
  const s = size;
  if (shape === 'square') return el('rect', { x: r1(x - s), y: r1(y - s), width: r1(2 * s), height: r1(2 * s) });
  if (shape === 'triangle') return el('path', { d: `M${r1(x)} ${r1(y - s * 1.2)}L${r1(x + s * 1.1)} ${r1(y + s * 0.8)}L${r1(x - s * 1.1)} ${r1(y + s * 0.8)}Z` });
  if (shape === 'diamond') return el('path', { d: `M${r1(x)} ${r1(y - s * 1.3)}L${r1(x + s * 1.3)} ${r1(y)}L${r1(x)} ${r1(y + s * 1.3)}L${r1(x - s * 1.3)} ${r1(y)}Z` });
  return el('circle', { cx: r1(x), cy: r1(y), r: s });
}

/**
 * spec: { type, title, caption, alt, x: {label}, y: {label, zero, unit}, data }
 * uid: unique id stem for this figure (title/desc ids).
 * Returns { svg, table, summary } (hast nodes + a text summary).
 */
export function renderChart(spec, uid) {
  const type = String(spec.type ?? 'line').toLowerCase();
  if (!TYPES.has(type)) throw new Error(`type: use one of ${[...TYPES].join(', ')}`);
  const { columns, rows } = parseData(spec.data);
  if (columns.length < 2) throw new Error('data: needs an x column and at least one series column');
  if (columns.length > 5) throw new Error('data: choose up to four series columns');
  const series = columns.slice(1);
  const xs = rows.map((r) => r[0]);
  const xLabel = spec.x?.label ?? columns[0];
  const yLabel = spec.y?.label ?? (series.length === 1 ? series[0] : '');
  const unit = spec.y?.unit ? ` ${spec.y.unit}` : '';
  const values = rows.flatMap((r) => series.map((_, i) => r[i + 1])).filter((v) => typeof v === 'number');
  if (!values.length) throw new Error('data: no numeric values in the series columns');
  const horizontal = type === 'hbar';
  const banded = type === 'bar' || type === 'hbar';
  const numericX = !banded && xs.every((v) => typeof v === 'number');
  if (type === 'scatter' && !numericX) throw new Error('scatter: the first column must be numbers');

  // Layout (viewBox units; the SVG scales to the column width).
  const W = 640;
  const longestCat = banded ? Math.max(...xs.map((x) => String(x).length)) : 0;
  const M = { top: series.length > 1 && banded ? 34 : 18, right: banded ? 16 : 96, bottom: 44, left: horizontal ? Math.min(180, 16 + longestCat * 6.6) : 52 };
  const H = horizontal ? Math.max(180, M.top + M.bottom + rows.length * (18 + 10 * series.length)) : 340;
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const zero = spec.y?.zero ?? banded;
  const vlo = Math.min(...values, ...(zero ? [0] : []));
  const vhi = Math.max(...values, ...(zero ? [0] : []));
  const vt = niceTicks(vlo, vhi);
  const kids = [];
  const grid = [];
  const axis = [];
  const marks = [];
  const focusable = rows.length * series.length <= 60;

  const pointLabel = (xv, si, v) => `${xLabel} ${xv}, ${series[si]}: ${fmt(v)}${unit}`;
  const point = (shapeNode, labelX, labelY, text, aria, si) =>
    el('g', focusable ? { className: ['pt', `c-s${si + 1}`], tabIndex: 0, role: 'img', ariaLabel: aria } : { className: ['pt', `c-s${si + 1}`] }, [
      shapeNode,
      el('text', { className: ['pt-label'], x: r1(labelX), y: r1(labelY), textAnchor: 'middle' }, [text]),
    ]);

  if (!banded) {
    // value axis (y) + x axis (numeric or evenly spaced categories)
    const y = linear(vt.lo, vt.hi, M.top + ih, M.top);
    const xt = numericX ? niceTicks(Math.min(...xs), Math.max(...xs), Math.min(8, xs.length)) : null;
    const x = numericX ? linear(xt.lo, xt.hi, M.left, M.left + iw) : (i) => M.left + (xs.length === 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
    for (const t of vt.ticks) {
      grid.push(el('line', { className: ['grid'], x1: M.left, x2: M.left + iw, y1: r1(y(t)), y2: r1(y(t)) }));
      axis.push(el('text', { className: ['tick'], x: M.left - 8, y: r1(y(t)), textAnchor: 'end', dominantBaseline: 'middle' }, [fmt(t)]));
    }
    const xticks = numericX ? xt.ticks.map((t) => [x(t), fmt(t)]) : xs.map((v, i) => [x(i), String(v)]).filter((_, i, a) => a.length <= 12 || i % Math.ceil(a.length / 12) === 0);
    for (const [px, label] of xticks) axis.push(el('text', { className: ['tick'], x: r1(px), y: M.top + ih + 18, textAnchor: 'middle' }, [label]));
    axis.push(el('line', { className: ['axis'], x1: M.left, x2: M.left + iw, y1: M.top + ih, y2: M.top + ih }));
    const ends = [];
    series.forEach((name, si) => {
      const pts = rows.map((r, i) => [numericX ? x(r[0]) : x(i), r[si + 1], r[0]]).filter((p) => typeof p[1] === 'number');
      if (type === 'area' && pts.length > 1) {
        const base = y(Math.max(vt.lo, Math.min(0, vt.hi)));
        const top = pts.map(([px, v], i) => `${i ? 'L' : 'M'}${r1(px)} ${r1(y(v))}`).join('');
        marks.push(el('path', { className: ['area', `c-s${si + 1}`], d: `${top}L${r1(pts.at(-1)[0])} ${r1(base)}L${r1(pts[0][0])} ${r1(base)}Z` }));
      }
      if ((type === 'line' || type === 'area') && pts.length > 1) {
        marks.push(el('path', { className: ['line', `c-s${si + 1}`], d: pts.map(([px, v], i) => `${i ? 'L' : 'M'}${r1(px)} ${r1(y(v))}`).join(''), strokeDasharray: DASH[si] || undefined }));
      }
      for (const [px, v, xv] of pts) {
        marks.push(point(marker(MARK[si], px, y(v)), px, y(v) - 9, fmt(v), pointLabel(xv, si, v), si));
      }
      const last = pts.at(-1);
      if (last && series.length > 1) ends.push({ name, y: y(last[1]), x: last[0], si });
    });
    // Direct labels at the line ends, nudged apart so they never overlap.
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    for (const e of ends) marks.push(el('text', { className: ['series-label', `c-s${e.si + 1}`], x: r1(e.x + 8), y: r1(e.y), dominantBaseline: 'middle' }, [e.name]));
  } else {
    // bands for categories, grouped bars per series
    const band = (horizontal ? ih : iw) / rows.length;
    const pad = band * 0.22;
    const bw = (band - pad) / series.length;
    const v = horizontal ? linear(vt.lo, vt.hi, M.left, M.left + iw) : linear(vt.lo, vt.hi, M.top + ih, M.top);
    for (const t of vt.ticks) {
      if (horizontal) {
        grid.push(el('line', { className: ['grid'], y1: M.top, y2: M.top + ih, x1: r1(v(t)), x2: r1(v(t)) }));
        axis.push(el('text', { className: ['tick'], x: r1(v(t)), y: M.top + ih + 18, textAnchor: 'middle' }, [fmt(t)]));
      } else {
        grid.push(el('line', { className: ['grid'], x1: M.left, x2: M.left + iw, y1: r1(v(t)), y2: r1(v(t)) }));
        axis.push(el('text', { className: ['tick'], x: M.left - 8, y: r1(v(t)), textAnchor: 'end', dominantBaseline: 'middle' }, [fmt(t)]));
      }
    }
    const base = v(Math.max(vt.lo, Math.min(0, vt.hi)));
    rows.forEach((r, ri) => {
      const b0 = (horizontal ? M.top : M.left) + ri * band + pad / 2;
      const cat = String(r[0]);
      axis.push(
        horizontal
          ? el('text', { className: ['tick'], x: M.left - 8, y: r1(b0 + (band - pad) / 2), textAnchor: 'end', dominantBaseline: 'middle' }, [cat])
          : el('text', { className: ['tick'], x: r1(b0 + (band - pad) / 2), y: M.top + ih + 18, textAnchor: 'middle' }, [cat]),
      );
      series.forEach((_, si) => {
        const val = r[si + 1];
        if (typeof val !== 'number') return;
        const p = v(val);
        const rect = horizontal
          ? el('rect', { className: ['bar', `c-s${si + 1}`, `hatch-${si}`], x: r1(Math.min(base, p)), y: r1(b0 + si * bw), width: r1(Math.abs(p - base)), height: r1(bw - 2) })
          : el('rect', { className: ['bar', `c-s${si + 1}`, `hatch-${si}`], x: r1(b0 + si * bw), y: r1(Math.min(base, p)), width: r1(bw - 2), height: r1(Math.abs(p - base)) });
        const lx = horizontal ? Math.max(base, p) + 16 : b0 + si * bw + (bw - 2) / 2;
        const ly = horizontal ? b0 + si * bw + bw / 2 + 3 : Math.min(base, p) - 6;
        marks.push(point(rect, lx, ly, fmt(val), pointLabel(cat, si, val), si));
      });
    });
    axis.push(horizontal ? el('line', { className: ['axis'], x1: r1(base), x2: r1(base), y1: M.top, y2: M.top + ih }) : el('line', { className: ['axis'], x1: M.left, x2: M.left + iw, y1: r1(base), y2: r1(base) }));
    if (series.length > 1) {
      // A text legend (swatch + name) above the bars: names are always written out.
      let lx = M.left;
      series.forEach((name, si) => {
        marks.push(el('rect', { className: ['bar', 'legend-swatch', `c-s${si + 1}`, `hatch-${si}`], x: lx, y: 8, width: 10, height: 10 }));
        marks.push(el('text', { className: ['series-label', `c-s${si + 1}`], x: lx + 14, y: 13, dominantBaseline: 'middle' }, [name]));
        lx += 26 + name.length * 6.6;
      });
    }
  }

  // axis titles
  if (horizontal) {
    if (yLabel) axis.push(el('text', { className: ['axis-title'], x: M.left + iw / 2, y: H - 6, textAnchor: 'middle' }, [yLabel + unit]));
  } else {
    if (xLabel) axis.push(el('text', { className: ['axis-title'], x: M.left + iw / 2, y: H - 6, textAnchor: 'middle' }, [xLabel]));
    if (yLabel) axis.push(el('text', { className: ['axis-title'], x: 12, y: M.top + ih / 2, textAnchor: 'middle', transform: `rotate(-90 12 ${r1(M.top + ih / 2)})` }, [yLabel + unit]));
  }

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const kind = { line: 'Line chart', area: 'Area chart', bar: 'Bar chart', hbar: 'Horizontal bar chart', scatter: 'Scatter plot' }[type];
  const summary = `${kind}${series.length > 1 ? ` of ${series.length} series (${series.join(', ')})` : ` of ${series[0]}`} by ${xLabel}, ${rows.length} ${banded ? 'categories' : 'points'}; values from ${fmt(lo)} to ${fmt(hi)}${unit}.`;
  const label = String(spec.alt ?? spec.title ?? kind);
  kids.push(el('title', { id: `${uid}-t` }, [label]), el('desc', { id: `${uid}-d` }, [summary]));
  kids.push(el('g', { className: ['grid-lines'] }, grid), el('g', { className: ['axes'] }, axis), el('g', { className: ['marks'] }, marks));

  const svg = el(
    'svg',
    { className: ['chart-svg', `chart-${type}`], viewBox: `0 0 ${W} ${r1(H)}`, role: 'img', ariaLabelledBy: `${uid}-t ${uid}-d`, focusable: 'false' },
    kids,
  );
  const table = dataTable(columns.slice(0, series.length + 1), rows);
  return { svg, table, summary };
}

/** The data as a real table, inside a collapsed <details>. */
function dataTable(columns, rows) {
  return el('details', { className: ['chart-data'] }, [
    el('summary', {}, ['data']),
    el('div', { className: ['table-wrap'] }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, columns.map((c) => el('th', { scope: 'col' }, [String(c)])))]),
        el('tbody', {}, rows.map((r) => el('tr', {}, r.slice(0, columns.length).map((v, i) => (i === 0 ? el('th', { scope: 'row' }, [String(v)]) : el('td', {}, [typeof v === 'number' ? fmt(v) : String(v)])))))),
      ]),
    ]),
  ]);
}

// ---------------------------------------------------------------- diagrams
/**
 * A tiny box-and-arrow language:
 *   direction: right          (or down)
 *   A[Embed] -> B[Attention] -> C[MLP]
 *   B -> D[Residual stream]
 * Node ids are letters/digits/_; the [label] is optional after the first use.
 */
export function parseDiagram(text) {
  const nodes = new Map();
  const edges = [];
  const settings = {};
  const node = (tok) => {
    const m = tok.trim().match(/^([A-Za-z0-9_]+)(?:\[([^\]]*)\])?$/);
    if (!m) throw new Error(`diagram: can't read "${tok.trim()}" (use Id or Id[Label])`);
    const [, id, label] = m;
    if (!nodes.has(id)) nodes.set(id, { id, label: label ?? id, order: nodes.size });
    else if (label) nodes.get(id).label = label;
    return id;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const kv = line.match(/^(direction|caption|title|alt|id):\s*(.*)$/i);
    if (kv) {
      settings[kv[1].toLowerCase()] = kv[2].trim();
      continue;
    }
    const parts = line.split('->');
    const ids = parts.map(node);
    for (let i = 1; i < ids.length; i++) edges.push([ids[i - 1], ids[i]]);
  }
  if (!nodes.size) throw new Error('diagram: no nodes (try  A[Start] -> B[End])');
  return { nodes: [...nodes.values()], edges, settings };
}

export function renderDiagram(text, uid) {
  const { nodes, edges, settings } = parseDiagram(text);
  const down = /^down$/i.test(settings.direction ?? '');
  // Rank = longest path from a source (back edges in a cycle are ignored).
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const [a, b] of edges) {
      if (rank.get(b) < rank.get(a) + 1 && rank.get(a) + 1 < nodes.length) {
        rank.set(b, rank.get(a) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const ranks = [];
  for (const n of nodes) (ranks[rank.get(n.id)] ??= []).push(n);
  const boxW = (n) => Math.max(64, Math.min(200, n.label.length * 7.2 + 24));
  const BH = 34;
  const GAP_MAIN = down ? 38 : 46;
  const GAP_CROSS = 16;
  const pos = new Map();
  let main = 12;
  let crossMax = 0;
  for (const group of ranks.filter(Boolean)) {
    const widths = group.map(boxW);
    const mainSize = down ? BH : Math.max(...widths);
    let cross = 12;
    group.forEach((n, i) => {
      const w = widths[i];
      if (down) {
        pos.set(n.id, { x: cross, y: main, w, h: BH });
        cross += w + GAP_CROSS;
      } else {
        pos.set(n.id, { x: main + (mainSize - w) / 2, y: cross, w, h: BH });
        cross += BH + GAP_CROSS;
      }
    });
    crossMax = Math.max(crossMax, cross);
    main += mainSize + GAP_MAIN;
  }
  // Centre each rank across the cross axis.
  const W0 = down ? crossMax : main - GAP_MAIN + 12;
  const H0 = down ? main - GAP_MAIN + 12 : crossMax;
  for (const group of ranks.filter(Boolean)) {
    const boxes = group.map((n) => pos.get(n.id));
    const span = down ? Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x)) : Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y));
    const shift = ((down ? W0 : H0) - 24 - span) / 2;
    for (const b of boxes) down ? (b.x += shift) : (b.y += shift);
  }
  const arrowId = `${uid}-arrow`;
  const kids = [
    el('title', { id: `${uid}-t` }, [settings.alt ?? settings.title ?? 'Diagram']),
    el('desc', { id: `${uid}-d` }, [`Diagram: ${edges.length ? edges.map(([a, b]) => `${label(nodes, a)} → ${label(nodes, b)}`).join('; ') : nodes.map((n) => n.label).join(', ')}.`]),
    el('defs', {}, [el('marker', { id: arrowId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, [el('path', { className: ['dg-head'], d: 'M0 0L10 5L0 10Z' })])]),
  ];
  for (const [a, b] of edges) {
    const A = pos.get(a);
    const B = pos.get(b);
    const [x1, y1, x2, y2] = down ? [A.x + A.w / 2, A.y + A.h, B.x + B.w / 2, B.y] : [A.x + A.w, A.y + A.h / 2, B.x, B.y + B.h / 2];
    const back = down ? y2 <= y1 : x2 <= x1;
    kids.push(
      el('path', {
        className: ['dg-edge'],
        d: back ? `M${r1(x1)} ${r1(y1)}C${r1(x1 + (down ? 40 : 0))} ${r1(y1 + (down ? 0 : 40))} ${r1(x2 + (down ? 40 : 0))} ${r1(y2 - (down ? 0 : -40))} ${r1(x2)} ${r1(y2)}` : `M${r1(x1)} ${r1(y1)}L${r1(x2 - (down ? 0 : 2))} ${r1(y2 - (down ? 2 : 0))}`,
        markerEnd: `url(#${arrowId})`,
      }),
    );
  }
  for (const n of nodes) {
    const b = pos.get(n.id);
    kids.push(
      el('g', { className: ['dg-node'] }, [
        el('rect', { className: ['dg-shadow'], x: r1(b.x + 2), y: r1(b.y + 2), width: r1(b.w), height: b.h }),
        el('rect', { className: ['dg-box'], x: r1(b.x), y: r1(b.y), width: r1(b.w), height: b.h }),
        el('text', { className: ['dg-label'], x: r1(b.x + b.w / 2), y: r1(b.y + b.h / 2), textAnchor: 'middle', dominantBaseline: 'middle' }, [n.label]),
      ]),
    );
  }
  const svg = el('svg', { className: ['diagram-svg', down ? 'dg-down' : 'dg-right'], viewBox: `0 0 ${r1(W0)} ${r1(H0)}`, role: 'img', ariaLabelledBy: `${uid}-t ${uid}-d`, focusable: 'false', width: r1(W0 * 1.15), height: r1(H0 * 1.15) }, kids);
  return { svg, settings };
}
const label = (nodes, id) => nodes.find((n) => n.id === id)?.label ?? id;
