/**
 * Page widget types, the classic layouts, and the normaliser. Shared by the
 * site (src/site.config.ts, the pages) and the /_admin page editor, so they
 * can't drift. Two pages are built from widgets: home ("widgets" in
 * site.config.json) and about ("aboutWidgets").
 */
export type WidgetPage = 'home' | 'about';

/** pages: where a type can be added. pinned: always shown on that page (can move, not leave). */
export const WIDGET_TYPES = {
  about: { label: 'about', note: 'your intro and quick links', props: ['title', 'text'], pages: ['home'], pinned: ['home'] },
  feed: { label: 'writing', note: 'the post table', props: ['title'], pages: ['home'], pinned: ['home'] },
  hello: { label: 'hello', note: 'your bio (site settings → bio.txt)', props: ['title', 'text'], pages: ['about'], pinned: ['about'] },
  avatar: { label: 'avatar', note: 'your avatar picture (site settings → profile.txt)', props: ['title'], pages: ['home', 'about'], pinned: [] },
  profile: { label: 'profile', note: 'name, handle, status, timezone, since, post count', props: ['title'], pages: ['home', 'about'], pinned: [] },
  currently: { label: 'currently', note: 'into / reading / building (site settings → profile.txt)', props: ['title'], pages: ['home', 'about'], pinned: [] },
  interests: { label: 'interests', note: 'a list of interests', props: ['title', 'list'], pages: ['home', 'about'], pinned: [] },
  recent: { label: 'recently written', note: 'your newest posts', props: ['title', 'max'], pages: ['home', 'about'], pinned: [] },
  updates: { label: 'updates', note: 'dated log (site settings → front_page.txt)', props: ['title', 'max'], pages: ['home', 'about'], pinned: [] },
  now: { label: 'now', note: 'mood, current thought, reading/building', props: ['title'], pages: ['home', 'about'], pinned: [] },
  visual: { label: 'visual card', note: 'image / ascii viewer (site settings → look.cfg)', props: [], pages: ['home', 'about'], pinned: [] },
  info: { label: 'info', note: 'handle, status lamp, timezone, links', props: ['title'], pages: ['home', 'about'], pinned: [] },
  todo: { label: 'todo', note: 'checklist (site settings → front_page.txt)', props: ['title'], pages: ['home', 'about'], pinned: [] },
  note: { label: 'note', note: 'a short notice', props: ['title', 'text'], pages: ['home', 'about'], pinned: [] },
  calendar: { label: 'calendar', note: 'this month, with days you posted marked', props: ['title', 'weekStart'], pages: ['home', 'about'], pinned: [] },
  progress: { label: 'progress', note: 'progress bars (site settings → profile.txt)', props: ['title'], pages: ['home', 'about'], pinned: [] },
  links: { label: 'links', note: 'a list of links', props: ['title', 'items'], pages: ['home', 'about'], pinned: [] },
  text: { label: 'text', note: 'a free text box', props: ['title', 'text'], pages: ['home', 'about'], pinned: [] },
  media: { label: 'media', note: 'an image, GIF or short video from /images/', props: ['title', 'src', 'alt', 'decorative', 'caption', 'tint', 'href'], pages: ['home', 'about'], pinned: [] },
  stats: { label: 'stats', note: 'post / word / reading-time counters', props: ['title'], pages: ['home', 'about'], pinned: [] },
  badges: { label: 'buttons', note: '88×31 button rack (site settings → badges.txt)', props: ['title'], pages: ['home', 'about'], pinned: [] },
  audio: { label: 'loop.exe', note: 'a small music player for your own .mp3 / .ogg / .wav', props: ['title', 'src', 'track', 'loop'], pages: ['home', 'about'], pinned: [] },
} as const satisfies Record<string, { label: string; note: string; props: readonly string[]; pages: readonly WidgetPage[]; pinned: readonly WidgetPage[] }>;
export type WidgetType = keyof typeof WIDGET_TYPES;
export type WidgetArea = 'main' | 'side';
export type Widget = { id: string; type: WidgetType; area: WidgetArea; width: 'full' | 'half'; enabled: boolean; props: Record<string, any> };

export const CONFIG_KEY: Record<WidgetPage, string> = { home: 'widgets', about: 'aboutWidgets' };
export const isPinned = (type: WidgetType, page: WidgetPage) => (WIDGET_TYPES[type].pinned as readonly string[]).includes(page);
export const onPage = (type: WidgetType, page: WidgetPage) => (WIDGET_TYPES[type].pages as readonly string[]).includes(page);

const w = (id: string, type: WidgetType, area: WidgetArea, width: 'full' | 'half' = 'full', props: Record<string, any> = {}): Widget => ({ id, type, area, width, enabled: true, props });

/** The classic layout of each page (what you get with no saved widgets). */
export function legacyWidgets(page: WidgetPage = 'home'): Widget[] {
  if (page === 'about')
    return [
      w('avatar', 'avatar', 'side'),
      w('profile', 'profile', 'side'),
      w('elsewhere', 'links', 'side', 'full', { title: 'elsewhere' }),
      w('interests', 'interests', 'side'),
      w('about-buttons', 'badges', 'side'),
      w('hello', 'hello', 'main'),
      w('currently', 'currently', 'main', 'half'),
      w('checklist', 'todo', 'main', 'half', { title: 'checklist' }),
      w('progress', 'progress', 'main'),
      w('recent', 'recent', 'main'),
    ];
  return [
    w('about', 'about', 'main'),
    w('feed', 'feed', 'main'),
    w('updates', 'updates', 'main', 'half'),
    w('now', 'now', 'main', 'half'),
    w('visual', 'visual', 'side'),
    w('info', 'info', 'side'),
    w('todo', 'todo', 'side'),
    w('note', 'note', 'side'),
    w('buttons', 'badges', 'side'),
  ];
}

/** Clean up a saved list: known types for this page, unique ids, pinned boxes kept. */
export function normalizeWidgets(v: unknown, page: WidgetPage = 'home'): Widget[] {
  if (!Array.isArray(v)) return legacyWidgets(page);
  const seen = new Set<string>();
  const out: (Widget & { i: number; order: number })[] = [];
  v.forEach((x: any, i: number) => {
    if (!x || typeof x !== 'object' || !(x.type in WIDGET_TYPES) || !onPage(x.type, page)) return;
    const type = x.type as WidgetType;
    let id = String(x.id ?? type).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || type;
    for (let n = 2; seen.has(id); n++) id = `${String(x.id ?? type)}-${n}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    seen.add(id);
    const pinned = isPinned(type, page);
    const area: WidgetArea = pinned ? 'main' : x.area === 'main' ? 'main' : 'side';
    out.push({
      id,
      type,
      area,
      width: area === 'main' && x.width === 'half' ? 'half' : 'full',
      enabled: pinned || x.enabled !== false,
      props: x.props && typeof x.props === 'object' && !Array.isArray(x.props) ? x.props : {},
      i,
      order: Number.isFinite(Number(x.order)) ? Number(x.order) : i,
    });
  });
  // Pinned boxes can be moved but never lost.
  legacyWidgets(page)
    .filter((l) => isPinned(l.type, page) && !out.some((o) => o.type === l.type))
    .forEach((l, k) => out.push({ ...l, i: -1, order: -10 + k }));
  return out.sort((a, b) => a.order - b.order || a.i - b.i).map(({ i, order, ...rest }) => rest);
}

/** Local images only (no SVG, nothing remote): /images/name.ext */
export const MEDIA_SRC = /^\/images\/[a-z0-9._\/-]+\.(png|jpe?g|gif|webp|avif|mp4|webm)$/i;
