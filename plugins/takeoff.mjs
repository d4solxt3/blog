// The fast-takeoff animation's markup and scenario, shared by the ```takeoff
// fence (plugins/remark-takeoff.mjs) and the studio preview. The animation is
// src/scripts/takeoff.ts; it reuses the zeta figure's window styles
// (src/styles/zeta-trace.css) plus src/styles/takeoff.css.
//
// The curve is base-model log-perplexity on a fixed eval set. Up to November
// 2026 it is measured (HISTORY, read by eye from the reference chart). After
// that it is an illustrative scenario, not a forecast: the late-2026 pace
// carries on until `start`, then takeoff — the pace compounds until the curve
// reaches the (unknown) floor.
import { el } from './charts.mjs';

/** Released models: [decimal year, log-perplexity], oldest first. */
export const HISTORY = [
  [2025.12, 0.877], // GPT-4.5
  [2025.28, 0.902], // GPT-4.1 / o3
  [2025.62, 0.893], // GPT-5 / 5.1
  [2025.96, 0.888], // GPT-5.2
  [2026.12, 0.871], // GPT-5.3-Codex / 5.4
  [2026.29, 0.848], // GPT-5.5
  [2026.54, 0.829], // GPT-5.6 Sol
  [2026.71, 0.783], // GPT-6 Astra
  [2026.87, 0.761], // GPT-6.2 Astra
];
/** An unreleased internal model, measured at the same date as the last release. */
export const INTERNAL = [2026.87, 0.732];
export const PACE = 0.2; // late-2026 pace: log-perplexity falls ~0.2 a year
export const SHAPE = 0.55; // below 1, so the decline keeps steepening until the floor

export const DEFAULT_MILESTONES = [
  { at: 0.871, text: 'already here: a genuinely useful coder' },
  { at: 0.829, text: 'already here: cybersecurity-expert level' },
  { at: 0.761, text: 'already here: a Millennium Prize problem falls (the Riemann hypothesis), checked in Lean' },
  { at: 0.735, text: 'takeoff: AI now does most of the research on the next AI' },
  { at: 0.7, text: 'builds and ships a whole product from a one-page brief' },
  { at: 0.66, text: "runs a lab's full experiment queue overnight, unsupervised" },
  { at: 0.62, text: 'the other Millennium Prize problems fall, all checked in Lean' },
  { at: 0.58, text: 'designs a faster AI chip and the production line to build it' },
  { at: 0.54, text: 'does a decade of drug-discovery work in a few months' },
  { at: 0.5, text: 'can do almost any job that is done at a computer' },
  { at: 0.46, text: 'proposes new physics, and the experiments to test it' },
  { at: 0.42, text: 'near the floor: text is about as predictable as it can be' },
];

const last = HISTORY[HISTORY.length - 1];
const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Resolved scenario: takeoff year, its length in years, and the floor. */
export function scenario(o = {}) {
  const start = clamp(o.start, last[0], last[0] + 1.5, 2027);
  const atStart = last[1] - PACE * (start - last[0]);
  const floor = Math.min(clamp(o.floor, 0.2, 0.7, 0.4), atStart - 0.03);
  // by default the takeoff starts at the late-2026 pace and speeds up from there
  const years = o.years == null ? ((atStart - floor) * SHAPE) / PACE : clamp(o.years, 0.2, 5, 1);
  return { start, years, floor };
}

/** Log-perplexity at decimal year t. */
export function levelAt(t, { start, years, floor }) {
  if (t <= HISTORY[0][0]) return HISTORY[0][1];
  for (let i = 1; i < HISTORY.length; i++) {
    const [ta, la] = HISTORY[i - 1];
    const [tb, lb] = HISTORY[i];
    if (t <= tb) return la + ((lb - la) * (t - ta)) / (tb - ta);
  }
  if (t <= start) return last[1] - PACE * (t - last[0]);
  if (t >= start + years) return floor;
  const gap = last[1] - PACE * (start - last[0]) - floor;
  return floor + gap * Math.pow(1 - (t - start) / years, SHAPE);
}

/** Decimal year at which log-perplexity first reaches p. */
export function crossingYear(p, { start, years, floor }) {
  for (let i = 0; i < HISTORY.length; i++) {
    const [tb, lb] = HISTORY[i];
    if (lb > p) continue;
    if (i === 0) return tb;
    const [ta, la] = HISTORY[i - 1];
    return ta + ((la - p) / (la - lb)) * (tb - ta);
  }
  const atStart = last[1] - PACE * (start - last[0]);
  if (p >= atStart) return last[0] + (last[1] - p) / PACE;
  return start + years * (1 - Math.pow((p - floor) / (atStart - floor), 1 / SHAPE));
}

/** Decimal year → "YYYY-MM-DD". */
export function isoDay(t) {
  const y = Math.floor(t);
  const a = Date.UTC(y, 0, 1);
  return new Date(a + (t - y) * (Date.UTC(y + 1, 0, 1) - a)).toISOString().slice(0, 10);
}

/** Fence options → clean values. Custom milestones: a list of { logppl, text }. */
export function takeoffOptions(o = {}) {
  const s = scenario(o);
  const custom = Array.isArray(o.milestones)
    ? o.milestones
        .map((m) => ({ at: Number(m?.logppl ?? m?.at ?? m?.loss), text: String(m?.text ?? '').trim().slice(0, 100) }))
        .filter((m) => Number.isFinite(m.at) && m.at > s.floor && m.at <= 0.95 && m.text)
        .slice(0, 14)
    : [];
  const milestones = (custom.length ? custom : DEFAULT_MILESTONES)
    .map((m) => ({ ...m, t: crossingYear(m.at, s) }))
    .sort((a, b) => a.t - b.t);
  return { ...s, caption: o.caption ? String(o.caption) : '', title: o.title ? String(o.title) : 'fast_takeoff', milestones };
}

/** The figure as a hast element (data-takeoff marks it for the runtime). */
export function takeoffFigure(options) {
  const { start, years, floor, caption, title, milestones } = takeoffOptions(options);
  const end = isoDay(start + years).slice(0, 7);
  return el(
    'figure',
    {
      className: ['zt', 'tk'],
      dataTakeoff: '',
      dataStart: String(start),
      dataYears: String(years),
      dataFloor: String(floor),
      dataHistory: JSON.stringify(HISTORY),
      dataInternal: JSON.stringify(INTERNAL),
      dataMilestones: JSON.stringify(milestones),
    },
    [
      el('div', { className: ['panel', 'panel--primary', 'zt-win'] }, [
        el('div', { className: ['panel-bar'] }, [
          el('span', { className: ['panel-title'] }, [title]),
          el('span', { className: ['panel-tools'] }, [
            el('button', { type: 'button', className: ['shade-btn', 'bevel'], dataTkToggle: '', ariaPressed: 'false', ariaLabel: 'Pause animation', title: 'Pause' }, ['||']),
          ]),
        ]),
        el('div', { className: ['zt-stage'] }, [
          el('canvas', {
            className: ['zt-canvas'],
            role: 'img',
            ariaLabel: `Base-model log-perplexity: measured from 2025 to November 2026, falling from about 0.90 to 0.76, then an illustrative fast-takeoff scenario in which it falls ever faster to a floor of ${floor} by ${end}. The milestones are listed below.`,
          }),
          el('div', { className: ['zt-heading'], ariaHidden: 'true' }, [
            el('div', { className: ['zt-big'] }, ['fast takeoff']),
            el('div', { className: ['zt-sub'] }, ['measured to Nov 2026, then an illustrative scenario']),
          ]),
          el('div', { className: ['panel', 'zt-zeros'] }, [
            el('div', { className: ['panel-bar'] }, [
              el('span', { className: ['panel-title'] }, ['milestones ', el('span', { className: ['count'], dataTkCount: '' })]),
            ]),
            el('div', { className: ['zt-rows'], dataTkRows: '' }),
          ]),
          el('div', { className: ['tk-bottom'], ariaHidden: 'true' }, [
            el('div', { dataTkCoord: '' }, ['■ 0000-00-00 // log-ppl 0.000']),
            el('div', { className: ['zt-meta'], dataTkMeta: '' }, ['SPEED ×1.0 · MILESTONES 00/00']),
            el('div', { className: ['tk-log'], dataTkLog: '' }, ['> measured progress · waiting for takeoff']),
          ]),
        ]),
        el('div', { className: ['zt-foot'], ariaHidden: 'true' }, [
          el('span', { dataTkStatus: '' }),
          el('span', { className: ['zt-progress'] }, [
            el('span', { dataTkPct: '' }),
            el('span', { className: ['zt-track'] }, [el('span', { className: ['zt-fill'], dataTkFill: '' })]),
          ]),
        ]),
      ]),
      el('ol', { className: ['sr-only'] }, milestones.map((m) => el('li', {}, [`${isoDay(m.t)}, log-perplexity ${m.at}: ${m.text}`]))),
      caption ? el('figcaption', {}, [caption]) : null,
    ],
  );
}
