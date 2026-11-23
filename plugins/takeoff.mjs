// The fast-takeoff animation's markup and scenario, shared by the ```takeoff
// fence (plugins/remark-takeoff.mjs) and the studio preview. The animation is
// src/scripts/takeoff.ts; it reuses the zeta figure's window styles
// (src/styles/zeta-trace.css) plus src/styles/takeoff.css.
//
// The scenario is illustrative, not a forecast: perplexity on a fixed held-out
// corpus falls slowly until `start`, then the rate of improvement grows
// hyperbolically and reaches the entropy floor `years` later.
import { el } from './charts.mjs';

export const FLOOR = 4; // irreducible perplexity of the corpus (the entropy floor)
export const GAP = 3; // perplexity above the floor when takeoff starts
export const RATE = Math.LN2 / 3; // before takeoff the gap halves every 3 years

export const DEFAULT_MILESTONES = [
  // already happened (Nov 2026); 7.09 is where the curve sits then
  { ppl: 7.09, text: 'already here: the Riemann hypothesis is proved, checked in Lean' },
  { ppl: 7.0, text: 'takeoff: AI now does most of the research on the next AI' },
  { ppl: 6.6, text: 'builds and ships a whole product from a one-page brief' },
  { ppl: 6.2, text: "runs a lab's full experiment queue overnight, unsupervised" },
  { ppl: 5.8, text: 'the other Millennium Prize problems fall, all checked in Lean' },
  { ppl: 5.4, text: 'designs a faster AI chip and the production line to build it' },
  { ppl: 5.0, text: 'does a decade of drug-discovery work in a few months' },
  { ppl: 4.6, text: 'can do almost any job that is done at a computer' },
  { ppl: 4.3, text: 'proposes new physics, and the experiments to test it' },
  { ppl: 4.1, text: 'near the entropy floor: text is as predictable as it can be' },
];

/** Perplexity at decimal year t. */
export function pplAt(t, start, years) {
  if (t <= start) return FLOOR + GAP * Math.exp(-RATE * (t - start));
  if (t >= start + years) return FLOOR;
  return FLOOR + GAP * Math.pow(1 - (t - start) / years, RATE * years);
}

/** Decimal year at which perplexity first reaches p. */
export function crossingYear(p, start, years) {
  const gap = p - FLOOR;
  if (gap >= GAP) return start - Math.log(gap / GAP) / RATE;
  return start + years * (1 - Math.pow(gap / GAP, 1 / (RATE * years)));
}

/** Decimal year → "YYYY-MM-DD". */
export function isoDay(t) {
  const y = Math.floor(t);
  const a = Date.UTC(y, 0, 1);
  return new Date(a + (t - y) * (Date.UTC(y + 1, 0, 1) - a)).toISOString().slice(0, 10);
}

const num = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Fence options → clean values. Custom milestones: a list of { ppl, text }. */
export function takeoffOptions(o = {}) {
  const custom = Array.isArray(o.milestones)
    ? o.milestones
        .map((m) => ({ ppl: Number(m?.ppl), text: String(m?.text ?? '').trim().slice(0, 90) }))
        .filter((m) => Number.isFinite(m.ppl) && m.ppl > FLOOR && m.ppl <= 10 && m.text)
        .slice(0, 10)
    : [];
  return {
    start: num(o.start, 2025, 2040, 2027),
    years: num(o.years, 0.5, 10, 2.5),
    caption: o.caption ? String(o.caption) : '',
    title: o.title ? String(o.title) : 'fast_takeoff',
    milestones: (custom.length ? custom : DEFAULT_MILESTONES).slice().sort((a, b) => b.ppl - a.ppl),
  };
}

/** The figure as a hast element (data-takeoff marks it for the runtime). */
export function takeoffFigure(options) {
  const { start, years, caption, title, milestones } = takeoffOptions(options);
  const listed = milestones.map((m) => ({ ...m, date: isoDay(crossingYear(m.ppl, start, years)) }));
  return el('figure', { className: ['zt', 'tk'], dataTakeoff: '', dataStart: String(start), dataYears: String(years), dataMilestones: JSON.stringify(milestones) }, [
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
          ariaLabel: `An illustrative fast-takeoff scenario: language-model perplexity falls slowly until ${Math.floor(start)}, then ever faster until it reaches the entropy floor about ${years} years later. The milestones are listed below.`,
        }),
        el('div', { className: ['zt-heading'], ariaHidden: 'true' }, [
          el('div', { className: ['zt-big'] }, ['fast takeoff']),
          el('div', { className: ['zt-sub'] }, ['an illustrative scenario, not a forecast']),
        ]),
        el('div', { className: ['panel', 'zt-zeros'] }, [
          el('div', { className: ['panel-bar'] }, [
            el('span', { className: ['panel-title'] }, ['milestones ', el('span', { className: ['count'], dataTkCount: '' })]),
          ]),
          el('div', { className: ['zt-rows'], dataTkRows: '' }),
        ]),
        el('div', { className: ['tk-bottom'], ariaHidden: 'true' }, [
          el('div', { dataTkCoord: '' }, ['■ 0000-00-00 // ppl 00.000']),
          el('div', { className: ['zt-meta'], dataTkMeta: '' }, ['SPEED ×1.0 · MILESTONES 0/0']),
          el('div', { className: ['tk-log'], dataTkLog: '' }, ['> steady scaling · waiting for takeoff']),
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
    el('ol', { className: ['sr-only'] }, listed.map((m) => el('li', {}, [`${m.date}, perplexity ${m.ppl}: ${m.text}`]))),
    caption ? el('figcaption', {}, [caption]) : null,
  ]);
}
