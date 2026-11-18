/**
 * Post-page behaviour: 1px reading progress, ToC active-section tracking,
 * hover previews and copy-code buttons. Called on every page load; all
 * window/document listeners use `signal` so they're dropped on navigation.
 */
import { initPreviews } from './previews';

export function initPostPage(signal: AbortSignal) {
  const body = document.querySelector<HTMLElement>('[data-post-body]');
  if (!body) return;

  // Contents column (wide screens): it shows as the post arrives, then tucks
  // itself away about a second later, before reading starts, and the text
  // glides to the centre. It stays if the reader reaches for it (hover, focus).
  // [ hide × ] and [ contents + ] switch it by hand for this page.
  const article = body.closest<HTMLElement>('.post');
  // --col: the usual 65ch measure; --col-wide: ~80ch, used when the contents
  // column is off so the text spreads into the freed space.
  const measure = () => {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
    body.append(probe);
    probe.textContent = '0'.repeat(65);
    article?.style.setProperty('--col', `${Math.ceil(probe.getBoundingClientRect().width)}px`);
    probe.textContent = '0'.repeat(80);
    article?.style.setProperty('--col-wide', `${Math.ceil(probe.getBoundingClientRect().width)}px`);
    probe.remove();
  };
  measure();
  // The reading font can change ([Aa]) — keep the measure in step.
  const fontWatch = new MutationObserver(measure);
  fontWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-font'] });
  signal.addEventListener('abort', () => fontWatch.disconnect());

  // DEV ONLY, while choosing the look — how the text answers the column going:
  //   widen: centres and widens to ~80ch (lines re-wrap once, then glide)
  //   glide: keeps its 65ch lines and glides to the centre (wider margins)
  // Picked with the little switcher at the bottom-left of post pages in dev.
  const DEV = import.meta.env.DEV;
  let fx = 'widen';
  if (DEV) {
    try {
      fx = sessionStorage.getItem('tocfx') || 'widen';
    } catch {}
    document.documentElement.dataset.tocfx = fx;
  }

  const side = document.querySelector<HTMLElement>('.post-side');
  const sidebar = side?.querySelector<HTMLElement>('.toc-sidebar') ?? null;
  const hasToc = !!sidebar;
  const head = document.querySelector<HTMLElement>('.post-head');
  const main = document.querySelector<HTMLElement>('.post-main');
  const ease = 'cubic-bezier(0.22, 0.7, 0.2, 1)';

  // Mid-article, the paragraph being read stays put on screen when the text
  // re-flows. Near the top the scroll is left alone.
  const readingAnchor = () => {
    if (!head || head.getBoundingClientRect().bottom > 0) return null;
    for (const el of body.querySelectorAll<HTMLElement>(':scope > *')) if (el.getBoundingClientRect().bottom > 60) return el;
    return null;
  };

  /**
   * Switch the contents column. Only the column itself fades (and drifts a few
   * px right); the text never disappears — it glides from where it was to its
   * new place (measured before/after, then animated back to zero). `gentle`
   * (the automatic close) is a touch slower than a click.
   */
  let running: Animation[] = [];
  let pendingSwap = 0;
  const stop = () => {
    window.clearTimeout(pendingSwap);
    running.forEach((a) => a.cancel());
    running = [];
  };
  signal.addEventListener('abort', stop);

  function setToc(next: 'shown' | 'hidden', then?: () => void, gentle = false) {
    const root = document.documentElement;
    stop();
    if (root.dataset.toc === next) return then?.();
    const animate = !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const glideMs = gentle ? 540 : 400;
    const fadeMs = gentle ? 210 : 160;

    const swap = () => {
      const movers = [head, main].filter((el): el is HTMLElement => !!el);
      const before = movers.map((el) => el.getBoundingClientRect());
      const anchor = readingAnchor();
      const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
      running.forEach((a) => a.cancel()); // the column's fade-out has done its job
      running = [];
      root.dataset.toc = next;
      const shift = anchor ? anchor.getBoundingClientRect().top - anchorTop : 0;
      if (Math.abs(shift) > 1) window.scrollBy({ top: shift, behavior: 'instant' as ScrollBehavior });
      if (animate) {
        movers.forEach((el, i) => {
          const now = el.getBoundingClientRect();
          const dx = before[i].left - now.left;
          const dy = before[i].top - now.top;
          if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
          running.push(el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: glideMs, easing: ease }));
        });
        if (next === 'shown' && sidebar) {
          running.push(
            sidebar.animate([{ opacity: 0, transform: 'translateX(10px)' }, { opacity: 1, transform: 'none' }], {
              duration: 260,
              delay: glideMs * 0.45,
              easing: ease,
              fill: 'backwards',
            }),
          );
        }
      }
      then?.();
    };

    if (animate && next === 'hidden' && sidebar) {
      running.push(sidebar.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(10px)' }], { duration: fadeMs, easing: 'ease-in', fill: 'forwards' }));
      pendingSwap = window.setTimeout(swap, fadeMs);
    } else swap();
  }

  let autoClose = 0;
  const keepOpen = () => window.clearTimeout(autoClose);
  if (hasToc && document.documentElement.dataset.toc === 'shown' && window.matchMedia('(min-width: 1060px)').matches) {
    autoClose = window.setTimeout(() => setToc('hidden', undefined, true), 1000);
    side!.addEventListener('pointerenter', keepOpen, { signal });
    side!.addEventListener('focusin', keepOpen, { signal });
    signal.addEventListener('abort', keepOpen);
  }

  document.querySelectorAll<HTMLButtonElement>('[data-toc-toggle]').forEach((btn) =>
    btn.addEventListener(
      'click',
      () => {
        keepOpen();
        const next = btn.dataset.tocToggle === 'hidden' ? 'hidden' : 'shown';
        // Keep keyboard focus on the control that undoes it.
        setToc(next, () =>
          document.querySelector<HTMLButtonElement>(`[data-toc-toggle="${next === 'hidden' ? 'shown' : 'hidden'}"]`)?.focus({ preventScroll: true }),
        );
      },
      { signal },
    ),
  );

  // DEV ONLY comparison switcher (bottom-left). Picking a style reloads the post
  // so the arrival → tuck-away plays again. Remove once a style is chosen.
  if (DEV && hasToc) {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:60;display:flex;align-items:center;gap:6px;padding:6px 8px;' +
      'font:11px/1 var(--font-mono);color:var(--ink);background:var(--surface-raised);border:1px solid var(--line);box-shadow:0 2px 8px rgb(0 0 0/.15);';
    const label = document.createElement('span');
    label.textContent = 'contents motion (dev):';
    box.append(label);
    for (const [value, text] of [
      ['widen', 'widen'],
      ['glide', 'glide'],
      [fx, 'replay ↻'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bevel';
      b.style.cssText = 'font:inherit;padding:4px 7px;cursor:pointer;';
      b.textContent = text;
      if (text !== 'replay ↻') b.setAttribute('aria-pressed', String(value === fx));
      b.addEventListener('click', () => {
        try {
          sessionStorage.setItem('tocfx', value);
        } catch {}
        window.scrollTo(0, 0);
        location.reload();
      });
      box.append(b);
    }
    document.body.append(box);
    signal.addEventListener('abort', () => box.remove());
  }

  // Came here from a writing list? "← writing" / "← home" is a plain link to that
  // list's exact URL (filters included), so it always gets there however many
  // contents jumps happened here; the list then restores its scroll position
  // (see PostFeed.astro). Browser Back and modified clicks behave normally.
  try {
    const saved = JSON.parse(sessionStorage.getItem('feed-return') || 'null');
    if (saved && typeof saved.path === 'string' && saved.path.startsWith('/')) {
      saved.seenPost = true;
      sessionStorage.setItem('feed-return', JSON.stringify(saved));
      const back = document.querySelector<HTMLAnchorElement>('[data-back-to-list]');
      if (back) {
        back.href = `${saved.path}${saved.search ?? ''}`;
        back.textContent = saved.path === '/' ? '← home' : '← writing';
      }
    }
  } catch {}
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
  // Escape closes the phone contents drawer and puts focus back on its toggle.
  drawer?.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !drawer.open) return;
      e.preventDefault();
      drawer.open = false;
      drawer.querySelector<HTMLElement>('summary')?.focus();
    },
    { signal },
  );

  initPreviews(body, signal);

  // Chart values: hover and keyboard focus show them in CSS; a tap shows the
  // tapped point's value (and hides the others) on touch screens too.
  body.addEventListener(
    'pointerup',
    (e) => {
      const pt = (e.target as Element).closest?.('.chart-svg .pt');
      body.querySelectorAll('.chart-svg .pt.is-shown').forEach((p) => p !== pt && p.classList.remove('is-shown'));
      pt?.classList.toggle('is-shown');
    },
    { signal },
  );

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
