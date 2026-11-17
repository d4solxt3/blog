/**
 * Post-page behaviour: 1px reading progress, ToC active-section tracking,
 * hover previews and copy-code buttons. Called on every page load; all
 * window/document listeners use `signal` so they're dropped on navigation.
 */
import { initPreviews } from './previews';

export function initPostPage(signal: AbortSignal) {
  const body = document.querySelector<HTMLElement>('[data-post-body]');
  if (!body) return;
  const bar = document.querySelector<HTMLElement>('[data-progress]');
  const headings = Array.from(document.querySelectorAll<HTMLElement>('.prose h2[id]:not(.sr-only), .prose h3[id]'));
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-toc-link]'));
  const drawer = document.querySelector<HTMLDetailsElement>('[data-toc-drawer]');

  let activeId: string | null = null;
  let queued = false;

  function setActive(id: string | null) {
    if (id === activeId) return;
    activeId = id;
    for (const link of links) {
      if (id !== null && link.hash === `#${id}`) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
      link.removeAttribute('data-parent-active');
    }
    for (const link of links) {
      if (!link.hasAttribute('aria-current')) continue;
      link.closest('ol')?.closest('li')?.querySelector<HTMLAnchorElement>(':scope > a')?.setAttribute('data-parent-active', '');
    }
  }

  function update() {
    queued = false;
    if (bar && body) {
      const rect = body.getBoundingClientRect();
      const travel = rect.height - window.innerHeight;
      const progress = travel > 0 ? -rect.top / travel : rect.top < 0 ? 1 : 0;
      bar.style.transform = `scaleX(${Math.min(1, Math.max(0, progress))})`;
    }
    let current: string | null = null;
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= 140) current = h.id;
      else break;
    }
    setActive(current);
  }

  const queue = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  };
  window.addEventListener('scroll', queue, { passive: true, signal });
  window.addEventListener('resize', queue, { signal });
  update();

  drawer?.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => (drawer.open = false)));

  initPreviews(body, signal);

  document.querySelectorAll<HTMLElement>('.prose .code-frame').forEach((frame) => {
    const label = frame.querySelector('.code-label');
    const pre = frame.querySelector('pre');
    if (!label || !pre || label.querySelector('.copy-code')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-code';
    btn.textContent = '[copy]';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText);
        btn.textContent = '[copied ✓]';
      } catch {
        btn.textContent = '[press ctrl+c]';
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      window.setTimeout(() => (btn.textContent = '[copy]'), 1600);
    });
    label.append(btn);
  });
}
