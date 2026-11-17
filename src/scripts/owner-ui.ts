/**
 * Hidden owner entry points. Nothing here is visible to visitors.
 *  - Ctrl/Cmd + Shift + E anywhere, or triple-clicking the footer year:
 *    opens the auth.exe password box (or goes to /write if signed in).
 *  - "e" on a post page (signed in): edit that post.
 *  - Signed in: small [+ write] [edit] [config] links in the window bar.
 * The residual_owner cookie only hints that a session might exist; the
 * server confirms it once per tab before any link appears.
 */
import { navigate } from 'astro:transitions/client';
import { onPage } from './lifecycle';

const DEV = import.meta.env.DEV;
const VERIFIED = 'owner-verified';

const hasHint = () => DEV || document.cookie.split(/;\s*/).includes('residual_owner=1');
const postSlug = () => location.pathname.match(/^\/posts\/([a-z0-9-]+)\/?$/)?.[1] ?? null;
const safeNext = (n: string | null) => (n && /^\/write(\/[a-z0-9-]*)*\/?$/.test(n) ? n : '/write/');

let pending: Promise<boolean> | null = null;

export function ownerStatus(): Promise<boolean> {
  if (DEV) return Promise.resolve(true);
  if (!hasHint()) return Promise.resolve(false);
  try {
    if (sessionStorage.getItem(VERIFIED) === '1') return Promise.resolve(true);
  } catch {}
  pending ??= fetch('/api/auth', { headers: { accept: 'application/json' } })
    .then((r) => r.json())
    .then((d) => !!d.owner)
    .catch(() => false)
    .then((ok) => {
      try {
        if (ok) sessionStorage.setItem(VERIFIED, '1');
        else sessionStorage.removeItem(VERIFIED);
      } catch {}
      if (!ok) document.cookie = `residual_owner=; Max-Age=0; Path=/${location.protocol === 'https:' ? '; Secure' : ''}`;
      pending = null;
      return ok;
    });
  return pending;
}

export function forgetOwner() {
  try {
    sessionStorage.removeItem(VERIFIED);
  } catch {}
}

async function enter(next = '/write/') {
  if (await ownerStatus()) navigate(next);
  else openAuth(next);
}

// ---- auth.exe -----------------------------------------------------------

let modal: HTMLElement | null = null;

function closeAuth() {
  modal?.remove();
  modal = null;
}

function openAuth(next: string) {
  if (modal) return modal.querySelector('input')?.focus();
  const opener = document.activeElement as HTMLElement | null;
  modal = document.createElement('div');
  modal.className = 'auth-scrim';
  modal.innerHTML = `
    <form class="win auth-win" role="dialog" aria-modal="true" aria-labelledby="auth-title" novalidate>
      <div class="win-bar">
        <span class="win-title" id="auth-title">auth.exe</span>
        <button type="button" class="ctl ctl-close" data-auth-close aria-label="Close">×</button>
      </div>
      <div class="auth-body">
        <label class="auth-label" for="auth-pw">password</label>
        <input id="auth-pw" name="password" type="password" autocomplete="current-password" spellcheck="false" required />
        <div class="auth-row">
          <span class="auth-status" aria-live="polite"></span>
          <button type="submit" class="cm-submit">[ enter ]</button>
        </div>
      </div>
    </form>`;
  document.body.append(modal);
  const form = modal.querySelector('form')!;
  const input = form.querySelector('input')!;
  const status = form.querySelector<HTMLElement>('.auth-status')!;
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const close = () => {
    closeAuth();
    opener?.focus?.();
  };
  input.focus();
  modal.addEventListener('mousedown', (e) => e.target === modal && close());
  form.querySelector('[data-auth-close]')!.addEventListener('click', close);
  form.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) return input.focus();
    button.disabled = true;
    status.textContent = 'checking…';
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ password: input.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not sign in.');
      try {
        sessionStorage.setItem(VERIFIED, '1');
      } catch {}
      closeAuth();
      navigate(next);
    } catch (err) {
      status.textContent = err instanceof Error ? err.message.toLowerCase() : 'could not sign in.';
      input.select();
    } finally {
      button.disabled = false;
    }
  });
}

// ---- keyboard ------------------------------------------------------------

const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    enter();
    return;
  }
  if (e.key === 'e' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !typing(e.target) && !modal) {
    const slug = postSlug();
    if (!slug) return;
    ownerStatus().then((ok) => ok && navigate(`/write/${slug}`));
  }
});

// ---- per page: footer year, owner links, ?auth=1 -------------------------

onPage((signal) => {
  closeAuth();
  document.querySelector('[data-owner-year]')?.addEventListener(
    'click',
    (e) => {
      if ((e as MouseEvent).detail === 3) {
        window.getSelection()?.removeAllRanges();
        enter();
      }
    },
    { signal },
  );

  const params = new URLSearchParams(location.search);
  if (params.has('auth')) {
    const next = safeNext(params.get('next'));
    params.delete('auth');
    params.delete('next');
    const qs = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
    enter(next);
  }

  ownerStatus().then((ok) => {
    const bar = document.querySelector('.titlebar .bar-right');
    if (!ok || !bar || signal.aborted || bar.querySelector('.owner-links')) return;
    const slug = postSlug();
    const links = document.createElement('span');
    links.className = 'owner-links';
    const add = (href: string, label: string, reload = false) => {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      if (reload) a.dataset.astroReload = '';
      links.append(a);
    };
    add('/write/', '[+ write]');
    if (slug) add(`/write/${slug}`, '[edit]');
    if (DEV) add('/_admin', '[config]', true);
    else add('/write/settings/', '[config]');
    bar.prepend(links);
  });
});
