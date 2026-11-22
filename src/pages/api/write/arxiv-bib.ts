/**
 * Owner-only arXiv ID → BibTeX lookup for the /write studio [ bib ] drawer.
 * GET /api/write/arxiv-bib?id=1706.03762 (or full arxiv.org/abs/... URL)
 */
import type { APIRoute } from 'astro';
import { isOwner, json, ownerOnly } from '../../../lib/auth';

export const prerender = false;

const ARXIV_ID_RE = /(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:)?([0-9]{4}\.[0-9]{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/i;

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function cleanWs(s: string): string {
  return decodeXml(s).replace(/\s+/g, ' ').trim();
}

function surname(full: string): string {
  const parts = full.trim().split(/\s+/);
  return (parts.at(-1) ?? 'author').toLowerCase().replace(/[^a-z0-9]/g, '') || 'author';
}

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'for', 'to', 'and', 'with', 'by', 'from', 'is', 'are', 'as', 'at', 'via', 'towards', 'toward']);

function firstKeyword(title: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.find((w) => w.length > 2 && !STOPWORDS.has(w)) ?? words[0] ?? 'paper';
}

function escBib(s: string): string {
  return s.replace(/[{}]/g, (m) => `\\${m}`);
}

export const GET: APIRoute = async ({ request, url }) => {
  if (!isOwner(request)) return ownerOnly();
  const raw = (url.searchParams.get('id') ?? '').trim();
  const m = raw.match(ARXIV_ID_RE);
  if (!m) {
    return json({ error: 'Enter a valid arXiv ID or URL (e.g. 1706.03762 or https://arxiv.org/abs/2405.12345).' }, 400);
  }
  const id = m[1];
  const baseId = id.replace(/v\d+$/i, '');

  try {
    const res = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
      headers: { 'user-agent': 'heartcache-writing-studio/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return json({ error: `arXiv API returned ${res.status}.` }, 502);
    const xml = await res.text();
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    if (!entryMatch) return json({ error: `No arXiv entry found for ${id}.` }, 404);
    const entry = entryMatch[1];

    const title = cleanWs(entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '');
    if (!title || /^error$/i.test(title)) {
      return json({ error: `No arXiv paper found for ${id}.` }, 404);
    }

    const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((a) => cleanWs(a[1])).filter(Boolean);
    const published = entry.match(/<published>(\d{4})/)?.[1] ?? new Date().getFullYear().toString();
    const primaryClass = entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1]
      ?? entry.match(/<category[^>]*term="([^"]+)"/)?.[1]
      ?? 'cs.LG';

    const key = `${surname(authors[0] ?? 'arxiv')}${published}${firstKeyword(title)}`;
    const bibtex = [
      `@article{${key},`,
      `  title = {${escBib(title)}},`,
      `  author = {${escBib(authors.join(' and '))}},`,
      `  year = {${published}},`,
      `  journal = {arXiv preprint arXiv:${baseId}},`,
      `  eprint = {${baseId}},`,
      `  archivePrefix = {arXiv},`,
      `  primaryClass = {${primaryClass}},`,
      `  url = {https://arxiv.org/abs/${baseId}}`,
      `}`,
    ].join('\n');

    return json({ key, id: baseId, title, authors, year: published, primaryClass, bibtex });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not reach arXiv.';
    return json({ error: `arXiv lookup failed: ${msg}` }, 502);
  }
};
