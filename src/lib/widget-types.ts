/**
 * Front-page widget types and the classic layout. Shared by the site
 * (src/site.config.ts) and the /_admin front-page editor, so neither can drift.
 */
export const WIDGET_TYPES = {
  about: { label: 'about', note: 'your intro and quick links (always shown)', props: ['title', 'text'] },
  feed: { label: 'writing', note: 'the post table (always shown)', props: ['title'] },
  updates: { label: 'updates', note: 'dated log; defaults to "updates"', props: ['title', 'max'] },
  now: { label: 'now', note: 'mood, current thought, reading/building', props: ['title'] },
  visual: { label: 'visual card', note: 'image / wire / ascii viewer', props: [] },
  info: { label: 'info', note: 'handle, status lamp, timezone, links', props: ['title'] },
  todo: { label: 'todo', note: 'checklist; defaults to "todo"', props: ['title'] },
  note: { label: 'note', note: 'a short notice; defaults to "notice"', props: ['title', 'text'] },
  calendar: { label: 'calendar', note: 'this month, with days you posted marked', props: ['title', 'weekStart'] },
  progress: { label: 'progress', note: 'beveled progress bars (profile.progress)', props: ['title'] },
  links: { label: 'links', note: 'a list of links', props: ['title', 'items'] },
  text: { label: 'text', note: 'a free text box', props: ['title', 'text'] },
  media: { label: 'media', note: 'an image, GIF or short video from /images/', props: ['title', 'src', 'alt', 'decorative', 'caption', 'tint', 'href'] },
  stats: { label: 'stats', note: 'post / word / reading-time counters', props: ['title'] },
  badges: { label: 'buttons', note: '88×31 button rack (edit the buttons in site settings → badges.txt)', props: ['title'] },
  audio: { label: 'loop.exe', note: 'a small music player for your own .mp3 / .ogg / .wav in /images/ or /audio/', props: ['title', 'src', 'track', 'loop'] },
} as const;
export type WidgetType = keyof typeof WIDGET_TYPES;
export type WidgetArea = 'main' | 'side';
export type Widget = { id: string; type: WidgetType; area: WidgetArea; width: 'full' | 'half'; enabled: boolean; props: Record<string, any> };

/** Today's front page, exactly as it was before widgets existed. */
export function legacyWidgets(): Widget[] {
  const w = (id: string, type: WidgetType, area: WidgetArea, width: 'full' | 'half' = 'full'): Widget => ({ id, type, area, width, enabled: true, props: {} });
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

/** Local images only (no SVG, nothing remote): /images/name.ext */
export const MEDIA_SRC = /^\/images\/[a-z0-9._\/-]+\.(png|jpe?g|gif|webp|avif|mp4|webm)$/i;

