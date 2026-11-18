/**
 * The window's status bar, like an old browser's: hovering or focusing a link
 * shows where it goes ("done" otherwise); the right end shows how far down
 * the page you are and doubles as a back-to-top button.
 */
import { onPage } from './lifecycle';

const describe = (a: HTMLAnchorElement) => {
  const raw = a.getAttribute('href') ?? '';
  if (raw.startsWith('#')) return raw === '#top' ? 'top of page' : `jump to ${raw.slice(1).replace(/-/g, ' ')}`;
  try {
    const url = new URL(a.href, location.href);
    if (url.protocol === 'mailto:') return `mail ${url.pathname}`;
    if (url.origin === location.origin) return url.pathname + url.hash;
    return `${url.host}${url.pathname === '/' ? '' : url.pathname} ↗`;
  } catch {
    return raw;
  }
};

// While a page loads: "opening /posts/… |/-\" like an old browser.
let spin = 0;
document.addEventListener('astro:before-preparation', (e) => {
  const text = document.querySelector<HTMLElement>('[data-winstatus-text]');
  const to = (e as Event & { to?: URL }).to;
  if (!text || !to) return;
  const frames = ['|', '/', '-', '\\'];
  let i = 0;
  window.clearInterval(spin);
  const paint = () => (text.textContent = `opening ${to.pathname} ${frames[i++ % frames.length]}`);
  paint();
  spin = window.setInterval(paint, 90);
  text.closest('[data-winstatus]')?.classList.add('is-link');
});
document.addEventListener('astro:after-swap', () => window.clearInterval(spin));

onPage((signal) => {
  const bar = document.querySelector<HTMLElement>('[data-winstatus]');
  if (!bar) return;
  const text = bar.querySelector<HTMLElement>('[data-winstatus-text]')!;
  const pct = bar.querySelector<HTMLElement>('[data-winstatus-pct]')!;
  const idle = 'done';
  const show = (t: string | null) => {
    text.textContent = t ?? idle;
    bar.classList.toggle('is-link', !!t);
  };

  const over = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (a && !bar.contains(a)) show(describe(a));
  };
  const out = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a[href]');
    const to = (e as FocusEvent | MouseEvent).relatedTarget as Element | null;
    if (a && !a.contains(to)) show(null);
  };
  document.addEventListener('pointerover', over, { signal });
  document.addEventListener('pointerout', out, { signal });
  document.addEventListener('focusin', over, { signal });
  document.addEventListener('focusout', out, { signal });

  let queued = false;
  const paint = () => {
    queued = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    pct.textContent = `${max > 0 ? Math.round((scrollY / max) * 100) : 100}%`;
  };
  const onScroll = () => {
    if (queued) return;
    queued = true;
    setTimeout(paint, 60);
  };
  paint();
  addEventListener('scroll', onScroll, { passive: true, signal });
  addEventListener('resize', onScroll, { signal });

  bar.querySelector<HTMLAnchorElement>('[data-winstatus-top]')?.addEventListener(
    'click',
    (e) => {
      e.preventDefault();
      const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.getElementById('main')?.focus({ preventScroll: true });
      scrollTo({ top: 0, behavior: quiet ? 'auto' : 'smooth' });
    },
    { signal },
  );
});
