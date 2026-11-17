/** POST { title } → starts a new draft and returns its slug (owner only). */
import type { APIRoute } from 'astro';
import { slugify } from '../../../../scripts/post-template.mjs';
import { isOwner, json, ownerOnly } from '../../../lib/auth';
import { newDoc, readDraft, readPublished, saveDraft } from '../../../lib/content';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!isOwner(request)) return ownerOnly();
  const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 300) : '';
  if (!title) return json({ error: 'Type a title first.' }, 400);
  const base = slugify(title);
  try {
    let slug = base;
    for (let n = 2; readDraft(slug) || (await readPublished(slug)); n += 1) slug = `${base.slice(0, 74)}-${n}`;
    saveDraft({ ...newDoc(slug, title), basis: null });
    return json({ slug });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Could not start the post.' }, 502);
  }
};
