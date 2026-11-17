/** /moderate/: sign in with the owner passphrase, list recent comments, delete them. */
import { deleteComment, deleteThread, ownerFetch, ownerKey, SESSION, setOwnerKey } from './owner';

type Comment = {
  id: string;
  post: string;
  name: string;
  body: string;
  createdAt: string;
  anchor: { id: string; exact: string } | null;
};

const pad = (n: number) => String(n).padStart(2, '0');
const formatTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function initModerate(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>('[data-moderate]');
  if (!root) return;
  const signin = root.querySelector<HTMLFormElement>('[data-signin]')!;
  const status = signin.querySelector<HTMLElement>('[data-status]')!;
  const inbox = root.querySelector<HTMLElement>('[data-inbox]')!;
  const list = root.querySelector<HTMLOListElement>('[data-list]')!;
  const count = root.querySelector<HTMLElement>('[data-count]')!;
  const empty = root.querySelector<HTMLElement>('[data-empty]')!;
  const titles: Record<string, string> = JSON.parse(root.dataset.titles ?? '{}');

  let comments: Comment[] = [];

  function item(c: Comment) {
    const li = document.createElement('li');
    li.className = 'cm-item';
    const head = document.createElement('div');
    head.className = 'cm-head';
    const name = document.createElement('span');
    name.className = 'cm-name';
    name.textContent = c.name || 'anon';
    const time = document.createElement('time');
    time.dateTime = c.createdAt;
    time.textContent = formatTime(c.createdAt);
    const on = document.createElement('a');
    on.className = 'mod-post';
    on.href = `/posts/${c.post}/#c-${c.id}`;
    on.textContent = `on ${titles[c.post] ?? c.post}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'cm-del';
    del.dataset.del = c.id;
    del.textContent = '[ delete ]';
    del.setAttribute('aria-label', `Delete comment by ${c.name || 'anon'}`);
    head.append(name, time, on, del);
    li.append(head);
    if (c.anchor) {
      const q = document.createElement('p');
      q.className = 'cm-quote';
      q.textContent = `“${truncate(c.anchor.exact, 160)}”`;
      const n = comments.filter((x) => x.post === c.post && x.anchor?.id === c.anchor!.id).length;
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'cm-del mod-thread';
      t.dataset.delThread = c.id;
      t.textContent = n > 1 ? `[ delete highlight + ${n} replies ]` : '[ delete highlight ]';
      q.append(t);
      li.append(q);
    }
    const body = document.createElement('p');
    body.className = 'cm-body';
    body.textContent = c.body;
    li.append(body);
    return li;
  }

  function render() {
    list.replaceChildren(...comments.map(item));
    count.textContent = `${pad(comments.length)} ${comments.length === 1 ? 'comment' : 'comments'}`;
    empty.hidden = comments.length > 0;
  }

  function showSignin(message = '') {
    inbox.hidden = true;
    signin.hidden = false;
    status.textContent = message;
    signin.querySelector<HTMLInputElement>('input')?.focus();
  }

  async function open(key: string) {
    const data = await ownerFetch('/api/comments?recent=1', key);
    comments = data.comments ?? [];
    if (key !== SESSION) setOwnerKey(key);
    signin.hidden = true;
    inbox.hidden = false;
    render();
  }

  signin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = signin.querySelector<HTMLInputElement>('input')!;
    const key = input.value.trim();
    if (!key) return;
    const button = signin.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    status.textContent = 'checking…';
    try {
      // Your admin password signs this browser in (session cookie, nothing stored);
      // anything else is tried as the older COMMENTS_ADMIN_KEY passphrase.
      const login = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ password: key }),
      }).catch(() => null);
      await open(login?.ok ? SESSION : key);
      input.value = '';
      status.textContent = '';
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : 'could not sign in';
    } finally {
      button.disabled = false;
    }
  });

  root.querySelector('[data-signout]')?.addEventListener('click', () => {
    setOwnerKey(null);
    fetch('/api/auth', { method: 'DELETE' }).catch(() => {});
    try {
      sessionStorage.removeItem('owner-verified');
    } catch {}
    comments = [];
    list.replaceChildren();
    showSignin('signed out on this browser');
  });

  // Delete a highlighted passage: every reply in that quote thread.
  list.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-del-thread]');
    const c = btn && comments.find((x) => x.id === btn.dataset.delThread);
    const anchor = c?.anchor;
    const key = ownerKey();
    if (!btn || !c || !anchor) return;
    if (!key) return showSignin('sign in again');
    const n = comments.filter((x) => x.post === c.post && x.anchor?.id === anchor.id).length;
    const what = n === 1 ? 'its 1 reply' : `all ${n} replies`;
    if (!window.confirm(`Delete this highlight and ${what}?\n\n> "${truncate(anchor.exact, 140)}"\n\nThis can't be undone.`)) return;
    btn.disabled = true;
    btn.textContent = '[ deleting… ]';
    try {
      await deleteThread(c.post, anchor.id, key);
    } catch (err) {
      const code = (err as { status?: number }).status;
      if (code === 401) return showSignin('wrong or changed password. sign in again.');
      if (code !== 404) {
        window.alert(err instanceof Error ? err.message : 'Could not delete the thread.');
        return render();
      }
    }
    comments = comments.filter((x) => !(x.post === c.post && x.anchor?.id === anchor.id));
    render();
  });

  list.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-del]');
    const c = btn && comments.find((x) => x.id === btn.dataset.del);
    const key = ownerKey();
    if (!btn || !c) return;
    if (!key) return showSignin('sign in again');
    if (!window.confirm(`Delete this comment by ${c.name || 'anon'}?\n\n"${truncate(c.body, 140)}"\n\nThis can't be undone.`)) return;
    btn.disabled = true;
    btn.textContent = '[ deleting… ]';
    try {
      await deleteComment(c.id, key);
    } catch (err) {
      const code = (err as { status?: number }).status;
      if (code === 401) return showSignin('wrong or changed password. sign in again.');
      if (code !== 404) {
        window.alert(err instanceof Error ? err.message : 'Could not delete the comment.');
        btn.disabled = false;
        btn.textContent = '[ delete ]';
        return;
      }
    }
    comments = comments.filter((x) => x.id !== c.id);
    render();
  });

  if (signal.aborted) return;
  const saved = ownerKey();
  if (!saved) return showSignin();
  open(saved).catch((err) => {
    const code = (err as { status?: number }).status;
    showSignin(code === 401 ? '' : err instanceof Error ? err.message : 'could not load comments');
  });
}
