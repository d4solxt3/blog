/** Owner-only: images uploaded on the live site that aren't part of a deploy yet. */
import type { APIRoute } from 'astro';
import { isOwner } from '../../../../lib/auth';
import { readMedia } from '../../../../lib/content';

export const prerender = false;

export const GET: APIRoute = ({ request, params }) => {
  if (!isOwner(request)) return new Response('Not found', { status: 404 });
  const media = readMedia(params.slug ?? '', params.file ?? '');
  if (!media) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(media.buf), {
    headers: {
      'content-type': media.type,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      // SVGs can carry scripts; never let one run.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
};
