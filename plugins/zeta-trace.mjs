// The ζ(½ + it) animation's markup, shared by the ```zeta fence
// (plugins/remark-zeta.mjs), the <ZetaTrace /> MDX component and the studio
// preview, so every route produces the same figure. The animation itself is
// src/scripts/zeta-trace.ts; the styles are src/styles/zeta-trace.css.
import { el } from './charts.mjs';

/** Fence/props options → clean values (unknown keys are ignored). */
export function zetaOptions(o = {}) {
  const t = Number(o.tMax ?? o.tmax ?? o.t);
  return {
    tMax: Math.min(100, Math.max(15, Number.isFinite(t) && t > 0 ? t : 50)),
    caption: o.caption ? String(o.caption) : '',
    title: o.title ? String(o.title) : 'riemann_zeta',
  };
}

/** The figure as a hast element (data-zeta-trace marks it for the runtime). */
export function zetaFigure(options) {
  const { tMax, caption, title } = zetaOptions(options);
  return el('figure', { className: ['zt'], dataZetaTrace: '', dataTmax: String(tMax) }, [
    el('div', { className: ['panel', 'panel--primary', 'zt-win'] }, [
      el('div', { className: ['panel-bar'] }, [
        el('span', { className: ['panel-title'] }, [title]),
        el('span', { className: ['panel-tools'] }, [
          el('button', { type: 'button', className: ['shade-btn', 'bevel'], dataZtToggle: '', ariaPressed: 'false', ariaLabel: 'Pause animation', title: 'Pause' }, ['||']),
        ]),
      ]),
      el('div', { className: ['zt-stage'] }, [
        el('canvas', {
          className: ['zt-canvas'],
          role: 'img',
          ariaLabel: `ζ(½ + it) traced in the complex plane for t from 0 to ${tMax}. The curve passes through the origin at each nontrivial zero.`,
        }),
        el('div', { className: ['zt-heading'], ariaHidden: 'true' }, [
          el('div', { className: ['zt-big'] }, ['ζ(½ + it)']),
          el('div', { className: ['zt-sub'] }, ['on the critical line']),
        ]),
        el('div', { className: ['panel', 'zt-zeros'] }, [
          el('div', { className: ['panel-bar'] }, [
            el('span', { className: ['panel-title'] }, ['zeros ', el('span', { className: ['count'], dataZtCount: '' })]),
          ]),
          el('div', { className: ['zt-rows'], dataZtRows: '' }),
        ]),
        el('div', { className: ['zt-hud'], ariaHidden: 'true' }, [
          el('div', { dataZtCoord: '' }, ['■ re −0.000 // im +0.000']),
          el('div', { className: ['zt-meta'], dataZtMeta: '' }, ['T 000.00 · ZEROS 00']),
        ]),
      ]),
      el('div', { className: ['zt-foot'], ariaHidden: 'true' }, [
        el('span', { dataZtStatus: '' }),
        el('span', { className: ['zt-progress'] }, [
          el('span', { dataZtPct: '' }),
          el('span', { className: ['zt-track'] }, [el('span', { className: ['zt-fill'], dataZtFill: '' })]),
        ]),
      ]),
    ]),
    caption ? el('figcaption', {}, [caption]) : null,
  ]);
}
