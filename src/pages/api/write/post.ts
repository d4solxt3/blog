/**
 * Owner-only post endpoint for the /write studio.
 * GET    ?slug=        → { mode, published, draft }
 * PUT    { slug, ... } → autosave the draft on the server        → { savedAt }
 * POST   { slug, ... } → publish (file locally / GitHub commit)  → { result }
 * DELETE ?slug=        → throw away the server draft
 */
import type { APIRoute } from 'astro';
import { isOwner, json, ownerOnly } from '../../../lib/auth';
import {
  deleteDraft,
  editPost,
  MODE,
  parsePost,
  publish,
  readDraft,
  readForEditing,
  saveDraft,
  SLUG,
  type Doc,
  type Fields,
} from '../../../lib/content';

export const prerender = false;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

function cleanFields(f: Record<string, unknown> = {}): Fields {
  const order = Number(f.seriesOrder);
  const font = text(f.font, 8);
  const citationStyle = text(f.citationStyle, 16);
  return {
    title: text(f.title, 300),
    subtitle: text(f.subtitle, 500),
    description: text(f.description, 1000),
    date: /^\d{4}-\d{2}-\d{2}$/.test(text(f.date, 10)) ? text(f.date, 10) : '',
    tags: (Array.isArray(f.tags) ? f.tags : []).map((t) => text(t, 60).trim()).filter(Boolean).slice(0, 30),
    series: text(f.series, 200),
    seriesOrder: f.seriesOrder === null || f.seriesOrder === '' || !Number.isFinite(order) ? null : Math.round(order),
    pinned: f.pinned === true,
    font: (['sans', 'serif', 'mono'].includes(font) ? font : '') as Fields['font'],
    draft: f.draft !== false,
    macros: text(f.macros, 50_000),
    bibliography: text(f.bibliography, 200_000),
    citationStyle: (['numeric', 'author-year'].includes(citationStyle) ? citationStyle : '') as Fields['citationStyle'],
  };
}

function readDoc(body: Record<string, unknown>): Doc | null {
  const slug = text(body.slug, 80);
  if (!SLUG.test(slug)) return null;
  const extra = body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra) ? (body.extra as Record<string, unknown>) : {};
  return {
    slug,
    ext: body.ext === 'mdx' ? 'mdx' : 'md',
    fields: cleanFields(body.fields as Record<string, unknown>),
    body: text(body.body, 2_000_000),
    extra,
  };
}

export const GET: APIRoute = async ({ request, url }) => {
  if (!isOwner(request)) return ownerOnly();
  const slug = url.searchParams.get('slug') ?? '';
  if (!SLUG.test(slug)) return json({ error: 'Bad slug.' }, 400);
  try {
    const { published: pub, tokenRejected } = await readForEditing(slug);
    const draft = readDraft(slug);
    if (!pub && !draft) return json({ error: 'No post with that name.' }, 404);
    return json({ mode: tokenRejected ? 'off' : MODE, published: pub ? { doc: parsePost(slug, pub.ext, pub.source), sha: pub.sha } : null, draft });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Could not load the post.' }, 502);
  }
};

export const PUT: APIRoute = async ({ request }) => {
  if (!isOwner(request)) return ownerOnly();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const doc = body && readDoc(body);
  if (!doc) return json({ error: 'Bad draft.' }, 400);
  const basis = typeof body!.basis === 'string' ? body!.basis : null;
  try {
    return await editPost(doc.slug, async () => {
      if (!readDraft(doc.slug) && !(await readForEditing(doc.slug)).published) return json({ error: 'This post was deleted.' }, 410);
      return json({ savedAt: saveDraft({ ...doc, basis }) });
    });
  } catch {
    return json({ error: 'Could not save the draft.' }, 502);
  }
};

export const POST: APIRoute = async ({ request, url, clientAddress }) => {
  if (!isOwner(request)) return ownerOnly();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const doc = body && readDoc(body);
  if (!doc) return json({ error: 'Bad post.' }, 400);
  if (!doc.fields.title.trim()) return json({ error: 'Give the post a title first.', field: 'title' }, 400);
  if (!doc.fields.description.trim()) return json({ error: 'Add a description (one or two sentences for the front page).', field: 'description' }, 400);
  const deployLocal = import.meta.env.DEV && !doc.fields.draft && request.headers.get('x-editor-action') === 'publish';
  if (deployLocal && (request.headers.get('origin') !== url.origin ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientAddress))) {
    return json({ error: 'Publish from the local writing studio.' }, 403);
  }
  try {
    return await editPost(doc.slug, async () => {
      const expectedSha = typeof body!.basis === 'string' || body!.basis === null ? body!.basis as string | null : undefined;
      const result = await publish(doc, { expectedSha });
      if (import.meta.env.DEV && deployLocal) {
        const { publishFile } = await import('../../../../plugins/editor-publish.mjs');
        result.commit = await publishFile(result.path);
      }
      deleteDraft(doc.slug);
      return json({ result });
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    return json({ error: err instanceof Error ? err.message : 'Could not publish.' }, status === 503 || status === 410 || status === 409 ? status : 502);
  }
};

export const DELETE: APIRoute = ({ request, url }) => {
  if (!isOwner(request)) return ownerOnly();
  const slug = url.searchParams.get('slug') ?? '';
  if (!SLUG.test(slug)) return json({ error: 'Bad slug.' }, 400);
  deleteDraft(slug);
  return json({ ok: true });
};
