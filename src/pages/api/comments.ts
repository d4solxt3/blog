/**
 * GET  /api/comments?post=<slug>   → { comments: [...] }   (oldest first)
 * GET  /api/comments?counts=1      → { "<slug>": n, ... }
 * POST /api/comments               → { comment }           JSON body:
 *      { post, name?, body, anchor?: { id?, exact, prefix, suffix, blockIndex }, website (honeypot), elapsed }
 *
 * Owner only (signed-in session, or `Authorization: Bearer <admin password or COMMENTS_ADMIN_KEY>`):
 * GET    /api/comments?recent=1     → { comments: [...] }   (newest first, every post)
 * DELETE /api/comments?id=<id>      → { ok: true }
 * DELETE /api/comments?post=<slug>&anchor=<anchorId>
 *                                   → { ok: true, removed }  (a whole quote thread)
 *
 * Runs on the server (not pre-built), so it needs the Node adapter at deploy time.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { checkPassword, isOwner, passwordSource } from '../../lib/auth';
import { getStore, type Anchor, type CommentRecord } from '../../lib/comment-store';
import { SITE } from '../../site.config';

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

// Basic rate limit: 5 posts per IP per 10 minutes (in memory, per server process).
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const recent = new Map<string, number[]>();
function rateLimited(ip: string) {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    recent.set(ip, hits);
    return true;
  }
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 5000) recent.clear();
  return false;
}

/* Owner check for moderation: a signed-in owner session (see lib/auth.ts), or
 * `Authorization: Bearer <password>` with your admin password or the older
 * COMMENTS_ADMIN_KEY. Under `npm run dev` it's always open. 10 wrong guesses
 * per IP per 10 minutes locks that IP out for the rest of the window. */
const failures = new Map<string, number[]>();
const digest = (s: string) => createHash('sha256').update(s).digest();

async function ownerError(request: Request, ip: string): Promise<Response | null> {
  if (isOwner(request)) return null;
  const key = process.env.COMMENTS_ADMIN_KEY?.trim() || '';
  if (!key && passwordSource() === 'none') {
    return json({ error: 'Moderation is off. Set ADMIN_PASSWORD on your host first.' }, 403);
  }
  const now = Date.now();
  const fails = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (fails.length >= 10) return json({ error: 'Too many wrong passwords. Try again in 10 minutes.' }, 429);
  const given = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (given && ((key && timingSafeEqual(digest(given), digest(key))) || (await checkPassword(given)))) return null;
  fails.push(now);
  failures.set(ip, fails);
  if (failures.size > 5000) failures.clear();
  return json({ error: 'Wrong password.' }, 401);
}

const clean = (v: unknown, max: number) =>
  String(v ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

async function postRules() {
  const posts = await getCollection('posts', ({ data }) => import.meta.env.DEV || !data.draft);
  return new Map(posts.map((p) => [p.id, { annotations: p.data.annotations !== false }]));
}

export const GET: APIRoute = async ({ url, request, clientAddress }) => {
  if (url.searchParams.has('recent')) {
    const denied = await ownerError(request, clientAddress || 'unknown');
    if (denied) return denied;
  }
  try {
    const store = getStore();
    if (url.searchParams.has('recent')) return json({ comments: await store.recent(300) });
    if (url.searchParams.has('counts')) return json(await store.counts());
    const post = url.searchParams.get('post') ?? '';
    if (!post) return json({ error: 'Missing ?post=' }, 400);
    return json({ comments: await store.list(post) });
  } catch (err) {
    console.error('[comments] read failed:', err);
    return json({ error: 'Comments are unavailable right now.' }, 503);
  }
};

export const POST: APIRoute = async ({ request, clientAddress }) => {
  let data: Record<string, any>;
  try {
    data = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  // Spam traps: hidden honeypot field + a minimum time spent on the form.
  if (data.website) return json({ error: 'Rejected.' }, 400);
  if (typeof data.elapsed === 'number' && data.elapsed < 2500) {
    return json({ error: 'That was quick — give it a few seconds and try again.' }, 400);
  }

  const rules = await postRules();
  const post = clean(data.post, 120);
  const rule = rules.get(post);
  if (!rule) return json({ error: 'Unknown post.' }, 404);

  const body = clean(data.body, 3000);
  if (body.length < 2) return json({ error: 'Write a comment first.' }, 400);
  const name = clean(data.name, 40) || 'anon';

  let anchor: Anchor | null = null;
  if (data.anchor) {
    if (!SITE.inlineAnnotations || !rule.annotations) return json({ error: 'Quote comments are off for this post.' }, 403);
    const exact = clean(data.anchor.exact, 600);
    if (exact.length < 3) return json({ error: 'Highlight a longer passage.' }, 400);
    anchor = {
      id: /^[a-z0-9-]{8,40}$/i.test(String(data.anchor.id ?? '')) ? String(data.anchor.id) : crypto.randomUUID(),
      exact,
      prefix: clean(data.anchor.prefix, 64),
      suffix: clean(data.anchor.suffix, 64),
      blockIndex: Math.max(0, Math.min(100_000, Math.trunc(Number(data.anchor.blockIndex) || 0))),
    };
  }

  if (rateLimited(clientAddress || 'unknown')) {
    return json({ error: 'Too many comments from you in a short time. Try again in a few minutes.' }, 429);
  }

  const comment: CommentRecord = {
    id: crypto.randomUUID(),
    post,
    name,
    body,
    createdAt: new Date().toISOString(),
    anchor,
  };

  try {
    await getStore().add(comment);
    return json({ comment }, 201);
  } catch (err) {
    console.error('[comments] write failed:', err);
    return json({ error: 'Could not save your comment. Try again later.' }, 503);
  }
};

export const DELETE: APIRoute = async ({ url, request, clientAddress }) => {
  const denied = await ownerError(request, clientAddress || 'unknown');
  if (denied) return denied;
  const anchorId = url.searchParams.get('anchor');
  const post = clean(url.searchParams.get('post'), 120);
  const id = url.searchParams.get('id') ?? '';
  if (anchorId !== null ? !post || !/^[a-z0-9-]{8,40}$/i.test(anchorId) : !/^[a-z0-9-]{8,64}$/i.test(id)) {
    return json({ error: 'Pass ?id=<comment> or ?post=<slug>&anchor=<thread>.' }, 400);
  }
  try {
    if (anchorId !== null) {
      const removed = await getStore().removeThread(post, anchorId);
      if (!removed) return json({ error: 'That quote thread no longer exists.' }, 404);
      return json({ ok: true, removed });
    }
    if (!(await getStore().remove(id))) return json({ error: 'That comment no longer exists.' }, 404);
    return json({ ok: true });
  } catch (err) {
    console.error('[comments] delete failed:', err);
    return json({ error: 'Could not delete the comment. Try again later.' }, 503);
  }
};
