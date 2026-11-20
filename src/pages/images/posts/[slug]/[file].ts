import type { APIRoute } from 'astro';
import { isRetiredLocally } from '../../../../../scripts/post-template.mjs';
import { MEDIA_FILE, readMedia, SLUG } from '../../../../lib/content';
import { getLivePost } from '../../../../lib/live-posts';
import { retiredOnServer } from '../../../../lib/retired-posts';

export const prerender = false;

const notFound = () => new Response('Not found', {
  status: 404,
  headers: { 'cache-control': 'no-store' },
});

export const GET: APIRoute = ({ params }) => {
  const { slug = '', file = '' } = params;
  if (!SLUG.test(slug) || !MEDIA_FILE.test(file)) return notFound();
  if (isRetiredLocally(slug) || retiredOnServer(slug)) return notFound();

  const post = getLivePost(slug);
  if (!post || post.doc.fields.draft || !post.media.includes(file)) return notFound();

  const media = readMedia(slug, file);
  if (!media) return notFound();
  return new Response(new Uint8Array(media.buf), {
    headers: {
      'content-type': media.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
};
