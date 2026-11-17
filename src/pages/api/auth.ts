/**
 * GET    → { owner, configured }            is this browser signed in?
 * POST   { password }                       sign in (sets the session cookie)
 * POST   { action: 'change', current, next } change the password (owner only)
 * DELETE                                    sign out
 */
import type { APIRoute } from 'astro';
import {
  checkPassword,
  clearedCookies,
  DEV,
  isOwner,
  json,
  lockedOut,
  MIN_PASSWORD,
  passwordSource,
  recordFailure,
  sessionCookies,
  setPassword,
} from '../../lib/auth';

export const prerender = false;

const withCookies = (res: Response, cookies: string[]) => {
  for (const c of cookies) res.headers.append('set-cookie', c);
  return res;
};

export const GET: APIRoute = ({ request }) => json({ owner: isOwner(request), configured: DEV || passwordSource() !== 'none' });

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const ip = clientAddress || 'unknown';
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return json({ error: 'Send JSON.' }, 400);

  if (body.action === 'change') {
    if (!isOwner(request)) return json({ error: 'Sign in first.' }, 401);
    const current = typeof body.current === 'string' ? body.current : '';
    const next = typeof body.next === 'string' ? body.next : '';
    if (lockedOut(ip)) return json({ error: 'Too many wrong attempts. Wait 10 minutes.' }, 429);
    if (passwordSource() !== 'none' && !(await checkPassword(current))) {
      recordFailure(ip);
      return json({ error: 'Your current password is wrong.' }, 403);
    }
    if (next.length < MIN_PASSWORD) return json({ error: `Use at least ${MIN_PASSWORD} characters.` }, 400);
    if (next.length > 200) return json({ error: 'That password is too long.' }, 400);
    await setPassword(next);
    // The session key depends on the password, so re-issue this browser's cookie.
    return withCookies(json({ ok: true }), sessionCookies(request));
  }

  const password = typeof body.password === 'string' ? body.password : '';
  if (DEV) return withCookies(json({ ok: true }), sessionCookies(request));
  if (passwordSource() === 'none') return json({ error: 'No password is set yet. Add ADMIN_PASSWORD on your host.' }, 503);
  if (lockedOut(ip)) return json({ error: 'Too many wrong attempts. Wait 10 minutes.' }, 429);
  if (!(await checkPassword(password))) {
    recordFailure(ip);
    return json({ error: 'Wrong password.' }, 401);
  }
  return withCookies(json({ ok: true }), sessionCookies(request));
};

export const DELETE: APIRoute = ({ request }) => withCookies(json({ ok: true }), clearedCookies(request));
