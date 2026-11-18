/**
 * A post's media folder. Owner only.
 *
 * POST /api/upload-media?slug=<post>&name=<file name>  (body: the image bytes)
 * → { path, src }: `path` goes in the Markdown, `src` works right away in the editor.
 * png, jpg, gif (animation kept), webp and svg, up to 20 MB.
 *
 * GET /api/upload-media?slug=<post>
 * → { files: [{ name, path, src, size, type, modified, uses, published }] }, newest first.
 *   `uses`: slugs of posts (files on disk or saved drafts) whose body links to `path`.
 *   `published`: the file is already part of the published site (git / GitHub / deploy).
 *
 * DELETE /api/upload-media?slug=<post>&name=<file>
 *   Needs a same-origin `Origin` header and `x-studio-action: delete-media` (else 403).
 *   409 { error, published: true } if the file is on the live site (never deleted here).
 *   409 { error, uses } if posts still link to it, unless `x-studio-confirm-uses`
 *   equals those slugs, sorted and comma-joined.
 *   → { deleted: name }; 404 if there's no such file.
 */
import type { APIRoute } from 'astro';
import { isOwner, json, ownerOnly } from '../../lib/auth';
import { deleteMedia, listMedia, MAX_MEDIA, MEDIA_FILE, mediaPath, mediaPublished, mediaUses, readMedia, saveMedia, SLUG } from '../../lib/content';

export const prerender = false;

export const POST: APIRoute = async ({ request, url }) => {
  if (!isOwner(request)) return ownerOnly();
  const slug = url.searchParams.get('slug') ?? '';
  if (!SLUG.test(slug)) return json({ error: 'Bad slug.' }, 400);
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_MEDIA) return json({ error: 'That file is over 20 MB.' }, 413);
  const buf = Buffer.from(await request.arrayBuffer());
  if (!buf.length) return json({ error: 'Empty file.' }, 400);
  if (buf.length > MAX_MEDIA) return json({ error: 'That file is over 20 MB.' }, 413);
  try {
    return json(saveMedia(slug, url.searchParams.get('name') ?? 'image', buf));
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Upload failed.' }, (err as { status?: number }).status ?? 500);
  }
};

export const GET: APIRoute = async ({ request, url }) => {
  if (!isOwner(request)) return ownerOnly();
  const slug = url.searchParams.get('slug') ?? '';
  if (!SLUG.test(slug)) return json({ error: 'Bad slug.' }, 400);
  try {
    return json({ files: await listMedia(slug) }, 200, { 'cache-control': 'no-store' });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Could not list media.' }, (err as { status?: number }).status ?? 500);
  }
};

export const DELETE: APIRoute = async ({ request, url }) => {
  if (!isOwner(request)) return ownerOnly();
  if (request.headers.get('origin') !== url.origin || request.headers.get('x-studio-action') !== 'delete-media') {
    return json({ error: 'Forbidden.' }, 403);
  }
  const slug = url.searchParams.get('slug') ?? '';
  const name = url.searchParams.get('name') ?? '';
  if (!SLUG.test(slug)) return json({ error: 'Bad slug.' }, 400);
  if (!MEDIA_FILE.test(name)) return json({ error: 'Bad file name.' }, 400);
  if (!readMedia(slug, name)) return json({ error: 'No such file.' }, 404);
  try {
    if (await mediaPublished(slug, name)) {
      return json({ error: 'This file is already on the live site; deleting it here would not remove it there.', published: true }, 409);
    }
    const uses = mediaUses(mediaPath(slug, name));
    if (uses.length && request.headers.get('x-studio-confirm-uses') !== uses.join(',')) {
      return json({ error: `Still used by: ${uses.join(', ')}`, uses }, 409);
    }
    if (!deleteMedia(slug, name)) return json({ error: 'No such file.' }, 404);
    return json({ deleted: name });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Delete failed.' }, (err as { status?: number }).status ?? 500);
  }
};
