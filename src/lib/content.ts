/**
 * Posts for the writing studio.
 *
 * - Drafts autosave to <data dir>/drafts/<slug>.json (the server's persistent
 *   disk on Railway, data/ on your computer). They are private.
 * - Publishing writes content/posts/<slug>.md(x):
 *     · `npm run dev`: straight to the file on your computer;
 *     · live site: one commit to your GitHub repo (post + its new images),
 *       which makes Railway rebuild the site. Needs GITHUB_TOKEN.
 * - Pasted/dropped images go to public/images/posts/<slug>/ locally, or to
 *   <data dir>/media/posts/<slug>/ on the live site until they're published.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import raw from '../../site.config.json';
import { DATA_DIR, DEV } from './auth';

const ROOT = process.cwd();
export const POSTS_DIR = resolve(ROOT, 'content/posts');
const DRAFTS_DIR = join(DATA_DIR, 'drafts');
export const MEDIA_DIR = DEV ? resolve(ROOT, 'public/images/posts') : join(DATA_DIR, 'media/posts');
export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const POST_FILE = /^([a-z0-9][a-z0-9-]*)\.(md|mdx)$/;

const cfg = (raw as Record<string, any>).publishing ?? {};
export const PUBLISHING = {
  repo: String(process.env.GITHUB_REPO || cfg.repo || '').trim(),
  branch: String(process.env.GITHUB_BRANCH || cfg.branch || 'main').trim(),
  token: process.env.GITHUB_TOKEN || '',
};
/** 'local' writes files (npm run dev); 'github' commits; 'off' = live site without a token. */
export const MODE: 'local' | 'github' | 'off' = DEV ? 'local' : PUBLISHING.token && PUBLISHING.repo ? 'github' : 'off';

export type Fields = {
  title: string;
  subtitle: string;
  description: string;
  date: string;
  tags: string[];
  series: string;
  seriesOrder: number | null;
  pinned: boolean;
  font: '' | 'sans' | 'serif' | 'mono';
  draft: boolean;
};

export type Doc = { slug: string; ext: 'md' | 'mdx'; fields: Fields; body: string; extra: Record<string, unknown> };
export type Draft = Doc & { savedAt: number; basis: string | null };

const KNOWN = ['title', 'subtitle', 'description', 'date', 'tags', 'series', 'seriesOrder', 'pinned', 'font', 'draft'];

export const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Same hash GitHub uses for file contents, so local and GitHub versions compare. */
export const blobSha = (content: Buffer | string) => {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};

const asDate = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 10) : '';

export function parsePost(slug: string, ext: 'md' | 'mdx', source: string): Doc {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  let data: Record<string, unknown> = {};
  try {
    data = (m ? YAML.parse(m[1]) : null) ?? {};
  } catch {}
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!KNOWN.includes(k)) extra[k] = v;
  const font = String(data.font ?? '');
  return {
    slug,
    ext,
    body: (m ? m[2] : source).replace(/^\r?\n/, ''),
    extra,
    fields: {
      title: String(data.title ?? ''),
      subtitle: String(data.subtitle ?? ''),
      description: String(data.description ?? ''),
      date: asDate(data.date) || today(),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      series: String(data.series ?? ''),
      seriesOrder: Number.isFinite(Number(data.seriesOrder)) && data.seriesOrder !== undefined ? Number(data.seriesOrder) : null,
      pinned: data.pinned === true,
      font: (['sans', 'serif', 'mono'].includes(font) ? font : '') as Fields['font'],
      draft: data.draft === true,
    },
  };
}

export function serializePost(doc: Pick<Doc, 'fields' | 'body' | 'extra'>): string {
  const f = doc.fields;
  const data: Record<string, unknown> = { title: f.title.trim() };
  if (f.subtitle.trim()) data.subtitle = f.subtitle.trim();
  data.description = f.description.trim();
  data.date = f.date || today();
  if (doc.extra.updated !== undefined) data.updated = asDate(doc.extra.updated);
  data.tags = f.tags.map((t) => t.trim()).filter(Boolean);
  if (f.series.trim()) {
    data.series = f.series.trim();
    if (f.seriesOrder !== null) data.seriesOrder = f.seriesOrder;
  }
  if (f.pinned) data.pinned = true;
  if (f.font) data.font = f.font;
  data.draft = f.draft;
  for (const [k, v] of Object.entries(doc.extra)) if (k !== 'updated') data[k] = v;

  const ydoc = new YAML.Document(data);
  const tags = ydoc.get('tags', true) as { flow?: boolean } | undefined;
  if (tags) tags.flow = true;
  const fm = ydoc.toString({ lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n\n${doc.body.replace(/^\s*\n/, '').trimEnd()}\n`;
}

function writeAtomic(file: string, contents: string | Buffer) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, file);
}

// ---- reading the published version --------------------------------------

async function github(path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.github.com/repos/${PUBLISHING.repo}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${PUBLISHING.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'blog-writing-studio',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`GitHub: ${(data as { message?: string }).message ?? res.statusText} (${res.status})`);
    throw Object.assign(err, { status: res.status });
  }
  return data as any;
}

type Published = { ext: 'md' | 'mdx'; source: string; sha: string };

/** The current published file for a slug: GitHub on the live site, the local file otherwise. */
export async function readPublished(slug: string): Promise<Published | null> {
  for (const ext of ['md', 'mdx'] as const) {
    if (MODE === 'github') {
      try {
        const data = await github(`/contents/content/posts/${slug}.${ext}?ref=${encodeURIComponent(PUBLISHING.branch)}`);
        return { ext, source: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
      }
    } else {
      const file = join(POSTS_DIR, `${slug}.${ext}`);
      if (existsSync(file)) {
        const source = readFileSync(file, 'utf8');
        return { ext, source, sha: blobSha(source) };
      }
    }
  }
  return null;
}

// ---- drafts ---------------------------------------------------------------

const draftFile = (slug: string) => join(DRAFTS_DIR, `${slug}.json`);

export function readDraft(slug: string): Draft | null {
  try {
    return JSON.parse(readFileSync(draftFile(slug), 'utf8')) as Draft;
  } catch {
    return null;
  }
}

export function saveDraft(draft: Omit<Draft, 'savedAt'>): number {
  mkdirSync(DRAFTS_DIR, { recursive: true });
  const savedAt = Date.now();
  writeAtomic(draftFile(draft.slug), JSON.stringify({ ...draft, savedAt }));
  return savedAt;
}

export function deleteDraft(slug: string) {
  rmSync(draftFile(slug), { force: true });
}

export type Listing = { slug: string; title: string; date: string; draft: boolean; unsaved: boolean; savedAt: number | null };

/** Posts on disk plus server drafts (for the studio list and [[ autocomplete). */
export function listPosts(): Listing[] {
  const out = new Map<string, Listing>();
  if (existsSync(POSTS_DIR)) {
    for (const file of readdirSync(POSTS_DIR)) {
      const m = file.match(POST_FILE);
      if (!m || file.startsWith('_')) continue;
      const doc = parsePost(m[1], m[2] as 'md' | 'mdx', readFileSync(join(POSTS_DIR, file), 'utf8'));
      out.set(m[1], { slug: m[1], title: doc.fields.title || m[1], date: doc.fields.date, draft: doc.fields.draft, unsaved: false, savedAt: null });
    }
  }
  if (existsSync(DRAFTS_DIR)) {
    for (const file of readdirSync(DRAFTS_DIR)) {
      const slug = file.replace(/\.json$/, '');
      if (!SLUG.test(slug)) continue;
      const d = readDraft(slug);
      if (!d) continue;
      const prev = out.get(slug);
      out.set(slug, {
        slug,
        title: d.fields.title || prev?.title || slug,
        date: d.fields.date || prev?.date || '',
        draft: prev ? prev.draft : true,
        unsaved: true,
        savedAt: d.savedAt,
      });
    }
  }
  return [...out.values()].sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0) || b.date.localeCompare(a.date));
}

export type MetaIndex = {
  tags: { name: string; count: number }[];
  series: { name: string; parts: number; maxPart: number }[];
};

/** Every tag and series already used (posts on disk + server drafts), for the studio's pickers. */
export function metaIndex(): MetaIndex {
  const docs = new Map<string, Fields>();
  if (existsSync(POSTS_DIR)) {
    for (const file of readdirSync(POSTS_DIR)) {
      const m = file.match(POST_FILE);
      if (m && !file.startsWith('_')) docs.set(m[1], parsePost(m[1], m[2] as 'md' | 'mdx', readFileSync(join(POSTS_DIR, file), 'utf8')).fields);
    }
  }
  if (existsSync(DRAFTS_DIR)) {
    for (const file of readdirSync(DRAFTS_DIR)) {
      const d = readDraft(file.replace(/\.json$/, ''));
      if (d) docs.set(d.slug, d.fields);
    }
  }
  const tags = new Map<string, { name: string; count: number }>();
  const series = new Map<string, { name: string; parts: number; maxPart: number }>();
  for (const f of docs.values()) {
    for (const t of f.tags) {
      const key = t.trim().toLowerCase();
      if (!key) continue;
      const entry = tags.get(key) ?? { name: t.trim(), count: 0 };
      entry.count += 1;
      tags.set(key, entry);
    }
    const name = f.series.trim();
    if (name) {
      const entry = series.get(name) ?? { name, parts: 0, maxPart: 0 };
      entry.parts += 1;
      entry.maxPart = Math.max(entry.maxPart, f.seriesOrder ?? entry.parts);
      series.set(name, entry);
    }
  }
  return {
    tags: [...tags.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    series: [...series.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function newDoc(slug: string, title: string): Doc {
  return {
    slug,
    ext: 'md',
    extra: {},
    body: '',
    fields: { title, subtitle: '', description: '', date: today(), tags: [], series: '', seriesOrder: null, pinned: false, font: '', draft: true },
  };
}

// ---- media ----------------------------------------------------------------

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
export const MAX_MEDIA = 20 * 1024 * 1024;
export const mediaType = (name: string) => IMAGE_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? null;

/** Checks the file's first bytes so a renamed file can't pose as an image. */
export function sniffImage(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  const head = buf.subarray(0, 1024).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

export function saveMedia(slug: string, name: string, buf: Buffer): { path: string; src: string } {
  const kind = sniffImage(buf);
  if (!kind) throw Object.assign(new Error('Images only: png, jpg, gif, webp or svg.'), { status: 415 });
  const base =
    name
      .replace(/\.[^.]*$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'image';
  const file = `${base}-${blobSha(buf).slice(0, 6)}.${kind}`;
  const dir = join(MEDIA_DIR, slug);
  mkdirSync(dir, { recursive: true });
  const full = join(dir, file);
  if (!existsSync(full)) writeAtomic(full, buf);
  const path = `/images/posts/${slug}/${file}`;
  return { path, src: DEV ? path : `/api/media/${slug}/${file}` };
}

export function readMedia(slug: string, file: string): { buf: Buffer; type: string } | null {
  if (!SLUG.test(slug) || !/^[a-z0-9][a-z0-9-]*\.(png|jpg|gif|webp|svg)$/.test(file)) return null;
  const full = join(MEDIA_DIR, slug, file);
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return { buf: readFileSync(full), type: mediaType(file)! };
}

/** Images from this post's media folder that the body links to. */
function referencedMedia(slug: string, body: string) {
  const re = new RegExp(`/images/posts/${slug}/([a-z0-9][a-z0-9-]*\\.(?:png|jpg|gif|webp|svg))`, 'g');
  const names = new Set([...body.matchAll(re)].map((m) => m[1]));
  return [...names].map((file) => ({ file, media: readMedia(slug, file) })).filter((m) => m.media);
}

// ---- publishing -----------------------------------------------------------

export type PublishResult = { mode: 'local' | 'github'; commit?: string; path: string; created: boolean; sha: string };

export async function publish(doc: Doc): Promise<PublishResult> {
  if (MODE === 'off') {
    throw Object.assign(new Error('Publishing from the live site needs GITHUB_TOKEN. See CUSTOMIZING.md → "Writing on the live site".'), {
      status: 503,
    });
  }
  const existing = await readPublished(doc.slug);
  const ext = existing?.ext ?? doc.ext;
  const path = `content/posts/${doc.slug}.${ext}`;
  const source = serializePost(doc);

  if (MODE === 'local') {
    mkdirSync(POSTS_DIR, { recursive: true });
    writeAtomic(join(ROOT, path), source);
    return { mode: 'local', path, created: !existing, sha: blobSha(source) };
  }

  // One commit: the post plus every image it links to from its media folder.
  const files: { path: string; content: Buffer }[] = [{ path, content: Buffer.from(source, 'utf8') }];
  for (const { file, media } of referencedMedia(doc.slug, doc.body)) {
    files.push({ path: `public/images/posts/${doc.slug}/${file}`, content: media!.buf });
  }
  const ref = await github(`/git/ref/heads/${encodeURIComponent(PUBLISHING.branch)}`);
  const parent = ref.object.sha as string;
  const base = await github(`/git/commits/${parent}`);
  const tree = await Promise.all(
    files.map(async (f) => {
      const blob = await github('/git/blobs', { method: 'POST', body: JSON.stringify({ content: f.content.toString('base64'), encoding: 'base64' }) });
      return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
    }),
  );
  const newTree = await github('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
  const verb = existing ? 'Update' : 'Publish';
  const commit = await github('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message: `${verb} "${doc.fields.title.trim()}" from the writing studio`, tree: newTree.sha, parents: [parent] }),
  });
  await github(`/git/refs/heads/${encodeURIComponent(PUBLISHING.branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  return { mode: 'github', commit: String(commit.sha).slice(0, 7), path, created: !existing, sha: blobSha(source) };
}
