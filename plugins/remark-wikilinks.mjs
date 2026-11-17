// [[post-slug]] or [[post-slug|custom label]] → link to /posts/post-slug/
// The label defaults to the target post's title. Missing targets render as a
// struck-through span so broken links are obvious while writing.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { visit, SKIP } from 'unist-util-visit';

const POSTS = resolve(process.cwd(), 'content/posts');
const RE = /\[\[([a-z0-9][a-z0-9-]*)(?:\|([^\]]+))?\]\]/gi;

function postTitles() {
  const titles = new Map();
  let files = [];
  try {
    files = readdirSync(POSTS);
  } catch {
    return titles;
  }
  for (const f of files) {
    if (!/\.(md|mdx)$/.test(f) || f.startsWith('_')) continue;
    const src = readFileSync(join(POSTS, f), 'utf8');
    const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const t = fm?.[1].match(/^title:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '');
    titles.set(f.replace(/\.(md|mdx)$/, ''), t || f);
  }
  return titles;
}

export default function remarkWikiLinks() {
  return (tree) => {
    const titles = postTitles();
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined || parent.type === 'link' || !RE.test(node.value)) return;
      RE.lastIndex = 0;
      const out = [];
      let last = 0;
      for (const m of node.value.matchAll(RE)) {
        const [whole, rawSlug, label] = m;
        const slug = rawSlug.toLowerCase();
        if (m.index > last) out.push({ type: 'text', value: node.value.slice(last, m.index) });
        if (titles.has(slug)) {
          out.push({
            type: 'link',
            url: `/posts/${slug}/`,
            data: { hProperties: { className: ['wikilink'], 'data-wikilink': slug } },
            children: [{ type: 'text', value: label?.trim() || titles.get(slug) }],
          });
        } else {
          out.push({
            type: 'emphasis',
            data: { hName: 'span', hProperties: { className: ['wikilink-missing'], title: `No post called "${slug}"` } },
            children: [{ type: 'text', value: label?.trim() || slug }],
          });
        }
        last = m.index + whole.length;
      }
      if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) });
      parent.children.splice(index, 1, ...out);
      return [SKIP, index + out.length];
    });
  };
}
