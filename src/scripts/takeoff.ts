/**
 * Animates ```takeoff figures (markup and scenario: plugins/takeoff.mjs): an
 * illustrative fast takeoff in which language-model perplexity falls slowly,
 * then ever faster, crossing thresholds that each unlock something models can
 * do. Calendar time runs steadily while drawing but pauses at each milestone
 * so its log line can type out; as takeoff speeds up the dates race by.
 * Painted with the site's colour variables, so it follows paper / cyber.
 */
import { autoMount, themeColours, type ThemeColours } from './figure-mount';

// keep in step with plugins/takeoff.mjs
const FLOOR = 4;
const GAP = 3;
const RATE = Math.LN2 / 3;

const YEARS_PER_SECOND = 0.55; // calendar time while drawing
const BEAT = 1.2; // pause at each milestone while its log line types out
const HOLD = 2.2;
const ERASE = 4;
const REST = 0.8;
const FLASH = 0.7; // square ripple where the curve crosses a threshold
const TYPE_CPS = 75; // log typing speed, characters per second
const ROWS = 10;
const SHADES = 64;
const BASE_LOG = '> steady scaling · waiting for takeoff';
// y axis: log of the distance above the floor, so steady scaling is a straight
// line, takeoff bends it down, and the thresholds near the floor spread out
const LOG_OFFSET = 0.3;
const yv = (p: number) => Math.log(Math.max(0, p - FLOOR) + LOG_OFFSET);
const Y_TOP = yv(10.2);
const Y_BOT = yv(FLOOR) - 0.08;

type Phase = 'tracing' | 'done' | 'clearing' | 'idle';
type Milestone = { ppl: number; text: string; t: number; date: string; beat: number };

function scenario(start: number, years: number) {
  const ppl = (t: number) => {
    if (t <= start) return FLOOR + GAP * Math.exp(-RATE * (t - start));
    if (t >= start + years) return FLOOR;
    return FLOOR + GAP * Math.pow(1 - (t - start) / years, RATE * years);
  };
  const cross = (p: number) => {
    const gap = p - FLOOR;
    if (gap >= GAP) return start - Math.log(gap / GAP) / RATE;
    return start + years * (1 - Math.pow(gap / GAP, 1 / (RATE * years)));
  };
  // how much faster perplexity is improving than before takeoff
  const speed = (t: number) => (t < start ? 1 : 1 / Math.max(1e-3, 1 - (t - start) / years));
  return { ppl, cross, speed };
}

function isoDay(t: number) {
  const y = Math.floor(t);
  const a = Date.UTC(y, 0, 1);
  return new Date(a + (t - y) * (Date.UTC(y + 1, 0, 1) - a)).toISOString().slice(0, 10);
}

const fmtSpeed = (m: number) => (m >= 999 ? '×∞' : m >= 10 ? `×${Math.round(m)}` : `×${m.toFixed(1)}`);

function mount(fig: HTMLElement): () => void {
  const $ = (sel: string) => fig.querySelector<HTMLElement>(sel);
  const stage = $('.zt-stage');
  const canvas = fig.querySelector<HTMLCanvasElement>('.zt-canvas');
  const ctx = canvas?.getContext('2d');
  const parts = ['[data-tk-rows]', '[data-tk-count]', '[data-tk-coord]', '[data-tk-meta]', '[data-tk-log]', '[data-tk-status]', '[data-tk-pct]', '[data-tk-fill]', '[data-tk-toggle]', '.zt-heading', '.tk-bottom', '.zt-zeros'].map($);
  if (!stage || !canvas || !ctx || parts.some((p) => !p)) return () => {};
  const [rowsEl, countEl, coordEl, metaEl, logEl, statusEl, pctEl, fillEl, toggle, headingEl, bottomEl, milesBox] = parts as HTMLElement[];

  // ---- the scenario and its timeline --------------------------------------
  const start = Number(fig.dataset.start) || 2027;
  const years = Number(fig.dataset.years) || 2.5;
  let raw: { ppl: number; text: string }[] = [];
  try {
    raw = JSON.parse(fig.dataset.milestones || '[]');
  } catch {}
  const { ppl, cross, speed } = scenario(start, years);
  const t0 = start - 3;
  const t1 = start + years + 0.5;
  const miles: Milestone[] = raw
    .map((m) => ({ ppl: Number(m.ppl), text: String(m.text), t: cross(Number(m.ppl)), date: '', beat: 0 }))
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
    m.date = isoDay(m.t);
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

  const N = 1400;
  const ts = Float64Array.from({ length: N }, (_, i) => t0 + ((t1 - t0) * i) / (N - 1));
  const ps = ts.map(ppl);

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
  function layout() {
    const box = stage!.getBoundingClientRect();
    W = box.width;
    H = box.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas!.width = Math.round(W * dpr);
    canvas!.height = Math.round(H * dpr);
    L = 40;
    R = W - 16;
    T = headingEl.getBoundingClientRect().bottom - box.top + 18;
    B = bottomEl.getBoundingClientRect().top - box.top - 24;
    if (B - T < 80) T = Math.max(8, B - 80);

    // The milestones box goes bottom-left of the plot, under the steady-scaling
    // line, when the curve stays clear of it there; otherwise it keeps its
    // top-right spot from the CSS.
    milesBox.style.top = milesBox.style.left = milesBox.style.right = '';
    const w = milesBox.offsetWidth;
    const h = milesBox.offsetHeight;
    const left = L + 12;
    const top = B - 10 - h;
    let fits = top > T + 10;
    for (let i = 0; i < N && fits; i += 4) {
      const x = X(ts[i]);
      if (x > left - 10 && x < left + w + 10 && Y(ps[i]) + 12 > top) fits = false;
    }
    if (fits) {
      milesBox.style.top = `${top}px`;
      milesBox.style.left = `${left}px`;
      milesBox.style.right = 'auto';
    }
  }
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (R - L);
  const Y = (p: number) => T + ((Y_TOP - yv(p)) / (Y_TOP - Y_BOT)) * (B - T);
  const shadeOf = (t: number) => Math.min(SHADES - 1, Math.max(0, Math.floor(((t - t0) / (t1 - t0)) * SHADES)));

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

    // axes, ticks and labels
    g.strokeStyle = col.rule;
    g.beginPath();
    g.moveTo(L + 0.5, T);
    g.lineTo(L + 0.5, B + 0.5);
    g.lineTo(R, B + 0.5);
    g.stroke();
    // y labels: the top, every threshold and the floor, skipping any that would collide
    g.fillStyle = col.faint;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    let lastTick = -Infinity;
    for (const p of [10, ...miles.map((m) => m.ppl), FLOOR]) {
      const y = Math.round(Y(p)) + 0.5;
      line(L - 3, y, L, y);
      if (y - lastTick < 11) continue;
      lastTick = y;
      g.fillText(p.toFixed(1), L - 6, y);
    }
    g.save();
    g.translate(9, (T + B) / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = 'center';
    g.fillText('perplexity · log scale', 0, 0);
    g.restore();
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let yr = Math.ceil(t0); yr <= t1; yr += (R - L) / (t1 - t0) < 48 ? 2 : 1) {
      const x = Math.round(X(yr)) + 0.5;
      line(x, B, x, B + 3);
      g.fillText(String(yr), x, B + 6);
    }

    // the entropy floor, the takeoff line and the thresholds
    g.setLineDash([2, 3]);
    g.strokeStyle = col.muted;
    line(L, Y(FLOOR), R, Y(FLOOR));
    g.setLineDash([3, 4]);
    g.strokeStyle = col.faint;
    line(X(start), T, X(start), B);
    g.setLineDash([4, 4]);
    g.strokeStyle = col.rule;
    for (const m of miles) line(L, Y(m.ppl), R, Y(m.ppl));
    g.setLineDash([]);
    g.fillStyle = col.muted;
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.fillText('entropy floor', X(start) + 5, Y(FLOOR) - 3);
    g.fillStyle = col.faint;
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText('takeoff', X(start) + 5, T + 2);

    // faint outline of the whole scenario, so the loop never starts from nothing
    g.globalAlpha = 0.4;
    g.strokeStyle = col.faint;
    g.beginPath();
    g.moveTo(X(ts[0]), Y(ps[0]));
    for (let i = 1; i < N; i++) g.lineTo(X(ts[i]), Y(ps[i]));
    g.stroke();
    g.globalAlpha = 1;

    // the trace, shaded by date
    if (hi > lo) {
      const pts: number[] = [lo];
      for (let i = 0; i < N; i++) if (ts[i] > lo && ts[i] < hi) pts.push(ts[i]);
      pts.push(hi);
      g.lineWidth = 1.8;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (let i = 0; i < pts.length - 1; ) {
        const k = shadeOf(pts[i]);
        g.beginPath();
        g.moveTo(X(pts[i]), Y(ppl(pts[i])));
        while (i < pts.length - 1 && shadeOf(pts[i]) === k) {
          i++;
          g.lineTo(X(pts[i]), Y(ppl(pts[i])));
        }
        g.strokeStyle = col.shades[k];
        g.stroke();
      }
    }

    // crossings: a square on each threshold reached, with its date where there's room
    const on = miles.map((m) => phase !== 'idle' && m.t >= lo && m.t <= hi);
    g.fillStyle = col.ink;
    let lastLabel = -Infinity;
    miles.forEach((m, k) => {
      if (!on[k]) return;
      const x = Math.round(X(m.t));
      const y = Math.round(Y(m.ppl));
      g.fillStyle = col.ink;
      g.fillRect(x - 2, y - 2, 5, 5);
      if (y - lastLabel < 12) return;
      lastLabel = y;
      const label = m.date.slice(0, 7);
      const right = x + 8 + g.measureText(label).width < R;
      g.fillStyle = col.muted;
      g.textAlign = right ? 'left' : 'right';
      g.textBaseline = 'middle';
      g.fillText(label, right ? x + 8 : x - 8, y);
    });
    if (phase === 'tracing') {
      const recent = miles.filter((m) => tau >= m.beat && tau - m.beat < FLASH).pop();
      if (recent) {
        const p = (tau - recent.beat) / FLASH;
        const r = 3 + 18 * p;
        g.globalAlpha = (1 - p) ** 1.5;
        g.strokeStyle = col.signal;
        g.lineWidth = 1.2;
        g.strokeRect(X(recent.t) - r, Y(recent.ppl) - r, 2 * r, 2 * r);
        g.globalAlpha = 1;
      }
    }

    // pen (filled square) and reticle; only the reticle while erasing
    if (phase !== 'idle') {
      const px = Math.round(X(active));
      const py = Math.round(Y(ppl(active)));
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
      const last = on.lastIndexOf(true);
      const first = Math.max(0, Math.min(miles.length - rows.length, last - rows.length + 1));
      rows.forEach((row, j) => {
        const m = miles[first + j];
        row.textContent = on[first + j] ? `[x] ${m.date}  ${m.ppl.toFixed(1)}` : `[ ] ····-··-··  ${m.ppl.toFixed(1)}`;
        row.classList.toggle('is-on', on[first + j]);
      });
      countEl.textContent = `${found}/${miles.length}`;
    }
    coordEl.textContent = `■ ${isoDay(active)} // ppl ${ppl(active).toFixed(3)}`;
    metaEl.textContent = `SPEED ${fmtSpeed(speed(active))} · MILESTONES ${String(found).padStart(2, '0')}/${String(miles.length).padStart(2, '0')}`;

    let log = BASE_LOG;
    const latest = phase === 'tracing' || phase === 'done' ? on.lastIndexOf(true) : -1;
    if (latest >= 0) {
      const m = miles[latest];
      const full = `> ${m.date} · ppl ${m.ppl.toFixed(1)} · ${m.text}`;
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
