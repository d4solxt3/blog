// ```takeoff fences → the fast-takeoff animation: measured base-model
// log-perplexity to Nov 2026, then an illustrative scenario.
//
//   ```takeoff
//   caption: an illustrative fast takeoff, not a forecast
//   start: 2027        (optional: when takeoff begins, Nov 2026 – mid 2028)
//   years: 1           (optional: how long takeoff takes to reach the floor;
//                       by default it starts at the late-2026 pace, ~11 months)
//   floor: 0.4         (optional: the unknown floor, 0.2–0.7)
//   title: fast_takeoff   (optional: the window title)
//   milestones:        (optional: replaces the built-in list, up to 14)
//     - logppl: 0.65
//       text: what models can do once they reach this log-perplexity
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
