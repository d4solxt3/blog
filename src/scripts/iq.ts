/**
 * Animates ```iq figures (data and markup: plugins/iq.mjs): horizontal bars
 * for a cow, the average human and a top human, plus frontier AI, whose bar
 * grows through the years. Past the test's ceiling the bar turns hatched and
 * dashed (beyond the test, then by analogy). At the end two brackets show the
 * analogy: cow → human is the same ratio as human → ASI. Painted with the
 * site's colour variables, so it follows paper / cyber.
 */
import { autoMount, themeColours, type ThemeColours } from './figure-mount';

const YEARS_PER_SECOND = 0.6; // calendar time while the AI bar grows
const BEAT = 1.3; // pause at each data point while its log line types out
const HOLD = 3.4; // the finished chart, with the analogy brackets
const ERASE = 1.6;
const REST = 0.7;
const FLASH = 0.7; // square ripple at the bar's end on each data point
const TYPE_CPS = 80;
const BASE_LOG = '> frontier AI vs people, 2023 →';

type Ref = { label: string; value: number };
type Point = { t: number; value: number; who: string; note: string; beyond?: boolean; scenario?: boolean; month: string; beat: number };
type Phase = 'tracing' | 'done' | 'clearing' | 'idle';

function isoMonth(t: number) {
  const y = Math.floor(t);
  const a = Date.UTC(y, 0, 1);
  return new Date(a + (t - y) * (Date.UTC(y + 1, 0, 1) - a)).toISOString().slice(0, 7);
}

const ease = (p: number) => 0.5 - 0.5 * Math.cos(Math.PI * p);
const times = (x: number) => (x >= 10 ? `×${Math.round(x)}` : `×${Number(x.toFixed(1))}`);

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
  const parts = ['[data-iq-coord]', '[data-iq-meta]', '[data-iq-log]', '[data-iq-status]', '[data-iq-pct]', '[data-iq-fill]', '[data-iq-toggle]', '.zt-heading', '.tk-bottom'].map($);
  const refs = parse<Ref[]>(fig.dataset.refs, []);
  const points: Point[] = parse<Omit<Point, 'month' | 'beat'>[]>(fig.dataset.ai, [])
    .map((p) => ({ ...p, month: isoMonth(p.t), beat: 0 }))
    .sort((a, b) => a.t - b.t);
  if (!stage || !canvas || !ctx || parts.some((p) => !p) || refs.length < 2 || points.length < 2) return () => {};
  const [coordEl, metaEl, logEl, statusEl, pctEl, fillEl, toggle, headingEl, bottomEl] = parts as HTMLElement[];

  const ceiling = Number(fig.dataset.ceiling) || 150;
  const animal = refs[0];
  const human = refs.find((r) => /average/i.test(r.label))?.value ?? 100;
  const top = refs.find((r) => /top/i.test(r.label))?.value ?? 160;
  const asi = points[points.length - 1].value;
  const scaleMax = Math.ceil((asi * 1.12) / 50) * 50;

  // ---- the timeline: steady calendar time, pausing at each data point ---------
  const t0 = Math.floor(points[0].t);
  const t1 = points[points.length - 1].t + 0.1;
  const keys: [number, number][] = [[0, t0]]; // [animation seconds, calendar year]
  let a = 0;
  let c = t0;
  for (const p of points) {
    a += (p.t - c) / YEARS_PER_SECOND;
    c = p.t;
    keys.push([a, c]);
    p.beat = a;
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
  const valueAt = (t: number) => {
    if (t <= points[0].t) return points[0].value * Math.max(0, (t - t0) / (points[0].t - t0));
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1];
      const q = points[i];
      if (t <= q.t) return p.value + ((q.value - p.value) * (t - p.t)) / (q.t - p.t);
    }
    return asi;
  };
  function state(tau: number): { phase: Phase; cal: number; v: number; brackets: number } {
    if (tau < DRAW) {
      const cal = calAt(tau);
      return { phase: 'tracing', cal, v: valueAt(cal), brackets: 0 };
    }
    if (tau < DRAW + HOLD) return { phase: 'done', cal: t1, v: asi, brackets: Math.min(1, (tau - DRAW) / 0.6) };
    if (tau < DRAW + HOLD + ERASE) {
      const p = (tau - DRAW - HOLD) / ERASE;
      return { phase: 'clearing', cal: t1, v: asi * (1 - ease(p)), brackets: Math.max(0, 1 - 3 * p) };
    }
    return { phase: 'idle', cal: t0, v: 0, brackets: 0 };
  }

  let col: ThemeColours = themeColours(fig, ctx, 64);
  const hatch = (color: string) => {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 6;
    const t = tile.getContext('2d')!;
    t.strokeStyle = color;
    t.lineWidth = 1;
    t.beginPath();
    t.moveTo(0, 6);
    t.lineTo(6, 0);
    t.stroke();
    return ctx.createPattern(tile, 'repeat');
  };
  let hatchFaint = hatch(col.rule);
  let hatchInk = hatch(col.ink);

  // ---- layout ----------------------------------------------------------------
  let W = 0, H = 0, dpr = 1, L = 0, R = 0, T = 0, B = 0, bh = 12, rowsTop = 0;
  let rowY: number[] = [];
  let narrow = false;
  const X = (v: number) => L + (v / scaleMax) * (R - L);
  function layout() {
    const box = stage!.getBoundingClientRect();
    W = box.width;
    H = box.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas!.width = Math.round(W * dpr);
    canvas!.height = Math.round(H * dpr);
    narrow = W < 460;
    // the label column is as wide as its widest label
    ctx!.font = `11px ${col.font}`;
    const widest = Math.max(...refs.map((r) => ctx!.measureText(r.label).width));
    ctx!.font = `600 11px ${col.font}`;
    L = Math.ceil(Math.max(widest, ctx!.measureText('frontier AI').width)) + 16;
    R = W - (narrow ? 14 : 18);
    T = headingEl.getBoundingClientRect().bottom - box.top + 14;
    B = bottomEl.getBoundingClientRect().top - box.top - 22; // the x axis
    rowsTop = T + 14; // room for the ceiling label
    const rowsBot = B - 32; // the analogy brackets live between the bars and the axis
    const n = refs.length + 1;
    const rowH = Math.max(14, (rowsBot - rowsTop) / n);
    bh = Math.max(7, Math.min(20, rowH * 0.55));
    rowY = Array.from({ length: n }, (_, i) => rowsTop + rowH * (i + 0.5));
  }

  // ---- one frame -------------------------------------------------------------
  let logText = '';
  function render(tau: number) {
    if (!W || !H) return;
    const g = ctx!;
    const { phase, cal, v, brackets } = state(tau);
    const latestIdx = phase === 'tracing' || phase === 'done' ? points.reduce((k, p, i) => (p.t <= cal ? i : k), -1) : -1;
    const latest = latestIdx >= 0 ? points[latestIdx] : null;
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    };
    const valueLabel = (value: number, p: Point | null) =>
      value <= ceiling + 0.5 ? `≈${Math.round(value)}` : p?.scenario ? `≈${Math.round(value)} · by analogy` : `≥${ceiling} · off the test`;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.font = `10px ${col.font}`;
    g.lineWidth = 1;
    g.setLineDash([]);

    // past the ceiling: hatched, with a dashed edge and a label
    const xc = X(ceiling);
    g.globalAlpha = 0.7;
    if (hatchFaint) g.fillStyle = hatchFaint;
    g.fillRect(xc, rowsTop - 6, R - xc, B - rowsTop + 6);
    g.globalAlpha = 1;
    g.setLineDash([3, 3]);
    g.strokeStyle = col.muted;
    line(xc + 0.5, rowsTop - 6, xc + 0.5, B);
    g.setLineDash([]);
    g.fillStyle = col.muted;
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.fillText(narrow ? `tests max out ~${ceiling}` : `IQ tests max out (~${ceiling}): beyond here is analogy`, xc + 5, rowsTop - 8);

    // the axis
    g.strokeStyle = col.rule;
    line(L, B + 0.5, R, B + 0.5);
    g.fillStyle = col.faint;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let s = 0; s <= scaleMax; s += narrow ? 200 : 100) {
      const x = Math.round(X(s)) + 0.5;
      line(x, B, x, B + 3);
      g.fillText(String(s), x, B + 6);
    }

    // the fixed bars
    refs.forEach((r, i) => {
      const y = rowY[i];
      g.fillStyle = col.ink;
      g.font = `11px ${col.font}`;
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      g.fillText(r.label, L - 8, y);
      g.fillStyle = i === 0 ? col.faint : col.muted;
      g.fillRect(L, Math.round(y - bh / 2), X(r.value) - L, Math.round(bh));
      g.font = `10px ${col.font}`;
      g.fillStyle = col.muted;
      g.textAlign = 'left';
      g.fillText(i === 0 ? `≈${r.value}` : String(r.value), X(r.value) + 6, y);
    });

    // the frontier-AI bar
    const yAi = rowY[refs.length];
    g.fillStyle = col.ink;
    g.font = `600 11px ${col.font}`;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillText('frontier AI', L - 8, yAi - (latest?.who ? 6 : 0));
    if (latest?.who) {
      g.font = `10px ${col.font}`;
      g.fillStyle = col.muted;
      const who = latest.who.length > 16 ? `${latest.who.slice(0, 15)}…` : latest.who;
      g.fillText(who, L - 8, yAi + 7);
    }
    g.font = `10px ${col.font}`;
    if (v > 0.2) {
      const top0 = Math.round(yAi - bh / 2);
      const xv = X(v);
      const xs = X(Math.min(v, ceiling));
      g.fillStyle = col.ink;
      g.fillRect(L, top0, xs - L, Math.round(bh));
      if (v > ceiling) {
        if (hatchInk) g.fillStyle = hatchInk;
        g.fillRect(xs, top0, xv - xs, Math.round(bh));
        g.setLineDash([3, 2]);
        g.strokeStyle = col.ink;
        g.strokeRect(xs + 0.5, top0 + 0.5, xv - xs - 1, Math.round(bh) - 1);
        g.setLineDash([]);
      }
      const label = valueLabel(v, latest);
      const w = g.measureText(label).width;
      g.fillStyle = col.ink;
      g.textBaseline = 'middle';
      if (xv + 6 + w <= W - 4) {
        g.textAlign = 'left';
        g.fillText(label, xv + 6, yAi);
      } else {
        g.textAlign = 'right';
        g.textBaseline = 'bottom';
        g.fillText(label, xv, top0 - 3);
      }
      // a ripple at the bar's end on each data point
      if (phase === 'tracing' && latest && tau >= latest.beat && tau - latest.beat < FLASH) {
        const p = (tau - latest.beat) / FLASH;
        const r = 3 + 14 * p;
        g.globalAlpha = (1 - p) ** 1.5;
        g.strokeStyle = col.signal;
        g.lineWidth = 1.2;
        g.strokeRect(xv - r, yAi - r, 2 * r, 2 * r);
        g.globalAlpha = 1;
        g.lineWidth = 1;
      }
    }

    // the analogy: cow → human is the same ratio as human → ASI
    if (brackets > 0) {
      const yb = B - 12;
      const bracket = (x1: number, x2: number, text: string, short: string) => {
        g.strokeStyle = col.ink;
        g.beginPath();
        g.moveTo(x1 + 0.5, yb - 4);
        g.lineTo(x1 + 0.5, yb + 0.5);
        g.lineTo(x2 - 0.5, yb + 0.5);
        g.lineTo(x2 - 0.5, yb - 4);
        g.stroke();
        const s = g.measureText(text).width < x2 - x1 - 8 ? text : short;
        g.fillStyle = col.ink;
        g.textAlign = 'center';
        g.textBaseline = 'bottom';
        g.fillText(s, (x1 + x2) / 2, yb - 3);
      };
      g.globalAlpha = brackets;
      const r1 = times(human / animal.value);
      const r2 = times(asi / human);
      bracket(X(animal.value), X(human), `${animal.label} → human ${r1}`, r1);
      bracket(X(human), X(asi), `human → ASI ${r2}: as far above us as we are above ${animal.label}s`, `human → ASI ${r2}`);
      g.globalAlpha = 1;
    }

    // ---- the text around it ----------------------------------------------------
    coordEl.textContent = `■ ${isoMonth(phase === 'idle' ? t0 : cal)} // frontier AI ${v > 0.2 ? valueLabel(v, latest) : '—'}`;
    metaEl.textContent = v > 0.2 ? `${times(v / human)} AVERAGE HUMAN · ${times(v / top)} TOP HUMAN` : '—';
    let log = BASE_LOG;
    if (latest) {
      const value = latest.scenario ? `≈${latest.value} by analogy` : latest.beyond ? 'off the test' : `≈${latest.value}`;
      const full = `> ${latest.month} · ${latest.who ? `${latest.who} · ` : ''}${value} · ${latest.note}`;
      const n = phase === 'done' ? full.length : Math.floor((tau - latest.beat) * TYPE_CPS);
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
    col = themeColours(fig, ctx, 64);
    hatchFaint = hatch(col.rule);
    hatchInk = hatch(col.ink);
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

autoMount('[data-iq]', mount);
