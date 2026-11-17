/**
 * Small ambient touches in the window bar, governed by the quiet / full motion
 * switch (html[data-motion], remembered in localStorage):
 *  - a clock: HH:MM in quiet, ticking HH:MM:SS in full;
 *  - emoticon frames before the tab title (site.config.json → tabAnimation,
 *    on by default); the page and site name always stay in the title.
 * Everything stops while the tab is hidden, and never animates with
 * prefers-reduced-motion (the clock then just shows HH:MM).
 * CSS handles the rest of "full": cursor blink, ticker, HUD ring and pulses.
 */
import { onPage } from './lifecycle';

const root = document.documentElement;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const full = () => root.dataset.motion === 'full' && !reduced.matches;
const two = (n: number) => String(n).padStart(2, '0');

type TabAnim = { enabled: boolean; intervalMs: number; frames: string[] };

let clockTimer = 0;
let titleTimer = 0;
let baseTitle = document.title;
let frame = 0;
let anim: TabAnim = { enabled: false, intervalMs: 950, frames: [] };

function tickClock() {
  window.clearTimeout(clockTimer);
  const el = document.querySelector<HTMLElement>('[data-clock]');
  if (!el || document.hidden) return;
  const d = new Date();
  const seconds = full();
  el.textContent = `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ''}`;
  el.dateTime = d.toISOString();
  // Wake up exactly at the next second (full) or minute (quiet).
  const wait = seconds ? 1000 - d.getMilliseconds() : (60 - d.getSeconds()) * 1000 - d.getMilliseconds();
  clockTimer = window.setTimeout(tickClock, wait + 5);
}

function stopTitle() {
  window.clearInterval(titleTimer);
  titleTimer = 0;
  if (document.title !== baseTitle) document.title = baseTitle;
}

function startTitle() {
  stopTitle();
  if (!anim.enabled || !anim.frames.length || reduced.matches || document.hidden) return;
  const step = () => {
    frame = (frame + 1) % anim.frames.length;
    document.title = `${anim.frames[frame]} ${baseTitle}`;
  };
  step();
  titleTimer = window.setInterval(step, anim.intervalMs);
}

function syncSwitch() {
  const on = root.dataset.motion === 'full';
  document.querySelectorAll('[data-motion-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(on)));
}

function refresh() {
  syncSwitch();
  tickClock();
  startTitle();
}

document.addEventListener('visibilitychange', () => (document.hidden ? (window.clearTimeout(clockTimer), stopTitle()) : refresh()));
reduced.addEventListener('change', refresh);

// Astro sets the new page's title during the swap: drop our frame first.
document.addEventListener('astro:before-swap', stopTitle);

onPage((signal) => {
  baseTitle = document.title;
  try {
    anim = JSON.parse(document.body.dataset.tabAnimation || '{}');
  } catch {}
  document.querySelector('[data-motion-toggle]')?.addEventListener(
    'click',
    () => {
      const next = root.dataset.motion === 'full' ? 'quiet' : 'full';
      root.dataset.motion = next;
      try {
        localStorage.setItem('motion', next);
      } catch {}
      refresh();
    },
    { signal },
  );
  refresh();
});
