import { getCollection, type CollectionEntry } from 'astro:content';
import { isRetiredLocally } from '../../scripts/post-template.mjs';
import { retiredOnServer } from '../lib/retired-posts';
import { livePosts, type LivePost } from '../lib/live-posts';
import { SITE } from '../site.config';

import { assignAddresses } from '../lib/post-addresses';

type BuiltPost = CollectionEntry<'posts'>;
export type Post = { publicAddress?: string } & (
  | (BuiltPost & { live?: never })
  | (Pick<BuiltPost, 'id' | 'data'> & { body: string; live: LivePost }));

function livePostData({ fields, extra }: LivePost['doc']): BuiltPost['data'] {
  const { tldr, annotations, updated } = extra;
  const updatedDate = typeof updated === 'string' || typeof updated === 'number' || updated instanceof Date
    ? new Date(updated)
    : undefined;

  return {
    ...fields,
    subtitle: fields.subtitle || undefined,
    date: new Date(fields.date),
    updated: updatedDate && Number.isFinite(updatedDate.valueOf()) ? updatedDate : undefined,
    series: fields.series || undefined,
    seriesOrder: fields.seriesOrder ?? undefined,
    font: fields.font || undefined,
    tldr: typeof tldr === 'string' || (Array.isArray(tldr) && tldr.every((line) => typeof line === 'string'))
      ? tldr
      : undefined,
    annotations: annotations !== false,
  };
}

/** Published posts: pinned first, then newest. Built drafts also appear in dev. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection('posts', ({ data }) => import.meta.env.DEV || !data.draft);
  const conflict = posts.find((post) => isRetiredLocally(post.id));
  if (conflict) throw new Error(`The address "${conflict.id}" is retired. Rename the new Markdown file to give it its own discussion.`);

  const merged = new Map<string, Post>(posts.map((post) => [post.id, post]));
  for (const live of livePosts()) {
    const { doc } = live;
    if (doc.fields.draft || isRetiredLocally(doc.slug)) {
      merged.delete(doc.slug);
      continue;
    }
    merged.set(doc.slug, { id: doc.slug, body: doc.body, data: livePostData(doc), live });
  }

  const visible = [...merged.values()].filter(post => !retiredOnServer(post.id));
  const addresses = assignAddresses(visible.map(p => ({ id: p.id, title: p.data.title })));
  return visible.map(p => ({ ...p, publicAddress: addresses.get(p.id) }))
    .sort((a, b) => Number(b.data.pinned) - Number(a.data.pinned) || b.data.date.valueOf() - a.data.date.valueOf());
}

/** Same posts, strictly newest first (used for entry numbers and prev/next). */
export async function getPostsByDate(): Promise<Post[]> {
  return (await getPosts()).sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export const postUrl = (post: Post) => `/posts/${post.publicAddress ?? post.id}/`;

/** 2026-11-17 -> "2026.11.17" (UTC, so frontmatter dates never shift a day). */
export function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

export const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Chronological entry number as a catalogue code: 2 -> "#002". */
export const entryCode = (n: number) => `#${pad(n, 3)}`;

/**
 * Estimated reading time in minutes. Prose is read at ~230 wpm; code, maths
 * and markup count for less so technical posts aren't over-estimated.
 */
export function readingTime(body = ''): number {
  let codeWords = 0;
  const prose = body
    .replace(/```[\s\S]*?```|\$\$[\s\S]*?\$\$/g, (block) => {
      codeWords += block.split(/\s+/).length;
      return ' ';
    })
    .replace(/\$[^$\n]+\$/g, ' x ') // each inline maths expression reads as roughly one word
    .replace(/^\s*(import|export)\s.*$/gm, ' ')
    .replace(/<\/?[A-Za-z][^>\n]*>/g, ' ') // real tags only, so maths like "S < 0" survives
    .replace(/\[\^[^\]]+\]:?/g, ' ')
    .replace(/[#>*_`~\[\]()!|$-]/g, ' ');
  const words = prose.split(/\s+/).filter(Boolean).length + codeWords * 0.4;
  return Math.max(1, Math.round(words / 230));
}

export const tagSlug = (tag: string) => tag.toLowerCase().trim().replace(/\s+/g, '-');

export type Status = 'draft' | 'pin' | 'new' | 'txt';

/** Forum-style status badge for a thread. */
export function threadStatus(post: Post, now = new Date()): Status {
  if (post.data.draft) return 'draft';
  if (post.data.pinned) return 'pin';
  const ageDays = (now.valueOf() - post.data.date.valueOf()) / 86_400_000;
  return ageDays <= SITE.newBadgeDays ? 'new' : 'txt';
}

export type SeriesInfo = { name: string; index: number; total: number; parts: Post[] };

/** "Part X of Y" info for a post that belongs to a series. */
export function seriesOf(post: Post, all: Post[]): SeriesInfo | null {
  const name = post.data.series;
  if (!name) return null;
  const parts = all
    .filter((p) => p.data.series === name)
    .sort((a, b) => (a.data.seriesOrder ?? 0) - (b.data.seriesOrder ?? 0) || a.data.date.valueOf() - b.data.date.valueOf());
  return { name, index: parts.findIndex((p) => p.id === post.id) + 1, total: parts.length, parts };
}
