// ```zeta fences (and <ZetaTrace /> in .mdx) → the live ζ(½ + it) animation.
//
//   ```zeta
//   caption: every pass through the origin is a nontrivial zero
//   tMax: 50          (optional: how far up the critical line, 15–100)
//   title: riemann_zeta   (optional: the window title)
//   ```
//
// Runs at the remark stage, before Shiki would turn the fence into a code
// block, and emits hast, so .md, .mdx, live studio posts and the studio
// preview all get the same figure. src/scripts/zeta-trace.ts animates it.
import { visit, SKIP } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';
import { el } from './charts.mjs';
import { jsxValue } from './remark-charts.mjs';
import { zetaFigure } from './zeta-trace.mjs';

const asNode = (hast) => ({ type: 'zetaFigure', data: { hName: hast.tagName, hProperties: hast.properties, hChildren: hast.children } });

const errorNode = (message) =>
  asNode(el('figure', { className: ['figure', 'chart--error'] }, [el('pre', { className: ['chart-error'] }, [`zeta error: ${message}`])]));

export default function remarkZeta() {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined) return;

      if (node.type === 'code' && node.lang === 'zeta') {
        try {
          const spec = parseYaml(node.value || '') ?? {};
          if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('write options as YAML, e.g. caption: …');
          parent.children[index] = asNode(zetaFigure(spec));
        } catch (err) {
          parent.children[index] = errorNode(err instanceof Error ? err.message.split('\n')[0] : String(err));
        }
        parent.children[index].position = node.position;
        return SKIP;
      }

      if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === 'ZetaTrace') {
        const props = {};
        for (const a of node.attributes ?? []) {
          if (a.type !== 'mdxJsxAttribute') continue;
          try {
            props[a.name] = a.value == null ? true : typeof a.value === 'string' ? a.value : jsxValue(a.value.value);
          } catch {}
        }
        parent.children[index] = asNode(zetaFigure(props));
        parent.children[index].position = node.position;
        return SKIP;
      }
    });
  };
}
