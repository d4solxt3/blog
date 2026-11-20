/** GET → { ok, message, head? }: can the live studio publish? Read-only check (owner only). */
import type { APIRoute } from 'astro';
import { isOwner, json, ownerOnly } from '../../../lib/auth';
import { checkPublishing } from '../../../lib/content';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => (isOwner(request) ? json(await checkPublishing()) : ownerOnly());
