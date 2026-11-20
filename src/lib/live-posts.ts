import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, DEV } from './auth';
import type { Doc } from './content';
import { readPostFile, SLUG } from './post-source';
import { retiredOnServer } from './retired-posts';

export type LivePost = {
  doc: Doc;
  source: string;
  sha: string;
  html: string;
  headings: { depth: number; slug: string; text: string }[];
  media: string[];
};
type StoredPost = LivePost & { predecessors: (string | null)[] };
const directory = join(DATA_DIR, 'published-posts');

export function getLivePost(slug: string): StoredPost | null {
  if (DEV || !SLUG.test(slug) || retiredOnServer(slug)) return null;
  const file = join(directory, slug + '.json');
  if (!existsSync(file)) return null;
  const saved: StoredPost = JSON.parse(readFileSync(file, 'utf8'));
  const shipped = readPostFile(slug)?.sha ?? null;
  // Hand the post back to Astro once a build includes it or a newer file.
  if (shipped === saved.sha || !saved.predecessors.includes(shipped)) {
    rmSync(file, { force: true });
    return null;
  }
  return saved;
}

export function livePosts(): LivePost[] {
  if (DEV || !existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json'))
    .map(name => getLivePost(name.slice(0, -5))).filter((p): p is StoredPost => p !== null);
}

// Prepare the rendered copy before updating GitHub. A failed commit cannot expose a draft.
export function stageLivePost(post: LivePost, parentSha: string | null) {
  mkdirSync(directory, { recursive: true });
  const slug = post.doc.slug;
  const staged = join(directory, randomUUID() + '.pending');
  const previous = getLivePost(slug);
  // An in-flight build may contain any intermediate revision from this volume.
  const predecessors = [...new Set([readPostFile(slug)?.sha ?? null, parentSha,
    ...(previous ? [previous.sha, ...previous.predecessors] : [])])];
  writeFileSync(staged, JSON.stringify({ ...post, predecessors }), { mode: 0o600 });
  return {
    activate: () => renameSync(staged, join(directory, slug + '.json')),
    discard: () => rmSync(staged, { force: true }),
  };
}
