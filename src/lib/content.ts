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
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { isRetiredLocally, retiredPath } from '../../scripts/post-template.mjs';
import raw from '../../site.config.json';
import { retiredOnServer, retireOnServer } from './retired-posts';
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

async function repoFile(path: string, ref: string) {
  try {
    return await github(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export async function isRetired(slug: string, ref = PUBLISHING.branch): Promise<boolean> {
  if (retiredOnServer(slug)) return true;
  return MODE === 'github' ? !!(await repoFile(retiredPath(slug), ref)) : isRetiredLocally(slug);
}

type Published = { ext: 'md' | 'mdx'; source: string; sha: string };

function readPostFile(slug: string): Published | null {
  for (const ext of ['md', 'mdx'] as const) {
    const file = join(POSTS_DIR, `${slug}.${ext}`);
    if (existsSync(file)) {
      const source = readFileSync(file, 'utf8');
      return { ext, source, sha: blobSha(source) };
    }
  }
  return null;
}

export async function readPublished(slug: string): Promise<Published | null> {
  if (retiredOnServer(slug)) return null;
  if (MODE !== 'github') return readPostFile(slug);
  for (const ext of ['md', 'mdx'] as const) {
    const data = await repoFile(`content/posts/${slug}.${ext}`, PUBLISHING.branch);
    if (data) return { ext, source: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
  }
  return null;
}

/** An owner can edit the deployed source during a credentials failure. Writes to GitHub
 * still use readPublished and require a current repository read. */
export async function readForEditing(slug: string) {
  try {
    return { published: await readPublished(slug), tokenRejected: false };
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error;
    return { published: retiredOnServer(slug) ? null : readPostFile(slug), tokenRejected: true };
  }
}

// ---- drafts ---------------------------------------------------------------

const draftFile = (slug: string) => join(DRAFTS_DIR, `${slug}.json`);

export function readDraft(slug: string): Draft | null {
  if (retiredOnServer(slug)) return null;
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

// Recheck each mutation after earlier writes for the same post finish.
const pending = new Map<string, Promise<unknown>>();

export async function editPost<T>(slug: string, action: () => Promise<T>): Promise<T> {
  const previous = pending.get(slug) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  pending.set(slug, next);
  try {
    return await next;
  } finally {
    if (pending.get(slug) === next) pending.delete(slug);
  }
}

export async function removePost(slug: string, version: string) {
  const pub = await readPublished(slug);
  const draft = readDraft(slug);
  if (!pub && !draft) throw Object.assign(new Error('This post is already gone. Refresh the studio.'), { status: 404 });
  if (version !== postVersion(pub?.sha ?? null, draft?.savedAt ?? null)) {
    throw Object.assign(new Error('This post changed. Refresh the studio and review it before deleting.'), { status: 409 });
  }

  if (pub) {
    const name = `${slug}.${pub.ext}`;
    const marker = retiredPath(slug);
    if (MODE === 'off') {
      retireOnServer(slug);
    } else if (MODE === 'local') {
      const markerFile = join(ROOT, marker);
      mkdirSync(dirname(markerFile), { recursive: true });
      const alreadyReserved = existsSync(markerFile);
      writeAtomic(markerFile, slug + '\n');
      try {
        rmSync(join(POSTS_DIR, name));
      } catch (err) {
        if (!alreadyReserved) rmSync(markerFile, { force: true });
        throw err;
      }
    } else {
      const parent = await branchHead();
      const path = `content/posts/${name}`;
      if ((await repoFile(path, parent))?.sha !== pub.sha) {
        throw Object.assign(new Error('The file changed. Refresh the studio before deleting.'), { status: 409 });
      }
      await commitTree(parent, [
        { path, mode: '100644', type: 'blob', sha: null },
        { path: marker, mode: '100644', type: 'blob', content: slug + '\n' },
      ], `Delete ${name} and reserve its address`);
    }
  }
  deleteDraft(slug);
  return { rebuild: !!pub && MODE === 'github' };
}

export const postVersion = (sha: string | null, savedAt: number | null) => `"${sha ?? 'draft'}:${savedAt ?? 0}"`;

export type Listing = { publishedSha: string | null; slug: string; title: string; date: string; draft: boolean; unsaved: boolean; savedAt: number | null };

/** Posts on disk plus server drafts (for the studio list and [[ autocomplete). */
export function listPosts(): Listing[] {
  const out = new Map<string, Listing>();
  if (existsSync(POSTS_DIR)) {
    for (const file of readdirSync(POSTS_DIR)) {
      const m = file.match(POST_FILE);
      if (!m || file.startsWith('_') || retiredOnServer(m[1])) continue;
      const source = readFileSync(join(POSTS_DIR, file), 'utf8');
      const doc = parsePost(m[1], m[2] as 'md' | 'mdx', source);
      out.set(m[1], { publishedSha: blobSha(source), slug: m[1], title: doc.fields.title || m[1], date: doc.fields.date, draft: doc.fields.draft, unsaved: false, savedAt: null });
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
        publishedSha: prev?.publishedSha ?? null,
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
      if (m && !file.startsWith('_') && !retiredOnServer(m[1])) docs.set(m[1], parsePost(m[1], m[2] as 'md' | 'mdx', readFileSync(join(POSTS_DIR, file), 'utf8')).fields);
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
  return { path: mediaPath(slug, file), src: mediaSrc(slug, file) };
}

/** Names saveMedia produces (and the only names served, listed or deleted). */
export const MEDIA_FILE = /^[a-z0-9][a-z0-9-]*\.(png|jpg|gif|webp|svg)$/;
export const mediaPath = (slug: string, file: string) => `/images/posts/${slug}/${file}`;
/** A URL that shows the file in the editor right now. */
export const mediaSrc = (slug: string, file: string) => (DEV ? mediaPath(slug, file) : `/api/media/${slug}/${file}`);

export function readMedia(slug: string, file: string): { buf: Buffer; type: string } | null {
  if (!SLUG.test(slug) || !MEDIA_FILE.test(file)) return null;
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

/** Slugs of every post (file on disk or server draft) whose body links to this exact media path. */
export function mediaUses(path: string): string[] {
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}(?![A-Za-z0-9_.-])`);
  const uses = new Set<string>();
  if (existsSync(POSTS_DIR)) {
    for (const file of readdirSync(POSTS_DIR)) {
      const m = file.match(POST_FILE);
      if (!m || file.startsWith('_') || retiredOnServer(m[1])) continue;
      try {
        if (re.test(readFileSync(join(POSTS_DIR, file), 'utf8'))) uses.add(m[1]);
      } catch {}
    }
  }
  if (existsSync(DRAFTS_DIR)) {
    for (const file of readdirSync(DRAFTS_DIR)) {
      const slug = file.replace(/\.json$/, '');
      if (!SLUG.test(slug)) continue;
      const d = readDraft(slug);
      if (d && typeof d.body === 'string' && re.test(d.body)) uses.add(slug);
    }
  }
  return [...uses].sort();
}

/**
 * Whether this file is already part of the published site:
 * tracked in git (npm run dev), in the GitHub repo (live site with a token),
 * or shipped with the current deploy (live site without one).
 */
export async function mediaPublished(slug: string, file: string): Promise<boolean> {
  if (!SLUG.test(slug) || !MEDIA_FILE.test(file)) return false;
  const rel = `public/images/posts/${slug}/${file}`;
  if (MODE === 'local') {
    return new Promise((done) => {
      execFile('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: ROOT, windowsHide: true }, (err) => done(!err));
    });
  }
  if (MODE === 'github') return !!(await repoFile(rel, PUBLISHING.branch));
  return existsSync(join(ROOT, rel)) || existsSync(join(ROOT, 'dist/client/images/posts', slug, file));
}

export type MediaInfo = {
  name: string;
  path: string;
  src: string;
  size: number;
  type: string;
  modified: string;
  uses: string[];
  published: boolean;
};

/** The post's media folder, newest first. Unknown file names are skipped. */
export async function listMedia(slug: string): Promise<MediaInfo[]> {
  if (!SLUG.test(slug)) return [];
  const dir = join(MEDIA_DIR, slug);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => MEDIA_FILE.test(name));
  const out = await Promise.all(
    files.map(async (name): Promise<(MediaInfo & { mtime: number }) | null> => {
      let st;
      try {
        st = statSync(join(dir, name));
      } catch {
        return null;
      }
      if (!st.isFile()) return null;
      const path = mediaPath(slug, name);
      return {
        name,
        path,
        src: mediaSrc(slug, name),
        size: st.size,
        type: mediaType(name)!,
        modified: st.mtime.toISOString(),
        uses: mediaUses(path),
        published: await mediaPublished(slug, name),
        mtime: st.mtimeMs,
      };
    }),
  );
  return out
    .filter((f): f is MediaInfo & { mtime: number } => !!f)
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    .map(({ mtime: _mtime, ...f }) => f);
}

/** Removes one file from the post's media folder. Callers check uses/published first. */
export function deleteMedia(slug: string, file: string): boolean {
  if (!SLUG.test(slug) || !MEDIA_FILE.test(file)) return false;
  const full = join(MEDIA_DIR, slug, file);
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  rmSync(full);
  return true;
}

// ---- publishing -----------------------------------------------------------

export type PublishResult = { mode: 'local' | 'github'; commit?: string; path: string; created: boolean; sha: string };

/**
 * A read-only check that live publishing will work: the token is present,
 * can see the repo, may write to it, and the branch exists. Never returns
 * or logs the token itself.
 */
export async function checkPublishing(): Promise<{ ok: boolean; message: string; head?: string }> {
  if (DEV) return { ok: true, message: 'on your computer, publishing goes through the local editor (no token needed).' };
  if (!PUBLISHING.repo) return { ok: false, message: 'no repo set: add "publishing": { "repo": "owner/name" } to site.config.json.' };
  if (!PUBLISHING.token) return { ok: false, message: 'no GITHUB_TOKEN on the server yet: add it in Railway → web → Variables.' };
  try {
    const repo = await github('');
    if (!repo?.permissions?.push) return { ok: false, message: `the token can read ${PUBLISHING.repo} but not write to it: give it Contents → Read and write.` };
    const head = await branchHead();
    return { ok: true, message: `ready: commits go to ${PUBLISHING.repo} on "${PUBLISHING.branch}".`, head: head.slice(0, 7) };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401) return { ok: false, message: 'GitHub rejected the token (expired or mistyped): make a new one and replace GITHUB_TOKEN.' };
    if (status === 404) return { ok: false, message: `the token can't see ${PUBLISHING.repo}, or branch "${PUBLISHING.branch}" doesn't exist: check the token's repository access.` };
    return { ok: false, message: err instanceof Error ? err.message : 'could not reach GitHub.' };
  }
}

async function branchHead(): Promise<string> {
  const ref = await github(`/git/ref/heads/${encodeURIComponent(PUBLISHING.branch)}`);
  return ref.object.sha;
}

type TreeChange = { path: string; mode: string; type: string } & ({ sha: string | null } | { content: string });

async function commitTree(parent: string, changes: TreeChange[], message: string): Promise<string> {
  const base = await github(`/git/commits/${parent}`);
  const tree = await github('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree: changes }) });
  const commit = await github('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }),
  });
  await github(`/git/refs/heads/${encodeURIComponent(PUBLISHING.branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  return commit.sha;
}

export async function publish(doc: Doc): Promise<PublishResult> {
  if (MODE === 'off') {
    throw Object.assign(new Error('Publishing from the live site needs GITHUB_TOKEN. See CUSTOMIZING.md → "Writing on the live site".'), {
      status: 503,
    });
  }
  const parent = MODE === 'github' ? await branchHead() : '';
  if (await isRetired(doc.slug, parent)) throw Object.assign(new Error('This address is retired. Start a post with a new address.'), { status: 410 });
  const existing = await readPublished(doc.slug);
  if (!existing && !readDraft(doc.slug)) throw Object.assign(new Error('This post was deleted. Start a new draft to keep writing.'), { status: 410 });
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
  const tree = await Promise.all(
    files.map(async (f) => {
      const blob = await github('/git/blobs', { method: 'POST', body: JSON.stringify({ content: f.content.toString('base64'), encoding: 'base64' }) });
      return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
    }),
  );
  const verb = existing ? 'Update' : 'Publish';
  const commit = await commitTree(parent, tree, `${verb} "${doc.fields.title.trim()}" from the writing studio`);
  return { mode: 'github', commit: commit.slice(0, 7), path, created: !existing, sha: blobSha(source) };
}
