/** GET → every post and draft: { posts: [{ slug, title, date, draft, unsaved }] } (owner only). */
import type { APIRoute } from 'astro';
import { isOwner, json, ownerOnly } from '../../../lib/auth';
import { listPosts } from '../../../lib/content';

export const prerender = false;

export const GET: APIRoute = ({ request }) => (isOwner(request) ? json({ posts: listPosts() }) : ownerOnly());
