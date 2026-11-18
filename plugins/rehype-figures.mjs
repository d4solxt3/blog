// A paragraph that contains only an image becomes a captioned figure.
// Caption = the image title if given (![alt](src "title")), otherwise the alt text.
import { visit } from 'unist-util-visit';

export default function rehypeFigures() {
  return (tree) => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'p' || !parent || index === undefined) return;
      const kids = node.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
      if (kids.length !== 1 || kids[0].type !== 'element' || kids[0].tagName !== 'img') return;
      const img = kids[0];
      // "Caption {#fig:name}" in the title gives the figure an id for [[fig:name]] references.
      const titled = String(img.properties?.title ?? '');
      const idMatch = titled.match(/\s*\{#fig:([a-z0-9][a-z0-9-]*)\}\s*$/i);
      const caption = (idMatch ? titled.slice(0, idMatch.index).trim() : titled) || img.properties?.alt;
      if (img.properties) {
        delete img.properties.title;
        img.properties.loading = 'lazy';
        img.properties.decoding = 'async';
      }
      parent.children[index] = {
        type: 'element',
        tagName: 'figure',
        properties: { className: ['figure'], ...(idMatch ? { id: `fig-${idMatch[1]}` } : {}) },
        children: [
          img,
          ...(caption
            ? [{ type: 'element', tagName: 'figcaption', properties: {}, children: [{ type: 'text', value: String(caption) }] }]
            : []),
        ],
      };
    });
  };
}
