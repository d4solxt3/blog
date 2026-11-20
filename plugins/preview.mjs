// Live preview rendering, shared by /_admin and the /write studio. Uses the
// same Markdown pipeline as the site, so the preview matches the real post.
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import { shikiConfig, remarkPlugins, rehypePlugins, remarkRehype } from './markdown.mjs';
import { chartSpecFromProps, jsxValue } from './remark-charts.mjs';
import { MappedText, offsetsToLines, rehypeSourceOffsets } from './source-lines.mjs';

let processor;
const getProcessor = async () =>
  (processor ??= await createMarkdownProcessor({ shikiConfig, remarkPlugins, rehypePlugins, remarkRehype }));
// The studio's split preview: same pipeline plus one step that tags each block
// with its source position (for scroll sync and double-click-to-jump).
let studioProcessor;
const getStudioProcessor = async () =>
  (studioProcessor ??= await createMarkdownProcessor({ shikiConfig, remarkPlugins, rehypePlugins: [...rehypePlugins, rehypeSourceOffsets], remarkRehype }));

/** Attributes of a JSX tag: name="…" | name={`…`} | name={JSON} | bare name. Braces are balanced. */
function jsxAttrs(text) {
  const props = {};
  let i = 0;
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  while (i < text.length) {
    const m = /^\s*([A-Za-z][\w-]*)/.exec(text.slice(i));
    if (!m) break;
    const name = m[1];
    i += m[0].length;
    if (text[i] !== '=') {
      props[name] = true;
      continue;
    }
    i += 1;
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      const end = text.indexOf(q, i + 1);
      props[name] = decode(text.slice(i + 1, end < 0 ? text.length : end));
      i = end < 0 ? text.length : end + 1;
    } else if (text[i] === '{') {
      let depth = 0;
      let j = i;
      let tick = false;
      for (; j < text.length; j++) {
        const c = text[j];
        if (c === '`' && text[j - 1] !== '\\') tick = !tick;
        if (tick) continue;
        if (c === '{') depth += 1;
        else if (c === '}' && --depth === 0) break;
      }
      props[name] = jsxValue(text.slice(i + 1, j));
      i = j + 1;
    } else break;
  }
  return props;
}

/** <Chart … /> → the equivalent ```chart fence (JSON is valid YAML), via the same prop mapping. */
function chartToFence(attrText) {
  try {
    return `\n\n\`\`\`chart\n${JSON.stringify(chartSpecFromProps(jsxAttrs(attrText)))}\n\`\`\`\n\n`;
  } catch (err) {
    return `\n\n\`\`\`chart\n${JSON.stringify({ type: 'invalid', data: '', error: String(err?.message ?? err) })}\n\`\`\`\n\n`;
  }
}

/**
 * Rough MDX → Markdown so the preview shows <Callout>, <Details>, <Chart> and
 * <Figure> too. Returns a MappedText so positions can be traced back to the
 * original source (the text itself is exactly what it always was).
 */
function mdxToPreviewMapped(src) {
  return new MappedText(src)
    .replace(/<Chart\b((?:[^>`{]|`[^`]*`|\{(?:[^{}`]|`[^`]*`|\{[^{}]*\})*\})*?)\/>/g, (_, attrs) => chartToFence(attrs))
    .replace(/<Figure\b([^>]*)>/g, (_, attrs) => {
      const p = jsxAttrs(attrs);
      return `\n\n<!--figure:open ${JSON.stringify({ caption: p.caption, cols: p.cols, id: p.id })}-->\n\n`;
    })
    .replace(/<\/Figure>/g, () => '\n\n<!--figure:close-->\n\n')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/g, () => '')
    .replace(/^\s*(import|export)\s.*$/gm, () => '')
    .replace(/<Details([^>]*)>/g, (_, attrs) => {
      const summary = attrs.match(/summary="([^"]*)"/)?.[1] ?? 'Details';
      return `<details><summary>${summary}</summary>\n`;
    })
    .replace(/<\/Details>/g, () => '\n</details>')
    .replace(/<Callout([^>]*)>/g, (_, attrs) => {
      const label = attrs.match(/label="([^"]*)"/)?.[1] ?? 'Note';
      const variant = attrs.match(/variant="([^"]*)"/)?.[1] ?? 'note';
      return `<aside class="callout callout--${variant}"><p class="callout-label">[ ${label} ]</p><div class="callout-body">\n`;
    })
    .replace(/<\/Callout>/g, () => '\n</div></aside>');
}

export function mdxToPreview(src) {
  return mdxToPreviewMapped(src).text;
}

// MDX inside an expression can reach the article component at render time.
// Use the same chart renderer as literal MDX and fenced Markdown.
export async function renderArticleChart(props) {
  const md = await getProcessor();
  const spec = JSON.stringify(chartSpecFromProps(props));
  const { code } = await md.render(['~~~chart', spec, '~~~'].join('\n'));
  return code;
}

/**
 * The studio's split preview: identical HTML to renderPreview, plus
 * data-line="n" on each top-level block (n = 1-based line in `src`).
 * @param {string} src
 */
export async function renderStudioPreview(src) {
  const md = await getStudioProcessor();
  const mapped = mdxToPreviewMapped(src);
  const { code } = await md.render(mapped.text);
  return offsetsToLines(code, mapped, String(src));
}

/** Render a snapshot body for the public article and its table of contents. */
export async function renderLiveArticle(body, ext) {
  const md = await getProcessor();
  const { code, metadata } = await md.render(ext === 'mdx' ? mdxToPreview(body) : body);
  return { html: code, headings: metadata.headings };
}

/** @param {string} src Markdown/MDX source. @returns {Promise<string>} */
export async function renderPreview(src) {
  const md = await getProcessor();
  const { code } = await md.render(mdxToPreview(src));
  return code;
}
