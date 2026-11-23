/**
 * Shared plumbing for the live post figures (```zeta, ```takeoff): mount every
 * matching element on each page and any added later (the studio preview
 * replaces its HTML on every update), and clean up the ones that are removed.
 * Also reads the theme colours the figures paint with.
 */
import { onPage } from './lifecycle';

export function autoMount(selector: string, mount: (el: HTMLElement) => () => void) {
  const cleanups = new Map<HTMLElement, () => void>();

  const mountWithin = (node: Node) => {
    if (!(node instanceof Element)) return;
    const found = node.matches(selector) ? [node] : node.querySelectorAll(selector);
    for (const el of found as Iterable<HTMLElement>) {
      if (!cleanups.has(el)) cleanups.set(el, mount(el));
    }
  };

  const sweep = () => {
    for (const [el, stop] of cleanups) {
      if (!el.isConnected) {
        stop();
        cleanups.delete(el);
      }
    }
  };

  onPage((signal) => {
    sweep();
    mountWithin(document.body);
    const watch = new MutationObserver((records) => {
      let removed = false;
      for (const r of records) {
        r.addedNodes.forEach(mountWithin);
        r.removedNodes.forEach((n) => {
          if (n instanceof Element) removed = true;
        });
      }
      if (removed && cleanups.size) sweep();
    });
    watch.observe(document.body, { childList: true, subtree: true });
    signal.addEventListener('abort', () => {
      watch.disconnect();
      for (const stop of cleanups.values()) stop();
      cleanups.clear();
    });
  });
}

export type ThemeColours = { ink: string; muted: string; faint: string; rule: string; signal: string; font: string; shades: string[] };

/**
 * The site's colour variables as seen from `el`, plus `steps` shades running
 * faint → mid → ink (mid is the accent where the theme has one, else muted).
 */
export function themeColours(el: Element, ctx: CanvasRenderingContext2D, steps = 64): ThemeColours {
  const cs = getComputedStyle(el);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const rgb = (css: string): number[] => {
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    const v = String(ctx.fillStyle);
    if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
    return (v.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
  };
  const ink = get('--ink', '#18181a');
  const muted = get('--muted', '#5e5e64');
  const faint = get('--faint', '#a2a2a7');
  const accent = get('--accent', ink);
  const stops = [rgb(faint), rgb(String(rgb(accent)) === String(rgb(ink)) ? muted : accent), rgb(ink)];
  const shades = Array.from({ length: steps }, (_, k) => {
    const p = (k / (steps - 1)) * 2;
    const [a, b] = p < 1 ? [stops[0], stops[1]] : [stops[1], stops[2]];
    const f = p < 1 ? p : p - 1;
    return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`;
  });
  return { ink, muted, faint, rule: get('--rule', '#d0d0cc'), signal: get('--signal', ink), font: get('--font-mono', 'monospace'), shades };
}
