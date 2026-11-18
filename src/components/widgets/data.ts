/**
 * What each front-page widget shows: its own props first, then the old
 * top-level config keys (so an empty "props" looks exactly like before).
 */
import { MEDIA_SRC, SITE, WIDGET_TYPES, type Widget } from '../../site.config';

type Link = { label: string; url: string };
const text = (v: unknown, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const arr = <T>(v: unknown, fallback: T[]): T[] => (Array.isArray(v) ? (v as T[]) : fallback);

/** Only http(s), mailto, and site-relative links. */
export const safeUrl = (u: unknown) => {
  const s = String(u ?? '').trim();
  return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(s) ? s : '';
};

export const widgetTitle = (w: Widget) => text(w.props.title, WIDGET_TYPES[w.type].label);

export function widgetData(w: Widget) {
  const p = w.props;
  const prof = SITE.profile;
  switch (w.type) {
    case 'about':
      return { text: text(p.text, SITE.intro) };
    case 'updates': {
      const items = arr<{ date: string; text: string }>(p.items, SITE.updates).filter((u) => u && u.text);
      const max = Number(p.max);
      return { items: Number.isFinite(max) && max > 0 ? items.slice(0, max) : items };
    }
    case 'now': {
      const currently = [
        ['reading', prof.currently.reading],
        ['building', prof.currently.building],
        ['into', prof.currently.into],
      ].filter(([, v]) => v);
      return { currently, has: !!(SITE.status.mood || SITE.status.thought || currently.length) };
    }
    case 'todo':
      return { items: arr<{ text: string; done?: boolean }>(p.items, SITE.todo).filter((t) => t && t.text) };
    case 'note':
      return { text: text(p.text, SITE.notice) };
    case 'text':
      return { paras: text(p.text).split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean) };
    case 'links':
      return { items: arr<Link>(p.items, prof.links).map((l) => ({ label: text(l?.label), url: safeUrl(l?.url) })).filter((l) => l.label && l.url) };
    case 'progress':
      return {
        items: arr<{ label: string; percent: number }>(p.items, prof.progress)
          .filter((x) => x && x.label)
          .map((x) => ({ label: String(x.label), percent: Math.max(0, Math.min(100, Math.round(Number(x.percent) || 0))) })),
      };
    case 'media': {
      const src = text(p.src);
      const ok = MEDIA_SRC.test(src) && !src.includes('..');
      const decorative = p.decorative === true;
      const alt = text(p.alt);
      return {
        src: ok && (alt || decorative) ? src : '',
        problem: !src ? 'add props.src (a file in /images/)' : !ok ? 'src must be a png, jpg, gif, webp, avif, mp4 or webm inside /images/' : !alt && !decorative ? 'add props.alt (or set decorative: true)' : '',
        alt: decorative ? '' : alt,
        caption: text(p.caption),
        // GIFs keep their own colours; everything else follows the theme unless tint is false.
        tint: p.tint !== false && !/\.gif$/i.test(src),
        href: safeUrl(p.href),
      };
    }
    default:
      return {};
  }
}

/** Boxes with nothing to show are left out (as the classic page always did). */
export function widgetHasContent(w: Widget): boolean {
  const d = widgetData(w) as any;
  switch (w.type) {
    case 'updates':
    case 'todo':
    case 'links':
    case 'progress':
      return d.items.length > 0;
    case 'now':
      return d.has;
    case 'note':
      return !!d.text;
    case 'text':
      return d.paras.length > 0;
    case 'media':
      // In dev a broken media box explains itself; on the live site it just hides.
      return !!d.src || (import.meta.env.DEV && !!d.problem);
    default:
      return true;
  }
}
