// Turns marked blockquotes into styled callouts:
//   > [!TLDR]        → dotted "... tl;dr ..." box
//   > [!EPISTEMIC]   → dotted "... epistemic status ..." box
//   > [!NOTE]        → dashed annotation box
//   > [!WARNING]     → inverted warning tab
//   > [!QUOTE] Name  → pull-quote with attribution
// Any text after the marker on the first line becomes the title.
import { visit } from 'unist-util-visit';

const el = (tagName, className, children = [], extra = {}) => ({
  type: 'element',
  tagName,
  properties: { ...(className ? { className: [].concat(className) } : {}), ...extra },
  children,
});
const text = (value) => ({ type: 'text', value });
const MARK = /^\s*\[!(tldr|epistemic|note|warning|quote|tip)\][ \t]*([^\n]*)\n?/i;

// Dotted note box with a "... label ..." heading (TL;DR, epistemic status).
function noteBox(kind, label, title, body) {
  const bodyChildren = title ? [el('p', 'note-heading', [text(title)]), ...body] : body;
  return el('aside', ['note-box', `note-box--${kind}`], [
    el('p', 'lsl', [text(label)], { ariaHidden: 'true' }),
    el('div', 'note-body', bodyChildren),
  ], { ariaLabel: title || label, dataCallout: kind });
}

export default function rehypeCallouts() {
  return (tree) => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'blockquote' || !parent || index === undefined) return;
      const firstP = node.children.find((c) => c.type === 'element');
      if (!firstP || firstP.tagName !== 'p') return;
      const firstText = firstP.children[0];
      if (!firstText || firstText.type !== 'text') return;
      const m = firstText.value.match(MARK);
      if (!m) return;

      const kind = m[1].toLowerCase();
      const title = m[2].trim();
      firstText.value = firstText.value.slice(m[0].length);
      // Drop a now-empty first paragraph (marker was on its own line).
      const leftover = firstP.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
      if (!leftover.length || (leftover[0].type === 'element' && leftover[0].tagName === 'br' && leftover.length === 1)) {
        node.children.splice(node.children.indexOf(firstP), 1);
      } else if (firstP.children[0]?.type === 'element' && firstP.children[0].tagName === 'br') {
        firstP.children.shift();
      }
      const body = node.children.filter((c) => !(c.type === 'text' && !c.value.trim()));

      let replacement;
      if (kind === 'tldr') replacement = noteBox('tldr', 'tl;dr', title, body);
      else if (kind === 'epistemic') replacement = noteBox('epistemic', title || 'epistemic status', '', body);
      else if (kind === 'quote')
        replacement = el('figure', 'pullquote', [
          el('blockquote', null, body),
          ...(title ? [el('figcaption', null, [text(`— ${title}`)])] : []),
        ]);
      else {
        const variant = kind === 'warning' ? 'warning' : 'note';
        const label = title || (kind === 'tip' ? 'Tip' : kind === 'warning' ? 'Warning' : 'Note');
        replacement = el('aside', ['callout', `callout--${variant}`], [
          el('p', 'callout-label', [text(variant === 'warning' ? label : `[ ${label} ]`)], { ariaHidden: 'true' }),
          el('div', 'callout-body', body),
        ], { ariaLabel: label });
      }
      parent.children[index] = replacement;
    });
  };
}
