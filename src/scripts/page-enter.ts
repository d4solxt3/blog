/**
 * Page switches on the hub pages (home, writing, about): the boxes on the new
 * page open like little windows, title bar first, then the body unrolls,
 * one after another down each column (both columns at once). Only after a
 * client-side navigation; the first load has its own boot screen. The CSS
 * lives in global.css (:root.is-entering); reduced motion switches it off.
 */
const MAX = 8; // boxes past this open together, so long pages never drag
const STAGGER = 45; // ms between boxes in a column
const HOLD = 1100; // how long the entering state stays on

let timer = 0;

document.addEventListener('astro:after-swap', () => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  const columns = document.querySelectorAll<HTMLElement>('.portal:not(.studio-portal) > .portal-side, .portal:not(.studio-portal) > .portal-main, .portal--wide');
  if (!columns.length) return;
  columns.forEach((col) => {
    // Top-level boxes only (not boxes nested inside another box), in reading order.
    const boxes = [...col.querySelectorAll<HTMLElement>('.panel')].filter((p) => !p.parentElement?.closest('.panel'));
    boxes.forEach((box, i) => box.style.setProperty('--enter-i', String(Math.min(i, MAX))));
  });
  window.clearTimeout(timer);
  root.classList.remove('is-entering');
  void root.offsetWidth; // restart the animation if switching quickly
  root.classList.add('is-entering');
  timer = window.setTimeout(() => root.classList.remove('is-entering'), HOLD);
});
