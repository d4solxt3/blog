/** GET → every post and draft: { posts: [{ slug, title, date, draft, unsaved }] } (owner only). */
import type { APIRoute } from 'astro';
import { isOwner, json, ownerOnly } from '../../../lib/auth';
import { editPost, listPosts, publishSaved, removePost, SLUG } from '../../../lib/content';

export const prerender = false;

export const GET: APIRoute = ({ request }) => (isOwner(request) ? json({ posts: listPosts() }) : ownerOnly());

export const POST: APIRoute = async ({ request, url }) => {
  if (!isOwner(request)) return ownerOnly();
  const slug = url.searchParams.get('slug') ?? '';
  if (!SLUG.test(slug)) return json({ error: 'Invalid post.' }, 400);
  const version = request.headers.get('if-match');
  if (!version) return json({ error: 'Refresh the studio before publishing.' }, 428);
  try {
    return json(await editPost(slug, () => publishSaved(slug, version)));
  } catch (error) {
    const status = (error as { status?: number }).status;
    return json({ error: error instanceof Error ? error.message : 'Could not publish this post.' },
      status && [404, 409, 410, 422, 503].includes(status) ? status : 502);
  }
};

export const DELETE: APIRoute = async ({ request, url }) => {
  if (!isOwner(request)) return ownerOnly();
  const slug = url.searchParams.get('slug') ?? '';
  if (!SLUG.test(slug)) return json({ error: 'Invalid post.' }, 400);
  const version = request.headers.get('if-match');
  if (!version) return json({ error: 'Refresh the studio before deleting.' }, 428);
  try {
    return json(await editPost(slug, () => removePost(slug, version)));
  } catch (err) {
    const status = Number((err as { status?: number }).status);
    return json({ error: err instanceof Error ? err.message : 'Could not delete the post.' }, [404, 409, 503].includes(status) ? status : 502);
  }
};
