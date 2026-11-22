/**
 * Animates every ζ(½ + it) figure on the page (markup: plugins/zeta-trace.mjs,
 * written as a ```zeta fence or <ZetaTrace />). Zeta is computed here in the
 * browser and painted with the site's CSS colour variables, so the figure
 * matches paper or cyber and follows the theme switch. Figures added later
 * (the studio preview re-renders its HTML) are picked up automatically, and
 * removed ones are cleaned up. Pauses off-screen; reduced-motion readers get
 * the finished picture and a play button.
 */
import { onPage } from './lifecycle';

// one loop, in seconds: draw in, hold, erase from the start, rest on the outline
const DRAW = 14;
const HOLD = 1.5;
const ERASE = 7;
const REST = 0.7;
const LOOP = DRAW + HOLD + ERASE + REST;
const FLASH = 0.7; // square ripple at the origin when a zero is hit
const ROWS = 10; // zeros listed at once
const SHADES = 64; // colour steps along the trace

type Phase = 'tracing' | 'done' | 'clearing' | 'idle';
type Curve = { N: number; ts: Float64Array; xs: Float64Array; ys: Float64Array; zeros: number[]; box: [number, number, number, number] };

/**
 * ζ(½ + it) through Borwein's acceleration of the alternating series for
 * η(s), then ζ(s) = η(s) / (1 − 2^(1−s)). Accurate to ~1e-13 for t ≤ 100.
 */
function zetaOnCriticalLine(tMax: number) {
  const n = Math.ceil(1.15 * tMax + 40);
  const d = new Float64Array(n + 1);
  let term = 1 / n;
  let sum = term;
  d[0] = 1;
  for (let i = 1; i <= n; i++) {
    term *= (4 * (n + i - 1) * (n - i + 1)) / (2 * i * (2 * i - 1));
    sum += term;
    d[i] = n * sum;
  }
  const weight = new Float64Array(n);
  const logk = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    weight[k] = ((k % 2 ? -1 : 1) * (d[k] - d[n])) / (-d[n] * Math.sqrt(k + 1));
    logk[k] = Math.log(k + 1);
  }
  return (t: number): [number, number] => {
    let re = 0;
    let im = 0;
    for (let k = 0; k < n; k++) {
      re += weight[k] * Math.cos(t * logk[k]);
      im -= weight[k] * Math.sin(t * logk[k]);
    }
    const c = 1 - Math.SQRT2 * Math.cos(t * Math.LN2);
    const s = Math.SQRT2 * Math.sin(t * Math.LN2);
    const den = c * c + s * s;
    return [(re * c + im * s) / den, (im * c - re * s) / den];
  };
}

/** Hardy's Z(t) = e^{iθ(t)} ζ(½ + it) is real; its sign changes are the zeros. */
function hardyZ(t: number, [re, im]: [number, number]) {
  const theta = (t / 2) * Math.log(t / (2 * Math.PI)) - t / 2 - Math.PI / 8 + 1 / (48 * t) + 7 / (5760 * t ** 3);
  return re * Math.cos(theta) - im * Math.sin(theta);
}

const curves = new Map<number, Curve>();
function curveFor(tMax: number): Curve {
  const cached = curves.get(tMax);
  if (cached) return cached;
  const zeta = zetaOnCriticalLine(tMax);
  const N = Math.round(tMax * 80);
  const ts = new Float64Array(N);
  const xs = new Float64Array(N);
  const ys = new Float64Array(N);
  const zs = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = (tMax * i) / (N - 1);
    const v = zeta(t);
    ts[i] = t;
    xs[i] = v[0];
    ys[i] = v[1];
    zs[i] = t > 0 ? hardyZ(t, v) : 0;
  }
  const zeros: number[] = [];
  for (let i = 1; i < N; i++) {
    // the first zero is at t ≈ 14.13; θ's asymptotic series is only trusted above t = 8
    if (ts[i - 1] <= 8 || zs[i - 1] * zs[i] >= 0) continue;
    let a = ts[i - 1];
    let b = ts[i];
    let za = zs[i - 1];
    for (let k = 0; k < 40; k++) {
      const m = (a + b) / 2;
      const zm = hardyZ(m, zeta(m));
      if (za * zm <= 0) b = m;
      else [a, za] = [m, zm];
    }
    zeros.push((a + b) / 2);
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    minX = Math.min(minX, xs[i]);
    maxX = Math.max(maxX, xs[i]);
    minY = Math.min(minY, ys[i]);
    maxY = Math.max(maxY, ys[i]);
  }
  const curve: Curve = { N, ts, xs, ys, zeros, box: [minX, maxX, minY, maxY] };
  curves.set(tMax, curve);
  return curve;
}

const ease = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * p);
const signed = (x: number) => (x < 0 ? '−' : '+') + Math.abs(x).toFixed(3);

function state(tau: number): { phase: Phase; lo: number; hi: number } {
  if (tau < DRAW) return { phase: 'tracing', lo: 0, hi: ease(tau / DRAW) };
  if (tau < DRAW + HOLD) return { phase: 'done', lo: 0, hi: 1 };
  if (tau < DRAW + HOLD + ERASE) return { phase: 'clearing', lo: ease((tau - DRAW - HOLD) / ERASE), hi: 1 };
  return { phase: 'idle', lo: 1, hi: 1 };
}

/** Sets one figure going; returns its clean-up. */
function mount(fig: HTMLElement): () => void {
  const tMax = Math.min(100, Math.max(15, Number(fig.dataset.tmax) || 50));
  const $ = (sel: string) => fig.querySelector<HTMLElement>(sel);
  const stage = $('.zt-stage');
  const canvas = fig.querySelector<HTMLCanvasElement>('.zt-canvas');
  const ctx = canvas?.getContext('2d');
  const parts = [$('[data-zt-rows]'), $('.zt-zeros'), $('[data-zt-count]'), $('[data-zt-coord]'), $('[data-zt-meta]'), $('[data-zt-status]'), $('[data-zt-pct]'), $('[data-zt-fill]'), $('[data-zt-toggle]'), $('.zt-heading'), $('.zt-hud')];
  if (!stage || !canvas || !ctx || parts.some((p) => !p)) return () => {};
  const [rowsEl, zerosBox, countEl, coordEl, metaEl, statusEl, pctEl, fillEl, toggle, headingEl, hudEl] = parts as HTMLElement[];

  const { N, ts, xs, ys, zeros, box: [minX, maxX, minY, maxY] } = curveFor(tMax);
  // when the pen reaches each zero (inverse of the ease)
  const zeroTau = zeros.map((z) => (DRAW * Math.acos(1 - (2 * z) / tMax)) / Math.PI);
  rowsEl.replaceChildren();
  const rows = Array.from({ length: Math.min(ROWS, zeros.length) }, () => {
    const row = document.createElement('div');
    row.className = 'zt-row';
    rowsEl.append(row);
    return row;
  });

  // ---- colours from the site's CSS variables ------------------------------
  let col = { ink: '', muted: '', faint: '', rule: '', signal: '', font: 'monospace' };
  let shades: string[] = [];
  const rgb = (css: string): number[] => {
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    const v = String(ctx.fillStyle);
    if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
    return (v.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
  };
  function readColours() {
    const cs = getComputedStyle(fig);
    const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    col = {
      ink: get('--ink', '#18181a'),
      muted: get('--muted', '#5e5e64'),
      faint: get('--faint', '#a2a2a7'),
      rule: get('--rule', '#d0d0cc'),
      signal: get('--signal', get('--ink', '#18181a')),
      font: get('--font-mono', 'monospace'),
    };
    // light → mid → ink; mid is the accent where the theme has one (cyber), else muted (paper)
    const accent = get('--accent', col.ink);
    const stops = [rgb(col.faint), rgb(String(rgb(accent)) === String(rgb(col.ink)) ? col.muted : accent), rgb(col.ink)];
    shades = Array.from({ length: SHADES }, (_, k) => {
      const p = (k / (SHADES - 1)) * 2;
      const [a, b] = p < 1 ? [stops[0], stops[1]] : [stops[1], stops[2]];
      const f = p < 1 ? p : p - 1;
      return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`;
    });
  }

  // ---- layout: the largest curve that stays clear of the text boxes --------
  let W = 0, H = 0, dpr = 1, s = 1, ox = 0, oy = 0;
  let boxes: { l: number; t: number; r: number; b: number }[] = [];
  const blocked = (x: number, y: number) => boxes.some((q) => x > q.l && x < q.r && y > q.t && y < q.b);
  function layout() {
    const box = stage!.getBoundingClientRect();
    W = box.width;
    H = box.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas!.width = Math.round(W * dpr);
    canvas!.height = Math.round(H * dpr);
    boxes = [headingEl, zerosBox, hudEl].map((el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left - box.left - 10, t: r.top - box.top - 10, r: r.right - box.left + 10, b: r.bottom - box.top + 10 };
    });
    const step = Math.max(1, Math.floor(N / 900));
    const sMax = Math.min((H - 28) / (maxY - minY), (W - 28) / (maxX - minX));
    let best = 0;
    for (const fx of [0.5, 0.45, 0.4, 0.35]) {
      for (let k = sMax; k > sMax * 0.35; k *= 0.97) {
        const x = fx * W - (k * (minX + maxX)) / 2;
        const y = H / 2 + (k * (minY + maxY)) / 2;
        if (x + k * minX < 14 || x + k * maxX > W - 14) continue;
        let hit = false;
        for (let i = 0; i < N && !hit; i += step) hit = blocked(x + k * xs[i], y - k * ys[i]);
        if (hit) continue;
        if (k > best) [best, s, ox, oy] = [k, k, x, y];
        break;
      }
    }
    if (!best) {
      s = sMax * 0.7;
      ox = W / 2 - (s * (minX + maxX)) / 2;
      oy = H / 2 + (s * (minY + maxY)) / 2;
    }
  }
  const X = (i: number) => ox + s * xs[i];
  const Y = (i: number) => oy - s * ys[i];

  // ---- one frame -----------------------------------------------------------
  let rowsKey = '';
  function render(tau: number) {
    if (!W || !H) return;
    const c = ctx!;
    const { phase, lo, hi } = state(tau);
    const a = Math.round(lo * (N - 1));
    const b = Math.round(hi * (N - 1));
    const active = phase === 'clearing' ? a : phase === 'idle' ? 0 : b;

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);

    // axes, ticks and labels
    const x0 = Math.round(ox) + 0.5;
    const y0 = Math.round(oy) + 0.5;
    c.lineWidth = 1;
    c.strokeStyle = col.rule;
    c.beginPath();
    c.moveTo(0, y0);
    c.lineTo(W, y0);
    c.moveTo(x0, 0);
    c.lineTo(x0, H);
    c.stroke();
    c.strokeStyle = col.faint;
    c.beginPath();
    for (let k = Math.ceil(minX); k <= Math.floor(maxX); k++) {
      if (!k) continue;
      const x = Math.round(ox + s * k) + 0.5;
      c.moveTo(x, y0 - 3);
      c.lineTo(x, y0 + 3);
    }
    for (let k = Math.ceil(minY); k <= Math.floor(maxY); k++) {
      if (!k) continue;
      const y = Math.round(oy - s * k) + 0.5;
      c.moveTo(x0 - 3, y);
      c.lineTo(x0 + 3, y);
    }
    c.stroke();
    c.fillStyle = col.faint;
    c.font = `10px ${col.font}`;
    // axis names, wherever they don't land on a text box
    const label = (text: string, spots: [number, number][]) => {
      const spot = spots.find(([x, y]) => x > 4 && x < W - 16 && y > 12 && y < H - 4 && !blocked(x, y) && !blocked(x + 12, y - 8));
      if (spot) c.fillText(text, spot[0], spot[1]);
    };
    label('re', [[ox + s * (maxX + 0.15), y0 - 6], [W - 22, y0 - 6]]);
    label('im', [[x0 + 6, oy - s * (maxY + 0.3)], [x0 + 6, oy - s * (minY - 0.45)]]);

    // faint outline of the whole curve, so the loop never starts from nothing
    c.globalAlpha = 0.4;
    c.strokeStyle = col.faint;
    c.beginPath();
    c.moveTo(X(0), Y(0));
    for (let i = 1; i < N; i++) c.lineTo(X(i), Y(i));
    c.stroke();
    c.globalAlpha = 1;

    // the trace, shaded by t
    c.lineWidth = 1.8;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const shadeOf = (i: number) => Math.min(SHADES - 1, Math.floor((ts[i] / tMax) * SHADES));
    for (let i = a; i < b; ) {
      const k = shadeOf(i);
      c.beginPath();
      c.moveTo(X(i), Y(i));
      while (i < b && shadeOf(i) === k) {
        i++;
        c.lineTo(X(i), Y(i));
      }
      c.strokeStyle = shades[k];
      c.stroke();
    }

    // origin, and a square ripple when the pen hits a zero
    c.lineWidth = 1;
    c.strokeStyle = col.muted;
    c.beginPath();
    c.moveTo(x0 - 4, y0);
    c.lineTo(x0 + 4, y0);
    c.moveTo(x0, y0 - 4);
    c.lineTo(x0, y0 + 4);
    c.stroke();
    const age = Math.min(...zeroTau.map((zt) => (tau >= zt && phase === 'tracing' ? tau - zt : Infinity)));
    if (age < FLASH) {
      const p = age / FLASH;
      const r = 3 + 20 * p;
      c.globalAlpha = (1 - p) ** 1.5;
      c.strokeStyle = col.signal;
      c.lineWidth = 1.2;
      c.strokeRect(x0 - r, y0 - r, 2 * r, 2 * r);
      c.globalAlpha = 1;
    }

    // pen (filled square) and reticle; only the reticle while erasing
    if (phase !== 'idle') {
      const px = Math.round(X(active));
      const py = Math.round(Y(active));
      c.lineWidth = 1;
      c.strokeStyle = col.ink;
      c.strokeRect(px - 5.5, py - 5.5, 11, 11);
      if (phase !== 'clearing') {
        c.fillStyle = col.ink;
        c.fillRect(px - 2, py - 2, 4, 4);
      }
    }

    // the text around it
    const on = zeros.map((z) => phase !== 'idle' && ts[a] <= z && z <= ts[b]);
    const found = on.filter(Boolean).length;
    const key = on.join();
    if (key !== rowsKey) {
      rowsKey = key;
      const last = on.lastIndexOf(true);
      const first = Math.max(0, Math.min(zeros.length - rows.length, last - rows.length + 1));
      rows.forEach((row, j) => {
        const k = first + j;
        row.textContent = on[k] ? `[x] ${zeros[k].toFixed(4).padStart(7)}` : '[ ] ··.····';
        row.classList.toggle('is-on', on[k]);
      });
      countEl.textContent = `${found}/${zeros.length}`;
    }
    coordEl.textContent = `■ re ${signed(xs[active])} // im ${signed(ys[active])}`;
    metaEl.textContent = `T ${ts[active].toFixed(2).padStart(6, '0')} · ZEROS ${String(found).padStart(2, '0')}`;
    statusEl.textContent = `▫ ${paused ? 'paused' : phase}`;
    const progress = tau / LOOP;
    pctEl.textContent = `${Math.round(progress * 100)}%`.padStart(4);
    fillEl.style.width = `${progress * 100}%`;
  }

  // ---- playback --------------------------------------------------------------
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let paused = reduced;
  let tau = reduced ? DRAW + HOLD / 2 : 0;
  let visible = false;
  let raf = 0;
  let last = 0;
  const frame = (now: number) => {
    raf = 0;
    if (paused || !visible || !fig.isConnected) return;
    tau = (tau + (last ? Math.min(0.1, (now - last) / 1000) : 0)) % LOOP;
    last = now;
    render(tau);
    raf = requestAnimationFrame(frame);
  };
  const kick = () => {
    if (!paused && visible && !raf) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  };
  const setPaused = (value: boolean) => {
    paused = value;
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
    toggle.title = paused ? 'Play' : 'Pause';
    toggle.textContent = paused ? '▷' : '||';
    render(tau);
    kick();
  };
  const onToggle = () => setPaused(!paused);
  toggle.addEventListener('click', onToggle);

  readColours();
  layout();
  setPaused(paused);

  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    kick();
  });
  io.observe(stage);
  const ro = new ResizeObserver(() => {
    layout();
    render(tau);
  });
  ro.observe(stage);
  const mo = new MutationObserver(() => {
    readColours();
    render(tau);
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-font', 'class', 'style'] });
  document.fonts?.ready.then(() => {
    if (!fig.isConnected) return;
    layout();
    render(tau);
  });

  return () => {
    cancelAnimationFrame(raf);
    raf = 0;
    paused = true;
    io.disconnect();
    ro.disconnect();
    mo.disconnect();
    toggle.removeEventListener('click', onToggle);
  };
}

// ---- find figures: on each page, and any added later (the studio preview) ----
const SELECTOR = '[data-zeta-trace]';
const cleanups = new Map<HTMLElement, () => void>();

function mountWithin(node: Node) {
  if (!(node instanceof Element)) return;
  const figs = node.matches(SELECTOR) ? [node] : node.querySelectorAll(SELECTOR);
  for (const fig of figs as Iterable<HTMLElement>) {
    if (!cleanups.has(fig)) cleanups.set(fig, mount(fig));
  }
}

function sweep() {
  for (const [fig, stop] of cleanups) {
    if (!fig.isConnected) {
      stop();
      cleanups.delete(fig);
    }
  }
}

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
