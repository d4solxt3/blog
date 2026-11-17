/**
 * Owner mode for comment moderation. If you're signed in (the site's owner
 * session cookie, set by auth.exe or /moderate/), every comment shows a
 * [ delete ] button. The older COMMENTS_ADMIN_KEY passphrase still works: it's
 * kept in this browser only, and a wrong one signs you out.
 */
const STORAGE_KEY = 'comments-owner-key';
/** Stands in for "use the session cookie" instead of a stored passphrase. */
export const SESSION = 'session';

const hasSession = () => import.meta.env.DEV || document.cookie.split(/;\s*/).includes('residual_owner=1');

export function ownerKey(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {}
  return hasSession() ? SESSION : null;
}

export function setOwnerKey(key: string | null) {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/** Fetch an owner-only endpoint; throws with the server's message on failure. */
export async function ownerFetch(path: string, key: string, init: RequestInit = {}) {
  const auth: Record<string, string> = key && key !== SESSION ? { Authorization: `Bearer ${key}` } : {};
  const res = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...auth, ...(init.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setOwnerKey(null);
    // An expired session: drop the hint so the delete buttons go away.
    if (key === SESSION) document.cookie = `residual_owner=; Max-Age=0; Path=/${location.protocol === 'https:' ? '; Secure' : ''}`;
  }
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Error ${res.status}`), { status: res.status });
  return data;
}

export const deleteComment = (id: string, key: string) =>
  ownerFetch(`/api/comments?id=${encodeURIComponent(id)}`, key, { method: 'DELETE' });

/** Delete a highlighted passage: every reply in its quote thread. */
export const deleteThread = (post: string, anchorId: string, key: string) =>
  ownerFetch(`/api/comments?post=${encodeURIComponent(post)}&anchor=${encodeURIComponent(anchorId)}`, key, {
    method: 'DELETE',
  });
