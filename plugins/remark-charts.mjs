// Charts, diagrams and figure groups → <figure> elements with inline SVG,
// built at the remark stage (before Shiki turns fences into code blocks) and
// emitted as hast via data.hName/hChildren, so .md, .mdx and the studio /
// admin previews all produce identical markup from one renderer.
//
// Portable fences (.md and .mdx):
//   ```chart id=latency          type: line | area | bar | hbar | scatter
//   type: line                   data: CSV, a Markdown table, JSON, or a
//   title: p95 latency by layer        YAML list of rows
//   caption: Latency rises after layer 12.
//   x: { label: layer }
//   y: { label: latency, unit: ms, zero: true }
//   data: |
//     layer, base, patched
//     0, 12, 11
//   ```
//   ```diagram                   A[Embed] -> B[Attention] -> C[MLP]
//   ```figure                    caption:, cols: 2, items: [{image, alt, caption} | {chart: {...}}]
//
// MDX components (same output):
//   <Chart type="line" title="…" caption="…" xLabel="…" yLabel="…" unit="ms" id="…" data={`csv…`} />
//   <Figure caption="…" cols="2" id="…"> …markdown, images, charts… </Figure>
// The studio preview (plain Markdown) turns <Chart/> into a fence and
// <Figure> into marker comments (plugins/preview.mjs) that land here too.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { visit, SKIP } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';
import { el, renderChart, renderDiagram } from './charts.mjs';

const POSTS = resolve(process.cwd(), 'content/posts');
const ID = /^[a-z0-9][a-z0-9-]*$/i;
const metaId = (meta) => String(meta ?? '').match(/(?:^|\s)id=([a-z0-9][a-z0-9-]*)/i)?.[1];

// ------------------------------------------------------------- shared helpers
/** <Chart> props (strings) → the same spec object a ```chart fence gives. */
export function chartSpecFromProps(p) {
  const spec = { type: p.type, title: p.title, caption: p.caption, alt: p.alt, id: p.id, data: p.data };
  if (p.xLabel) spec.x = { label: p.xLabel };
  if (p.yLabel || p.unit || p.zero !== undefined) spec.y = { label: p.yLabel, unit: p.unit, zero: p.zero === undefined ? undefined : p.zero === true || p.zero === 'true' };
  for (const k of Object.keys(spec)) if (spec[k] === undefined || spec[k] === '') delete spec[k];
  return spec;
}

/** The inside of a JSX attribute expression {…}: a template literal, a string, or JSON. */
export function jsxValue(expr) {
  const t = String(expr ?? '').trim();
  if (/^`[\s\S]*`$/.test(t)) return t.slice(1, -1).replace(/\\`/g, '`').replace(/\\\$\{/g, '${');
  if (/^"[\s\S]*"$|^'[\s\S]*'$/.test(t)) return t.slice(1, -1);
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`can't read {${t.slice(0, 40)}…}: use a template literal \`…\` or JSON`);
  }
}

/** data: ./file.csv → read it from beside the post (never outside content/). */
function loadData(data, file) {
  if (typeof data !== 'string' || data.includes('\n') || !/^\.{0,2}\/?[\w./-]+\.(csv|tsv|md|json)$/i.test(data.trim())) return data;
  const base = file?.path ? dirname(file.path) : POSTS;
  const full = resolve(base, data.trim());
  const root = resolve(process.cwd(), 'content');
  if (!full.startsWith(root + sep) || !existsSync(full)) throw new Error(`data: can't find ${data.trim()} (next to the post, inside content/)`);
  return readFileSync(full, 'utf8');
}

const hastFigure = (kind, id, children, caption) => ({
  type: 'chartFigure',
  data: {
    hName: 'figure',
    hProperties: { className: ['figure', kind], ...(id ? { id: `fig-${id}` } : {}) },
    hChildren: [...children, ...(caption ? [el('figcaption', {}, [caption])] : [])],
  },
});

const errorFigure = (kind, message) => ({
  type: 'chartFigure',
  data: {
    hName: 'figure',
    hProperties: { className: ['figure', kind, `${kind}--error`] },
    hChildren: [el('pre', { className: ['chart-error'] }, [`${kind} error: ${message}`])],
  },
});

/** A figure group: its own Markdown children (images, charts…) in a grid, one caption. */
function groupFigure(children, { caption, cols, id } = {}) {
  const n = Math.max(1, Math.min(3, Number(cols) || 1));
  return {
    type: 'figureGroup',
    data: { hName: 'figure', hProperties: { className: ['figure', 'figure-group', `cols-${n}`], ...(id && ID.test(id) ? { id: `fig-${id}` } : {}) } },
    children: [
      { type: 'figureBody', data: { hName: 'div', hProperties: { className: ['figure-grid'] } }, children },
      ...(caption ? [{ type: 'figureCaption', data: { hName: 'figcaption' }, children: [{ type: 'text', value: String(caption) }] }] : []),
    ],
  };
}

function chartNode(spec, metaIdValue, uid, file) {
  try {
    if (!spec || typeof spec !== 'object') throw new Error('write the chart as YAML (type:, data: …)');
    const id = metaIdValue ?? (ID.test(String(spec.id ?? '')) ? String(spec.id) : undefined);
    spec.data = loadData(spec.data, file);
    const { svg, table } = renderChart(spec, id ? `fig-${id}` : uid);
    const heading = spec.title ? el('p', { className: ['chart-title'], ariaHidden: 'true' }, [String(spec.title)]) : null;
    return hastFigure('chart', id, [heading, svg, table].filter(Boolean), spec.caption ? String(spec.caption) : '');
  } catch (err) {
    return errorFigure('chart', err instanceof Error ? err.message : String(err));
  }
}

function jsxProps(node) {
  const props = {};
  for (const a of node.attributes ?? []) {
    if (a.type !== 'mdxJsxAttribute') continue;
    props[a.name] = a.value === null || a.value === undefined ? true : typeof a.value === 'string' ? a.value : jsxValue(a.value.value);
  }
  return props;
}

// -------------------------------------------------------------------- plugin
export default function remarkCharts() {
  return (tree, file) => {
    let n = 0;
    const uid = (kind) => `${kind}-${++n}`;

    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined) return;

      // ```chart / ```diagram / ```figure fences
      if (node.type === 'code' && ['chart', 'diagram', 'figure'].includes(node.lang)) {
        if (node.lang === 'chart') {
          let spec;
          try {
            spec = parseYaml(node.value) ?? {};
          } catch (err) {
            parent.children[index] = errorFigure('chart', `YAML: ${err.message.split('\n')[0]}`);
            parent.children[index].position = node.position;
            return SKIP;
          }
          parent.children[index] = chartNode(spec, metaId(node.meta), uid('chart'), file);
        } else if (node.lang === 'diagram') {
          try {
            const { svg, settings } = renderDiagram(node.value, uid('diagram'));
            const id = metaId(node.meta) ?? (ID.test(settings.id ?? '') ? settings.id : undefined);
            parent.children[index] = hastFigure('diagram', id, [svg], settings.caption ?? '');
          } catch (err) {
            parent.children[index] = errorFigure('diagram', err.message);
          }
        } else {
          try {
            const spec = parseYaml(node.value) ?? {};
            const items = (Array.isArray(spec.items) ? spec.items : []).map((it) => {
              if (it?.chart) return chartNode({ ...it.chart }, undefined, uid('chart'), file);
              if (it?.image) {
                // An image paragraph: rehype-figures turns it into an inner (unnumbered) figure.
                return { type: 'paragraph', children: [{ type: 'image', url: String(it.image), alt: String(it.alt ?? ''), title: it.caption ? String(it.caption) : null }] };
              }
              throw new Error('items: each item needs image: or chart:');
            });
            if (!items.length) throw new Error('items: add at least one image or chart');
            parent.children[index] = groupFigure(items, { caption: spec.caption, cols: spec.cols, id: metaId(node.meta) ?? spec.id });
          } catch (err) {
            parent.children[index] = errorFigure('figure', err.message);
          }
        }
        parent.children[index].position = node.position;
        return SKIP;
      }

      // MDX: <Chart … />
      if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === 'Chart') {
        try {
          parent.children[index] = chartNode(chartSpecFromProps(jsxProps(node)), undefined, uid('chart'), file);
        } catch (err) {
          parent.children[index] = errorFigure('chart', err.message);
        }
        parent.children[index].position = node.position;
        return SKIP;
      }

      // MDX: <Figure …>children</Figure>
      if (node.type === 'mdxJsxFlowElement' && node.name === 'Figure') {
        const p = jsxProps(node);
        parent.children[index] = groupFigure(node.children, p);
        parent.children[index].position = node.position;
        return; // keep walking into the children (charts inside a figure)
      }
    });

    // Preview markers: <!--figure:open {...}--> … <!--figure:close--> → a figure group.
    visit(tree, (node) => {
      if (!Array.isArray(node.children)) return;
      for (let i = 0; i < node.children.length; i++) {
        const open = node.children[i];
        const m = open.type === 'html' && open.value.match(/^<!--figure:open (\{[\s\S]*\})-->$/);
        if (!m) continue;
        const close = node.children.findIndex((c, j) => j > i && c.type === 'html' && c.value.trim() === '<!--figure:close-->');
        if (close < 0) continue;
        let props = {};
        try {
          props = JSON.parse(m[1]);
        } catch {}
        const group = groupFigure(node.children.slice(i + 1, close), props);
        group.position = open.position;
        node.children.splice(i, close - i + 1, group);
      }
    });
  };
}
