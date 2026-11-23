// ```takeoff fences → the fast-takeoff animation (an illustrative scenario).
//
//   ```takeoff
//   caption: an illustrative fast takeoff, not a forecast
//   start: 2027        (optional: the year takeoff begins)
//   years: 2.5         (optional: how long until the entropy floor)
//   title: fast_takeoff   (optional: the window title)
//   milestones:        (optional: replaces the built-in list, up to 10)
//     - ppl: 6.0
//       text: what models can do once they reach this perplexity
//   ```
//
// Like remark-zeta, it runs before Shiki and emits hast, so .md, .mdx, live
// studio posts and the studio preview all get the same figure.
import { visit, SKIP } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';
import { el } from './charts.mjs';
import { takeoffFigure } from './takeoff.mjs';

const asNode = (hast) => ({ type: 'takeoffFigure', data: { hName: hast.tagName, hProperties: hast.properties, hChildren: hast.children } });

export default function remarkTakeoff() {
  return (tree) => {
    visit(tree, 'code', (node, index, parent) => {
      if (!parent || index === undefined || node.lang !== 'takeoff') return;
      try {
        const spec = parseYaml(node.value || '') ?? {};
        if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('write options as YAML, e.g. caption: …');
        parent.children[index] = asNode(takeoffFigure(spec));
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
        parent.children[index] = asNode(el('figure', { className: ['figure', 'chart--error'] }, [el('pre', { className: ['chart-error'] }, [`takeoff error: ${message}`])]));
      }
      parent.children[index].position = node.position;
      return SKIP;
    });
  };
}
