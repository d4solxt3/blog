/**
 * POST /api/upload-media?slug=<post>&name=<file name>  (body: the image bytes)
 * → { path, src }: `path` goes in the Markdown, `src` works right away in the editor.
 * Owner only. png, jpg, gif (animation kept), webp and svg, up to 20 MB.
 */
import type { APIRoute } from 'astro';
import { isOwner, json, ownerOnly } from '../../lib/auth';
import { MAX_MEDIA, saveMedia, SLUG } from '../../lib/content';

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
