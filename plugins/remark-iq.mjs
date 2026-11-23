// ```iq fences → the "IQ, roughly" animated bar chart (people, a cow, and
// frontier AI over time; see plugins/iq.mjs for the data).
//
//   ```iq
//   caption: AI scores on a public IQ test; the cow and ASI are illustrative
//   title: iq_roughly   (optional: the window title)
//   ```
//
// Like remark-zeta and remark-takeoff it emits hast before Shiki runs, so
// .md, .mdx, live studio posts and the studio preview all get the same figure.
import { visit, SKIP } from 'unist-util-visit';
import { parse as parseYaml } from 'yaml';
import { el } from './charts.mjs';
import { iqFigure } from './iq.mjs';

const asNode = (hast) => ({ type: 'iqFigure', data: { hName: hast.tagName, hProperties: hast.properties, hChildren: hast.children } });

export default function remarkIq() {
  return (tree) => {
    visit(tree, 'code', (node, index, parent) => {
      if (!parent || index === undefined || node.lang !== 'iq') return;
      try {
        const spec = parseYaml(node.value || '') ?? {};
        if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('write options as YAML, e.g. caption: …');
        parent.children[index] = asNode(iqFigure(spec));
      } catch (err) {
        const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
        parent.children[index] = asNode(el('figure', { className: ['figure', 'chart--error'] }, [el('pre', { className: ['chart-error'] }, [`iq error: ${message}`])]));
      }
      parent.children[index].position = node.position;
      return SKIP;
    });
  };
}
