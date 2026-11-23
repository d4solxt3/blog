/**
 * Animates ```takeoff figures (markup and scenario: plugins/takeoff.mjs).
 * Base-model log-perplexity: measured up to November 2026 (solid, with a dot
 * per release), then an illustrative fast takeoff (dashed) that falls ever
 * faster to an unknown floor. Each threshold the curve crosses gets a date and
 * a line about what models can do by then. Calendar time runs steadily while
 * drawing but pauses at each milestone so its log line can type out, so the
 * dates race by as takeoff speeds up. Painted with the site's colour
 * variables, so it follows paper / cyber.
 */
import { autoMount, themeColours, type ThemeColours } from './figure-mount';

// keep in step with plugins/takeoff.mjs
const PACE = 0.2;
const SHAPE = 0.55;

const YEARS_PER_SECOND = 0.4; // calendar time while drawing
const BEAT = 1.2; // pause at each milestone while its log line types out
const HOLD = 2.4;
const ERASE = 4;
const REST = 0.8;
const FLASH = 0.7; // square ripple where the curve crosses a threshold
const TYPE_CPS = 80; // log typing speed, characters per second
const ROWS = 10;
const SHADES = 64;
const BASE_LOG = '> measured progress · waiting for takeoff';

type Phase = 'tracing' | 'done' | 'clearing' | 'idle';
type Milestone = { at: number; text: string; t: number; date: string; beat: number };

function isoDay(t: number) {
  const y = Math.floor(t);
  const a = Date.UTC(y, 0, 1);
  return new Date(a + (t - y) * (Date.UTC(y + 1, 0, 1) - a)).toISOString().slice(0, 10);
}

const fmtSpeed = (m: number) => (m >= 999 ? '×∞' : m >= 10 ? `×${Math.round(m)}` : `×${m.toFixed(1)}`);

function parse<T>(json: string | undefined, fallback: T): T {
  try {
    return json ? (JSON.parse(json) as T) : fallback;
  } catch {
    return fallback;
  }
}

function mount(fig: HTMLElement): () => void {
  const $ = (sel: string) => fig.querySelector<HTMLElement>(sel);
  const stage = $('.zt-stage');
  const canvas = fig.querySelector<HTMLCanvasElement>('.zt-canvas');
  const ctx = canvas?.getContext('2d');
  const parts = ['[data-tk-rows]', '[data-tk-count]', '[data-tk-coord]', '[data-tk-meta]', '[data-tk-log]', '[data-tk-status]', '[data-tk-pct]', '[data-tk-fill]', '[data-tk-toggle]', '.zt-heading', '.tk-bottom', '.zt-zeros'].map($);
  const history = parse<[number, number][]>(fig.dataset.history, []);
  if (!stage || !canvas || !ctx || parts.some((p) => !p) || history.length < 2) return () => {};
  const [rowsEl, countEl, coordEl, metaEl, logEl, statusEl, pctEl, fillEl, toggle, headingEl, bottomEl, milesBox] = parts as HTMLElement[];

  // ---- the curve: measured history, then the scenario -------------------------
  const start = Number(fig.dataset.start) || 2027;
  const years = Number(fig.dataset.years) || 1;
  const floor = Number(fig.dataset.floor) || 0.4;
  const internal = parse<[number, number] | null>(fig.dataset.internal, null);
  const [tNow, lNow] = history[history.length - 1];
  const atStart = lNow - PACE * (start - tNow);
  const gap = atStart - floor;
  const level = (t: number) => {
    if (t <= history[0][0]) return history[0][1];
    for (let i = 1; i < history.length; i++) {
      const [ta, la] = history[i - 1];
      const [tb, lb] = history[i];
      if (t <= tb) return la + ((lb - la) * (t - ta)) / (tb - ta);
    }
    if (t <= start) return lNow - PACE * (t - tNow);
    if (t >= start + years) return floor;
    return floor + gap * Math.pow(1 - (t - start) / years, SHAPE);
  };
  // how much faster it is falling than the late-2026 pace
  const speed = (t: number) => {
    if (t <= start) return 1;
    const x = (t - start) / years;
    return x >= 0.9999 ? 1000 : ((gap * SHAPE) / years) * Math.pow(1 - x, SHAPE - 1) / PACE;
  };

  const tAxis = Math.floor(history[0][0]); // the x axis starts on a whole year…
  const t0 = history[0][0]; // …the curve at the first measurement
  const t1 = start + years + 0.25;
  const yTop = Math.ceil((Math.max(...history.map((h) => h[1])) + 0.015) * 50) / 50;
  const yBot = floor - 0.02;

  // ---- the timeline: steady calendar time, pausing at each milestone ----------
  const miles: Milestone[] = parse<{ at: number; text: string; t: number }[]>(fig.dataset.milestones, [])
    .map((m) => ({ at: Number(m.at), text: String(m.text), t: Number(m.t), date: isoDay(Number(m.t)), beat: 0 }))
    .filter((m) => Number.isFinite(m.t) && m.t >= t0 && m.t <= t1)
    .sort((a, b) => a.t - b.t);
  const keys: [number, number][] = [[0, t0]]; // [animation seconds, calendar year]
  let a = 0;
  let c = t0;
  for (const m of miles) {
    a += (m.t - c) / YEARS_PER_SECOND;
    c = m.t;
    keys.push([a, c]);
    m.beat = a;
    a += BEAT;
    keys.push([a, c]);
  }
  a += (t1 - c) / YEARS_PER_SECOND;
  keys.push([a, t1]);
  const DRAW = a;
  const LOOP = DRAW + HOLD + ERASE + REST;
  const calAt = (tau: number) => {
    for (let i = 1; i < keys.length; i++) {
      const [a1, c1] = keys[i];
      if (tau <= a1) {
        const [a0, c0] = keys[i - 1];
        return a1 === a0 ? c1 : c0 + ((c1 - c0) * (tau - a0)) / (a1 - a0);
      }
    }
    return t1;
  };
  function state(tau: number): { phase: Phase; lo: number; hi: number } {
    if (tau < DRAW) return { phase: 'tracing', lo: t0, hi: calAt(tau) };
    if (tau < DRAW + HOLD) return { phase: 'done', lo: t0, hi: t1 };
    if (tau < DRAW + HOLD + ERASE) {
      const p = (tau - DRAW - HOLD) / ERASE;
      return { phase: 'clearing', lo: t0 + (t1 - t0) * (0.5 - 0.5 * Math.cos(Math.PI * p)), hi: t1 };
    }
    return { phase: 'idle', lo: t1, hi: t1 };
  }

  // samples: evenly in time, plus every measured point and extra near the floor
  const extra = Array.from({ length: 80 }, (_, i) => start + years * (1 - Math.pow(1 - i / 80, 3)));
  const ts = [...Array.from({ length: 900 }, (_, i) => t0 + ((t1 - t0) * i) / 899), ...history.map((h) => h[0]), ...extra, start, start + years]
    .filter((t) => t >= t0 && t <= t1)
    .sort((x, y) => x - y);

  rowsEl.replaceChildren();
  const rows = miles.slice(0, ROWS).map(() => {
    const row = document.createElement('div');
    row.className = 'zt-row';
    rowsEl.append(row);
    return row;
  });

  let col: ThemeColours = themeColours(fig, ctx, SHADES);

  // ---- layout: the plot fills the space between the heading and the readout --
  let W = 0, H = 0, dpr = 1, L = 0, R = 0, T = 0, B = 0;
  const X = (t: number) => L + ((t - tAxis) / (t1 - tAxis)) * (R - L);
  const Y = (v: number) => T + ((yTop - v) / (yTop - yBot)) * (B - T);
  function layout() {
    const box = stage!.getBoundingClientRect();
    W = box.width;
    H = box.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas!.width = Math.round(W * dpr);
    canvas!.height = Math.round(H * dpr);
    L = 44;
    R = W - 16;
    T = headingEl.getBoundingClientRect().bottom - box.top + 18;
    B = bottomEl.getBoundingClientRect().top - box.top - 24;
    if (B - T < 80) T = Math.max(8, B - 80);

    // The milestones box goes bottom-left of the plot, under the measured part,
    // when the curve stays clear of it there; otherwise it keeps its top-right
    // spot from the CSS.
    milesBox.style.top = milesBox.style.left = milesBox.style.right = '';
    const w = milesBox.offsetWidth;
    const h = milesBox.offsetHeight;
    const left = L + 12;
    const top = B - 10 - h;
    let fits = top > T + 10;
    for (const t of ts) {
      const x = X(t);
      if (x > left - 10 && x < left + w + 10 && Y(level(t)) + 12 > top) fits = false;
      if (!fits) break;
    }
    if (fits) {
      milesBox.style.top = `${top}px`;
      milesBox.style.left = `${left}px`;
      milesBox.style.right = 'auto';
    }
  }
  const shadeOf = (t: number) => Math.min(SHADES - 1, Math.max(0, Math.floor(((t - t0) / (t1 - t0)) * SHADES)));

  /** Stroke the curve between two dates: solid where measured, dashed after "now". */
  function strokeCurve(g: CanvasRenderingContext2D, from: number, to: number, shaded: boolean) {
    const pts = [from, ...ts.filter((t) => t > from && t < to), to];
    const xNow = X(tNow);
    for (const measured of [true, false]) {
      g.save();
      g.beginPath();
      if (measured) g.rect(0, 0, xNow, H);
      else g.rect(xNow, 0, W - xNow, H);
      g.clip();
      g.setLineDash(measured ? [] : [5, 3]);
      for (let i = 0; i < pts.length - 1; ) {
        const k = shadeOf(pts[i]);
        g.beginPath();
        g.moveTo(X(pts[i]), Y(level(pts[i])));
        while (i < pts.length - 1 && (!shaded || shadeOf(pts[i]) === k)) {
          i++;
          g.lineTo(X(pts[i]), Y(level(pts[i])));
        }
        if (shaded) g.strokeStyle = col.shades[k];
        g.stroke();
      }
      g.restore();
    }
  }

  // ---- one frame -------------------------------------------------------------
  let rowsKey = '';
  let logText = '';
  function render(tau: number) {
    if (!W || !H) return;
    const g = ctx!;
    const { phase, lo, hi } = state(tau);
    const active = phase === 'clearing' ? lo : phase === 'idle' ? t0 : hi;
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    };

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.font = `10px ${col.font}`;
    g.lineWidth = 1;
    g.setLineDash([]);

    // axes, ticks and labels
    g.strokeStyle = col.rule;
    g.beginPath();
    g.moveTo(L + 0.5, T);
    g.lineTo(L + 0.5, B + 0.5);
    g.lineTo(R, B + 0.5);
    g.stroke();
    g.fillStyle = col.faint;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    const step = B - T < 200 ? 0.2 : 0.1;
    for (let v = Math.ceil(yBot / step) * step; v <= yTop + 1e-9; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      line(L - 3, y, L, y);
      g.fillText(v.toFixed(1), L - 6, y);
    }
    g.save();
    g.translate(9, (T + B) / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.fillText('log-perplexity', 0, 0);
    g.restore();
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let yr = Math.ceil(tAxis); yr <= t1; yr++) {
      const x = Math.round(X(yr)) + 0.5;
      line(x, B, x, B + 3);
      g.fillText(String(yr), x, B + 6);
    }

    // the floor, the "now" line and the thresholds
    const xNow = X(tNow);
    g.setLineDash([2, 3]);
    g.strokeStyle = col.muted;
    line(L, Y(floor), R, Y(floor));
    g.setLineDash([3, 4]);
    g.strokeStyle = col.faint;
    line(xNow, T, xNow, B);
    g.setLineDash([4, 4]);
    g.strokeStyle = col.rule;
    for (const m of miles) line(L, Y(m.at), R, Y(m.at));
    g.setLineDash([]);
    // under the floor line, so it never meets the dates of the last milestones;
    // the longest wording that fits
    const wide = R - L >= 420;
    g.fillStyle = col.muted;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    const floorLabel = ['floor (unknown; illustrative)', 'floor (illustrative)', 'floor'].find((s) => xNow + 5 + g.measureText(s).width <= R) ?? 'floor';
    g.fillText(floorLabel, xNow + 5, Y(floor) + 2);
    g.fillStyle = col.faint;
    g.textAlign = 'right';
    if (wide) {
      g.fillText('measured · now', xNow - 5, T + 2);
      g.textAlign = 'left';
      g.fillText('scenario →', xNow + 5, T + 2);
    } else {
      g.fillText('now', xNow - 4, T + 2);
    }

    // faint outline of the whole curve, so the loop never starts from nothing
    g.globalAlpha = 0.4;
    g.strokeStyle = col.faint;
    strokeCurve(g, t0, t1, false);
    g.globalAlpha = 1;

    // the trace, shaded by date
    if (hi > lo) {
      g.lineWidth = 1.8;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      strokeCurve(g, lo, hi, true);
    }

    // a dot per measured release, and the internal model once "now" is reached
    g.fillStyle = col.ink;
    for (const [t, v] of history) {
      if (t < lo || t > hi || phase === 'idle') continue;
      g.beginPath();
      g.arc(X(t), Y(v), 2.6, 0, Math.PI * 2);
      g.fill();
    }
    if (internal && hi >= internal[0] && phase !== 'idle') {
      const x = Math.round(X(internal[0]));
      const y = Math.round(Y(internal[1]));
      g.strokeStyle = col.muted;
      g.lineWidth = 1;
      g.strokeRect(x - 3.5, y - 3.5, 7, 7);
      if (wide) {
        g.fillStyle = col.muted;
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.fillText('internal', x, y + 7);
      }
    }

    // crossings: a square on each threshold reached, with its date. Measured
    // ones put the date below-left (clear of the line), scenario ones to the
    // right; each side skips a label that would collide with the one above.
    const on = miles.map((m) => phase !== 'idle' && m.t >= lo && m.t <= hi);
    const lastLabel = { left: -Infinity, right: -Infinity };
    miles.forEach((m, k) => {
      if (!on[k]) return;
      const x = Math.round(X(m.t));
      const y = Math.round(Y(m.at));
      g.fillStyle = col.ink;
      g.fillRect(x - 2, y - 2, 5, 5);
      const label = m.date.slice(0, 7);
      const early = m.t < start;
      const side = early || x + 8 + g.measureText(label).width > R ? 'left' : 'right';
      const ly = early ? y + 10 : y;
      if (ly - lastLabel[side] < 12) return;
      lastLabel[side] = ly;
      g.fillStyle = col.muted;
      g.textAlign = side === 'left' ? 'right' : 'left';
      g.textBaseline = 'middle';
      g.fillText(label, side === 'left' ? x - 6 : x + 8, ly);
    });
    if (phase === 'tracing') {
      const recent = miles.filter((m) => tau >= m.beat && tau - m.beat < FLASH).pop();
      if (recent) {
        const p = (tau - recent.beat) / FLASH;
        const r = 3 + 18 * p;
        g.globalAlpha = (1 - p) ** 1.5;
        g.strokeStyle = col.signal;
        g.lineWidth = 1.2;
        g.strokeRect(X(recent.t) - r, Y(recent.at) - r, 2 * r, 2 * r);
        g.globalAlpha = 1;
      }
    }

    // pen (filled square) and reticle; only the reticle while erasing
    if (phase !== 'idle') {
      const px = Math.round(X(active));
      const py = Math.round(Y(level(active)));
      g.lineWidth = 1;
      g.strokeStyle = col.ink;
      g.strokeRect(px - 5.5, py - 5.5, 11, 11);
      if (phase !== 'clearing') {
        g.fillStyle = col.ink;
        g.fillRect(px - 2, py - 2, 4, 4);
      }
    }

    // ---- the text around it ----------------------------------------------------
    const found = on.filter(Boolean).length;
    const key = on.join();
    if (key !== rowsKey) {
      rowsKey = key;
      const lastOn = on.lastIndexOf(true);
      const first = Math.max(0, Math.min(miles.length - rows.length, lastOn - rows.length + 1));
      rows.forEach((row, j) => {
        const m = miles[first + j];
        row.textContent = on[first + j] ? `[x] ${m.date}  ${m.at.toFixed(3)}` : `[ ] ····-··-··  ${m.at.toFixed(3)}`;
        row.classList.toggle('is-on', on[first + j]);
      });
      countEl.textContent = `${found}/${miles.length}`;
    }
    coordEl.textContent = `■ ${isoDay(active)} // log-ppl ${level(active).toFixed(3)}`;
    metaEl.textContent = `SPEED ${fmtSpeed(speed(active))} · MILESTONES ${String(found).padStart(2, '0')}/${String(miles.length).padStart(2, '0')}`;

    let log = BASE_LOG;
    const latest = phase === 'tracing' || phase === 'done' ? on.lastIndexOf(true) : -1;
    if (latest >= 0) {
      const m = miles[latest];
      const full = `> ${m.date} · log-ppl ${m.at.toFixed(3)} · ${m.text}`;
      const n = phase === 'done' ? full.length : Math.floor((tau - m.beat) * TYPE_CPS);
      log = n >= full.length ? full : `${full.slice(0, Math.max(0, n))}_`;
    }
    if (log !== logText) {
      logText = log;
      logEl.textContent = log;
    }

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
    col = themeColours(fig, ctx, SHADES);
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

autoMount('[data-takeoff]', mount);
