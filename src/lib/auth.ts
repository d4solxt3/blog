/**
 * Owner sign-in for the writing studio (/write), settings and moderation.
 *
 * The password is, in order:
 *   1. the one you set on /write/settings (stored as a scrypt hash on the
 *      server's persistent disk, next to the comments file), else
 *   2. the ADMIN_PASSWORD environment variable, else
 *   3. COMMENTS_ADMIN_KEY (so an existing moderation passphrase still works).
 * Forgot the one you set on the site? Change ADMIN_PASSWORD on your host: a
 * new value always takes over again.
 *
 * Signing in sets a 30-day HttpOnly session cookie, signed with a key derived
 * from the current password: changing the password signs every browser out.
 * A second, non-secret cookie (residual_owner=1) only tells the page's script
 * to check for owner links; it grants nothing by itself.
 * While running `npm run dev`, every request counts as the owner.
 */
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const DATA_DIR = resolve(process.env.DATA_DIR || dirname(process.env.COMMENTS_JSON_PATH || 'data/comments.json'));
const PASSWORD_FILE = join(DATA_DIR, 'admin-password.json');
const SECRET_FILE = join(DATA_DIR, 'session-secret');
export const SESSION_COOKIE = 'residual_admin';
export const HINT_COOKIE = 'residual_owner';
const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;
export const DEV = import.meta.env.DEV;

const scrypt = (pw: string, salt: Buffer) =>
  new Promise<Buffer>((ok, fail) => scryptCb(pw, salt, 32, (err, key) => (err ? fail(err) : ok(key))));
const sha = (s: string) => createHash('sha256').update(s).digest();

/** `env` = fingerprint of ADMIN_PASSWORD when this was saved. */
type Stored = { salt: string; hash: string; changedAt: string; env: string };

const envPassword = () => process.env.ADMIN_PASSWORD || process.env.COMMENTS_ADMIN_KEY || '';
const envFingerprint = () => createHash('sha256').update(`env:${envPassword()}`).digest('hex');

/** The password set on the site, unless ADMIN_PASSWORD has changed since (that's the reset). */
function readStored(): Stored | null {
  try {
    const s = JSON.parse(readFileSync(PASSWORD_FILE, 'utf8'));
    if (typeof s?.salt === 'string' && typeof s?.hash === 'string' && s.env === envFingerprint()) return s;
  } catch {}
  return null;
}

/** Where the current password comes from (shown on /write/settings). */
export function passwordSource(): 'site' | 'env' | 'none' {
  if (readStored()) return 'site';
  return envPassword() ? 'env' : 'none';
}

export function passwordChangedAt(): string | null {
  return readStored()?.changedAt ?? null;
}

export async function checkPassword(pw: string): Promise<boolean> {
  if (!pw) return false;
  const stored = readStored();
  if (stored) {
    const got = await scrypt(pw, Buffer.from(stored.salt, 'hex'));
    const want = Buffer.from(stored.hash, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }
  const env = envPassword();
  return !!env && timingSafeEqual(sha(pw), sha(env));
}

/** Store a new password (hashed) on the server's disk. It replaces ADMIN_PASSWORD. */
export async function setPassword(pw: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt);
  const record: Stored = { salt: salt.toString('hex'), hash: hash.toString('hex'), changedAt: new Date().toISOString(), env: envFingerprint() };
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${PASSWORD_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, PASSWORD_FILE);
}

let secret: Buffer | null = null;
function serverSecret(): Buffer {
  if (process.env.SESSION_SECRET) return sha(process.env.SESSION_SECRET);
  if (secret) return secret;
  try {
    secret = Buffer.from(readFileSync(SECRET_FILE, 'utf8').trim(), 'hex');
    if (secret.length === 32) return secret;
  } catch {}
  secret = randomBytes(32);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SECRET_FILE, secret.toString('hex'), { mode: 0o600 });
  } catch {}
  return secret;
}

function sign(payload: string): string | null {
  const stored = readStored();
  const basis = stored ? `site:${stored.hash}` : envPassword() ? `env:${sha(envPassword()).toString('hex')}` : '';
  if (!basis) return null;
  const key = createHmac('sha256', serverSecret()).update(basis).digest();
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) {
      try {
        return decodeURIComponent(part.slice(i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** True for a valid owner session (always true while running `npm run dev`). */
export function isOwner(request: Request): boolean {
  if (DEV) return true;
  const m = (readCookie(request, SESSION_COOKIE) ?? '').match(/^(v1\.(\d{10,16}))\.([\w-]{20,})$/);
  if (!m || Number(m[2]) < Date.now()) return false;
  const want = sign(m[1]);
  if (!want) return false;
  const a = Buffer.from(m[3]);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const isSecure = (request: Request) => {
  const url = new URL(request.url);
  return url.protocol === 'https:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
};

/** Set-Cookie values that sign this browser in for 30 days. */
export function sessionCookies(request: Request): string[] {
  const payload = `v1.${Date.now() + SESSION_DAYS * 864e5}`;
  const token = `${payload}.${sign(payload)}`;
  const flags = `Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax${isSecure(request) ? '; Secure' : ''}`;
  return [`${SESSION_COOKIE}=${token}; HttpOnly; ${flags}`, `${HINT_COOKIE}=1; ${flags}`];
}

export function clearedCookies(request: Request): string[] {
  const flags = `Path=/; Max-Age=0; SameSite=Lax${isSecure(request) ? '; Secure' : ''}`;
  return [`${SESSION_COOKIE}=; HttpOnly; ${flags}`, `${HINT_COOKIE}=; ${flags}`];
}

// Failed sign-ins: 10 per IP per 10 minutes, then that IP waits.
const failures = new Map<string, { count: number; reset: number }>();
export function lockedOut(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.reset > Date.now() && f.count >= 10;
}
export function recordFailure(ip: string) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.reset < now) failures.set(ip, { count: 1, reset: now + 10 * 60_000 });
  else f.count += 1;
  if (failures.size > 5000) for (const [k, v] of failures) if (v.reset < now) failures.delete(k);
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const ownerOnly = () => json({ error: 'Sign in first.' }, 401);
