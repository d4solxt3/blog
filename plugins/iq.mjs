// The "IQ, roughly" bar chart's data and markup, shared by the ```iq fence
// (plugins/remark-iq.mjs) and the studio preview. The animation is
// src/scripts/iq.ts; styles are the zeta figure's window (zeta-trace.css),
// the takeoff figure's readout strip (takeoff.css) and src/styles/iq.css.
//
// Frontier-AI scores up to 2026 are public Mensa Norway test results as
// reported by TrackingAI and the press (approximate). The test stops
// discriminating around 150 (every answer right is ~151), so later points,
// the cow and ASI are illustrative. ASI is drawn so that ASI : average human
// equals average human : cow.
import { el } from './charts.mjs';

/** Fixed bars, top to bottom. The first is the animal the analogy uses. */
export const REFERENCES = [
  { label: 'cow', value: 20 },
  { label: 'average human', value: 100 },
  { label: 'top human', value: 160 },
];

/** Where the test runs out. */
export const CEILING = 150;

/** Frontier AI over time: [decimal year, score, who, note]; `beyond` = past the test, `scenario` = not measured. */
export const AI = [
  { t: 2023.2, value: 85, who: 'GPT-4', note: 'below the average person' },
  { t: 2024.17, value: 101, who: 'Claude 3 Opus', note: 'the first model past the average person' },
  { t: 2024.7, value: 120, who: 'o1', note: 'thinking before answering: about +20 points' },
  { t: 2025.29, value: 136, who: 'o3', note: 'past ~98% of people: Mensa-level' },
  { t: 2025.96, value: 141, who: 'GPT-5.2 Thinking', note: 'past ~99.7% of people' },
  { t: 2026.2, value: 150, who: 'GPT-5.4 Pro', note: 'about 1 in 2,300 people score this high' },
  { t: 2026.71, value: 151, who: 'frontier models', note: 'every question right: the test is maxed out' },
  { t: 2026.87, value: 165, who: 'frontier models', beyond: true, note: 'proves the Riemann hypothesis, beyond what IQ tests can measure' },
  { t: 2027.0, value: 180, who: 'takeoff', scenario: true, note: 'AI now does most of the research on the next AI' },
  { t: 2027.49, value: 260, who: '', scenario: true, note: 'the other Millennium Prize problems fall' },
  { t: 2027.82, value: 400, who: '', scenario: true, note: 'can do almost any job that is done at a computer' },
  { t: 2027.92, value: 500, who: 'ASI', scenario: true, note: 'as far above us as we are above cows' },
];

/** Decimal year → "YYYY-MM". */
export function isoMonth(t) {
  const y = Math.floor(t);
  const a = Date.UTC(y, 0, 1);
  return new Date(a + (t - y) * (Date.UTC(y + 1, 0, 1) - a)).toISOString().slice(0, 7);
}

/** The figure as a hast element (data-iq marks it for the runtime). */
export function iqFigure(o = {}) {
  const title = o.title ? String(o.title) : 'iq_roughly';
  const caption = o.caption ? String(o.caption) : '';
  const asi = AI[AI.length - 1].value;
  return el('figure', { className: ['zt', 'iq'], dataIq: '', dataRefs: JSON.stringify(REFERENCES), dataAi: JSON.stringify(AI), dataCeiling: String(CEILING) }, [
    el('div', { className: ['panel', 'panel--primary', 'zt-win'] }, [
      el('div', { className: ['panel-bar'] }, [
        el('span', { className: ['panel-title'] }, [title]),
        el('span', { className: ['panel-tools'] }, [
          el('button', { type: 'button', className: ['shade-btn', 'bevel'], dataIqToggle: '', ariaPressed: 'false', ariaLabel: 'Pause animation', title: 'Pause' }, ['||']),
        ]),
      ]),
      el('div', { className: ['zt-stage'] }, [
        el('canvas', {
          className: ['zt-canvas'],
          role: 'img',
          ariaLabel: `A bar chart of IQ-style scores: a cow (about 20, illustrative), the average human (100), a top human (about 160), and frontier AI, which rises from about 85 in 2023 past the test's ceiling of about 150 in 2026, then, in an illustrative scenario, to about ${asi} by the end of 2027: as far above humans as humans are above cows. The values are listed below.`,
        }),
        el('div', { className: ['zt-heading'], ariaHidden: 'true' }, [
          el('div', { className: ['zt-big'] }, ['IQ, roughly']),
          el('div', { className: ['zt-sub'] }, ['AI on an IQ test vs people · the cow and ASI are illustrative']),
        ]),
        el('div', { className: ['tk-bottom'], ariaHidden: 'true' }, [
          el('div', { dataIqCoord: '' }, ['■ 0000-00 // frontier AI ≈ 000']),
          el('div', { className: ['zt-meta'], dataIqMeta: '' }, ['×0.00 AVERAGE HUMAN · ×0.00 TOP HUMAN']),
          el('div', { className: ['tk-log'], dataIqLog: '' }, ['> 2023 · frontier AI vs people']),
        ]),
      ]),
      el('div', { className: ['zt-foot'], ariaHidden: 'true' }, [
        el('span', { dataIqStatus: '' }),
        el('span', { className: ['zt-progress'] }, [
          el('span', { dataIqPct: '' }),
          el('span', { className: ['zt-track'] }, [el('span', { className: ['zt-fill'], dataIqFill: '' })]),
        ]),
      ]),
    ]),
    el('ol', { className: ['sr-only'] }, [
      ...REFERENCES.map((r) => el('li', {}, [`${r.label}: ${r.value}${r.label === 'cow' ? ' (illustrative)' : ''}`])),
      ...AI.map((p) => el('li', {}, [`${isoMonth(p.t)}, frontier AI${p.who ? ` (${p.who})` : ''}: ${p.beyond || p.scenario ? `about ${p.value}, illustrative` : `about ${p.value}`}. ${p.note}`])),
    ]),
    caption ? el('figcaption', {}, [caption]) : null,
  ]);
}
