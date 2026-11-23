// One Markdown pipeline, shared by the site (astro.config.mjs) and the
// /_admin live preview, so what you preview is what gets published.
import { rehypeHeadingIds } from '@astrojs/markdown-remark';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import remarkMath from 'remark-math';
import { createCssVariablesTheme } from 'shiki';
import remarkLatex from './remark-latex.mjs';
import rehypeLatex from './rehype-latex.mjs';
import remarkWikiLinks from './remark-wikilinks.mjs';
import rehypeCallouts from './rehype-callouts.mjs';
import rehypeFigures from './rehype-figures.mjs';
import remarkCharts from './remark-charts.mjs';
import remarkZeta from './remark-zeta.mjs';
import remarkTakeoff from './remark-takeoff.mjs';
import rehypeFigureNumbers from './rehype-figure-numbers.mjs';

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

// remarkCharts (and remarkZeta, remarkTakeoff) first: chart/diagram/zeta/takeoff fences must
// become figures before Shiki (which runs ahead of the rehype plugins) turns them into code blocks.
export const remarkPlugins = [remarkCharts, remarkZeta, remarkTakeoff, remarkMath, remarkLatex, remarkWikiLinks];

export const remarkRehype = { footnoteLabel: 'Notes', footnoteBackContent: '↑' };

/** @type {import('@astrojs/markdown-remark').RehypePlugins} */
export const rehypePlugins = [
  // Heading ids must exist before the anchor links are appended.
  rehypeHeadingIds,
  [
    rehypeAutolinkHeadings,
    {
      behavior: 'append',
      test: (/** @type {any} */ el) =>
        ['h2', 'h3'].includes(el.tagName) && !['footnote-label', 'references-heading'].includes(el.properties?.id),
      properties: { className: ['heading-anchor'], ariaHidden: 'true', tabIndex: -1 },
      // Empty on purpose: the "#" is drawn with CSS so it never leaks into the ToC text.
      content: [],
    },
  ],
  rehypeCallouts,
  rehypeFigures,
  // After figures exist: number them, then render KaTeX & resolve deferred figure refs.
  rehypeFigureNumbers,
  rehypeLatex,
];
