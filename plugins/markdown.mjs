// One Markdown pipeline, shared by the site (astro.config.mjs) and the
// /_admin live preview, so what you preview is what gets published.
import { rehypeHeadingIds } from '@astrojs/markdown-remark';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { createCssVariablesTheme } from 'shiki';
import remarkWikiLinks from './remark-wikilinks.mjs';
import rehypeCallouts from './rehype-callouts.mjs';
import rehypeFigures from './rehype-figures.mjs';

/**
 * Wraps each highlighted <pre> in a non-scrolling frame with a language label
 * (the copy button is added there by the post page script).
 * @type {import('shiki').ShikiTransformer}
 */
const codeFrame = {
  name: 'code-frame',
  root(root) {
    const lang = this.options.lang && this.options.lang !== 'plaintext' ? this.options.lang : 'text';
    root.children = [
      {
        type: 'element',
        tagName: 'div',
        properties: { className: ['code-frame'] },
        children: [
          {
            type: 'element',
            tagName: 'div',
            properties: { className: ['code-label'] },
            children: [{ type: 'element', tagName: 'span', properties: {}, children: [{ type: 'text', value: lang }] }],
          },
          ...root.children,
        ],
      },
    ];
  },
};

export const shikiConfig = {
  // Grayscale code colours come from CSS variables (src/styles/prose.css).
  theme: createCssVariablesTheme({ name: 'mono', variablePrefix: '--shiki-', fontStyle: true }),
  transformers: [codeFrame],
};

export const remarkPlugins = [remarkMath, remarkWikiLinks];

export const remarkRehype = { footnoteLabel: 'Notes', footnoteBackContent: '↑' };

export const rehypePlugins = [
  // Heading ids must exist before the anchor links are appended.
  rehypeHeadingIds,
  [
    rehypeAutolinkHeadings,
    {
      behavior: 'append',
      test: (/** @type {any} */ el) => ['h2', 'h3'].includes(el.tagName) && el.properties?.id !== 'footnote-label',
      properties: { className: ['heading-anchor'], ariaHidden: 'true', tabIndex: -1 },
      // Empty on purpose: the "#" is drawn with CSS so it never leaks into the ToC text.
      content: [],
    },
  ],
  [rehypeKatex, { strict: false }],
  rehypeCallouts,
  rehypeFigures,
];
