/** POST { slug, body } → { html } rendered with the site's Markdown pipeline (owner only). */
import type { APIRoute } from 'astro';
import { renderPreview } from '../../../../plugins/preview.mjs';
import { DEV, isOwner, json, ownerOnly } from '../../../lib/auth';
import { readMedia, SLUG } from '../../../lib/content';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!isOwner(request)) return ownerOnly();
  const body = (await request.json().catch(() => null)) as { slug?: unknown; body?: unknown } | null;
  const src = typeof body?.body === 'string' ? body.body.slice(0, 2_000_000) : '';
  const slug = typeof body?.slug === 'string' && SLUG.test(body.slug) ? body.slug : '';
  let html = await renderPreview(src);
  // On the live site, images uploaded since the last deploy are served from the server's disk.
  if (!DEV && slug) {
    html = html.replace(/(src=")\/images\/posts\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]*\.(?:png|jpg|gif|webp|svg))"/g, (m, pre, s, file) =>
      s === slug && readMedia(s, file) ? `${pre}/api/media/${s}/${file}"` : m,
    );
  }
  return json({ html });
};
