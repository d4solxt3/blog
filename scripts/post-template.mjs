// Shared by `npm run new-post` and the /_admin editor.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const POSTS_DIR = resolve(process.cwd(), 'content/posts');

// These small files travel with the posts, including across deployments.
export const retiredPath = (slug) => `content/retired-posts/${slug}.txt`;
export const isRetiredLocally = (slug) => existsSync(resolve(process.cwd(), retiredPath(slug)));

export function slugify(title) {
  return (
    String(title)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const yamlString = (s) => JSON.stringify(String(s));

export function postTemplate(title) {
  return `---
title: ${yamlString(title)}
subtitle: ""
description: "One or two sentences that appear on the front page."
date: ${today()}
tags: []
draft: true          # visible on your computer only; set to false to publish
# font: sans         # sans | serif | mono (optional, overrides the site default)
# series: "Series name"
# seriesOrder: 1
# pinned: true
# annotations: false # turn off highlight-to-comment for this post
# tldr:
#   - First takeaway.
#   - Second takeaway.
---

Start writing here.

> [!EPISTEMIC] Epistemic status
> How confident are you, and why?

## A section

Inline math like $E = mc^2$, a footnote[^1], and a link to another post: [[reading-the-residual-stream]].

[^1]: Footnotes show a preview card when hovered.
`;
}

/** Creates content/posts/<slug>.mdx and returns its path. Never overwrites. */
export function createPost(title) {
  mkdirSync(POSTS_DIR, { recursive: true });
  const slug = slugify(title);
  const file = join(POSTS_DIR, `${slug}.mdx`);
  if (isRetiredLocally(slug) || existsSync(file) || existsSync(join(POSTS_DIR, `${slug}.md`))) {
    const err = new Error(`The address "${slug}" is in use or retired. Choose a different title.`);
    err.code = 'EEXIST';
    throw err;
  }
  writeFileSync(file, postTemplate(title), { encoding: 'utf8', flag: 'wx' });
  return { slug, file };
}
