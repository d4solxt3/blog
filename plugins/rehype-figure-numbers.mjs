// Numbers figures (images, charts, diagrams, figure groups) in document order
// as "Fig. 01", "Fig. 02"… — a real text node at the start of the caption, so
// it's part of the accessible name and of copied text (not a CSS label).
// Figures inside a figure group belong to it and aren't numbered themselves.
const hasClass = (node, c) => {
  const cls = node.properties?.className;
  return Array.isArray(cls) ? cls.includes(c) : String(cls ?? '').split(/\s+/).includes(c);
};
const isFigure = (node) => node.type === 'element' && node.tagName === 'figure' && hasClass(node, 'figure') && !['chart--error', 'diagram--error', 'figure--error'].some((c) => hasClass(node, c));

export default function rehypeFigureNumbers() {
  return (tree) => {
    let n = 0;
    const walk = (node, insideFigure) => {
      if (isFigure(node) && !insideFigure) {
        n += 1;
        const num = { type: 'element', tagName: 'span', properties: { className: ['fig-num'] }, children: [{ type: 'text', value: `Fig. ${String(n).padStart(2, '0')}` }] };
        let cap = node.children.find((c) => c.type === 'element' && c.tagName === 'figcaption');
        if (!cap) {
          cap = { type: 'element', tagName: 'figcaption', properties: {}, children: [] };
          node.children.push(cap);
        }
        cap.children = cap.children.length ? [num, { type: 'text', value: ' ' }, ...cap.children] : [num];
      }
      for (const c of node.children ?? []) walk(c, insideFigure || isFigure(node));
    };
    walk(tree, false);
  };
}
