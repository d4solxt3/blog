/**
 * Owner mode for comment moderation. Signing in on /moderate/ stores your
 * passphrase (COMMENTS_ADMIN_KEY) in this browser only; while it's there,
 * every comment shows a [ delete ] button. A wrong passphrase signs you out.
 */
const STORAGE_KEY = 'comments-owner-key';

export function ownerKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function setOwnerKey(key: string | null) {
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/** Fetch an owner-only endpoint; throws with the server's message on failure. */
export async function ownerFetch(path: string, key: string, init: RequestInit = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', Authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) setOwnerKey(null);
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
