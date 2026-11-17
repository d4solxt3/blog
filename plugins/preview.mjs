// Live preview rendering, shared by /_admin and the /write studio. Uses the
// same Markdown pipeline as the site, so the preview matches the real post.
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import { shikiConfig, remarkPlugins, rehypePlugins, remarkRehype } from './markdown.mjs';

let processor;
const getProcessor = async () =>
  (processor ??= await createMarkdownProcessor({ shikiConfig, remarkPlugins, rehypePlugins, remarkRehype }));

/** Rough MDX → Markdown so the preview shows <Callout> and <Details> components too. */
export function mdxToPreview(src) {
  return String(src)
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/^\s*(import|export)\s.*$/gm, '')
    .replace(/<Details([^>]*)>/g, (_, attrs) => {
      const summary = attrs.match(/summary="([^"]*)"/)?.[1] ?? 'Details';
      return `<details><summary>${summary}</summary>\n`;
    })
    .replace(/<\/Details>/g, '\n</details>')
    .replace(/<Callout([^>]*)>/g, (_, attrs) => {
      const label = attrs.match(/label="([^"]*)"/)?.[1] ?? 'Note';
      const variant = attrs.match(/variant="([^"]*)"/)?.[1] ?? 'note';
      return `<aside class="callout callout--${variant}"><p class="callout-label">[ ${label} ]</p><div class="callout-body">\n`;
    })
    .replace(/<\/Callout>/g, '\n</div></aside>');
}

/** Markdown/MDX source → HTML string. */
export async function renderPreview(src) {
  const md = await getProcessor();
  const { code } = await md.render(mdxToPreview(src));
  return code;
}
