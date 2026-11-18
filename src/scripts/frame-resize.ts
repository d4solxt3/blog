/**
 * Drag the site window's left or right edge to make it wider or narrower
 * (desktop pointers). The window stays centred, so both edges move. The width
 * is remembered per frame type (hub pages / articles) in localStorage and
 * restored before first paint by ThemeScript. Double-click or Home resets.
 * Arrow keys nudge by 20px (Shift: 80px) when the right edge is focused.
 */
import { onPage } from './lifecycle';

const MIN = 720;
const DEFAULTS: Record<string, number> = { hub: 940, article: 1200 };

onPage((signal) => {
  const shell = document.querySelector<HTMLElement>('.shell');
  const grips = [...document.querySelectorAll<HTMLElement>('[data-frame-grip]')];
  if (!shell || !grips.length) return;
  const kind = shell.dataset.frame === 'article' ? 'article' : 'hub';
  const root = document.documentElement;
  const prop = `--frame-user-${kind}`;
  const key = `frame-w:${kind}`;
  const box = shell.querySelector<HTMLElement>('.frame-box')!;

  const gap = () => parseFloat(getComputedStyle(shell).paddingLeft) || 0;
  const max = () => Math.max(MIN, Math.floor(document.documentElement.clientWidth - 2 * gap()));
  const current = () => Math.round(box.getBoundingClientRect().width);
  const clamp = (w: number) => Math.round(Math.min(max(), Math.max(MIN, w)));

  const sep = grips.find((g) => g.getAttribute('role') === 'separator');
  const paintAria = () => {
    sep?.setAttribute('aria-valuemin', String(MIN));
    sep?.setAttribute('aria-valuemax', String(max()));
    sep?.setAttribute('aria-valuenow', String(current()));
    sep?.setAttribute('aria-valuetext', `${current()} pixels wide`);
  };
  paintAria();

  let readout: HTMLElement | null = null;
  const showReadout = (w: number) => {
    if (!readout) {
      readout = document.createElement('div');
      readout.className = 'frame-size';
      readout.setAttribute('aria-hidden', 'true');
      document.body.append(readout);
    }
    const d = DEFAULTS[kind];
    readout.textContent = `${w} × auto${w === d ? ' · default' : ''}`;
  };
  const hideReadout = () => {
    readout?.remove();
    readout = null;
  };

  const apply = (w: number, save = true) => {
    root.style.setProperty(prop, `${w}px`);
    if (save) {
      try {
        localStorage.setItem(key, String(w));
      } catch {}
    }
    paintAria();
  };
  const reset = () => {
    root.style.removeProperty(prop);
    try {
      localStorage.removeItem(key);
    } catch {}
    paintAria();
    showReadout(current());
    setTimeout(hideReadout, 700);
  };

  for (const grip of grips) {
    const dir = Number(grip.dataset.frameGrip);
    grip.addEventListener(
      'pointerdown',
      (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startW = current();
        shell.classList.add('is-resizing');
        showReadout(startW);
        const move = (ev: PointerEvent) => {
          // Centred window: each pixel of edge travel is two pixels of width; snap near the default.
          let w = clamp(startW + 2 * dir * (ev.clientX - startX));
          if (Math.abs(w - DEFAULTS[kind]) < 12) w = DEFAULTS[kind];
          apply(w, false);
          showReadout(w);
        };
        const up = () => {
          grip.removeEventListener('pointermove', move);
          shell.classList.remove('is-resizing');
          hideReadout();
          const w = current();
          if (w === DEFAULTS[kind]) reset();
          else apply(w);
          hideReadout();
        };
        grip.addEventListener('pointermove', move, { signal });
        grip.addEventListener('pointerup', up, { once: true, signal });
        grip.addEventListener('pointercancel', up, { once: true, signal });
      },
      { signal },
    );
    grip.addEventListener('dblclick', reset, { signal });
  }

  sep?.addEventListener(
    'keydown',
    (e) => {
      const step = e.shiftKey ? 80 : 20;
      let w: number | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') w = current() + step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') w = current() - step;
      else if (e.key === 'Home') {
        e.preventDefault();
        reset();
        return;
      } else if (e.key === 'End') w = max();
      if (w === null) return;
      e.preventDefault();
      apply(clamp(w));
      showReadout(current());
      clearTimeout(Number(sep.dataset.t));
      sep.dataset.t = String(setTimeout(hideReadout, 700));
    },
    { signal },
  );
  sep?.addEventListener('blur', hideReadout, { signal });
  window.addEventListener('resize', paintAria, { signal });
  signal.addEventListener('abort', hideReadout);
});
