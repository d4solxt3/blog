/**
 * Reads /site.config.json (the file you edit) and fills in safe defaults.
 * You shouldn't need to change this file — edit site.config.json or use /_admin.
 */
import raw from '../site.config.json';

export type FontChoice = 'sans' | 'serif' | 'mono';
export const FONT_CHOICES: FontChoice[] = ['sans', 'serif', 'mono'];

type Link = { label: string; url: string };
type Todo = { text: string; done?: boolean };
type Update = { date: string; text: string };
type Progress = { label: string; percent: number };
const r = raw as Record<string, any>;

const asFont = (v: unknown): FontChoice => (FONT_CHOICES.includes(v as FontChoice) ? (v as FontChoice) : 'sans');
const str = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

// Older config files used siteTitle / tagline / author / profile.handle — still honoured.
const name = str(r.siteName ?? r.siteTitle, 'my notebook');
const subtitle = str(r.siteSubtitle ?? r.tagline, '');
const authorName = str(r.authorName ?? r.author ?? r.profile?.displayName, '');
const authorHandle = str(r.authorHandle ?? r.profile?.handle, 'anon').replace(/^@/, '');
const url = str(r.siteUrl, '').replace(/\/$/, '');
const frontpageImage = str(r.frontpageImage, '/images/frontpage-art.png');
const giscus = r.comments?.giscus ?? {};

const fill = (template: string) =>
  template
    .replace(/\{year\}/g, String(new Date().getFullYear()))
    .replace(/\{siteName\}/g, name)
    .replace(/\{authorName\}/g, authorName || name);

export const SITE = {
  name,
  subtitle,
  /** Kept for older components: same as `name`. */
  title: name,
  description: subtitle,
  authorName,
  authorHandle,
  /** Your public address, e.g. "https://my-notebook.net". Empty until you have one. */
  url,
  lang: str(r.language, 'en'),
  frontpageImage,
  invertArt: r.invertFrontpageImageInDarkMode !== false,
  defaultFont: asFont(r.defaultFont),
  accentBorders: r.accentBorders !== false,
  newBadgeDays: Number.isFinite(r.newBadgeDays) ? Number(r.newBadgeDays) : 21,
  inlineAnnotations: r.inlineAnnotations !== false,
  footerText: fill(str(r.footerText, '© {year} {siteName}')),
  intro: str(r.intro, subtitle),
  status: {
    mood: str(r.status?.mood, ''),
    thought: str(r.status?.thought, ''),
    updated: str(r.status?.updated, ''),
  },
  updates: list<Update>(r.updates).filter((u) => u && u.text),
  notice: str(r.notice, ''),
  todo: list<Todo>(r.todo).filter((t) => t && t.text),
  profile: {
    avatar: str(r.profile?.avatar, frontpageImage),
    status: str(r.profile?.status, 'online').toLowerCase(),
    joined: str(r.profile?.joined, ''),
    timezone: str(r.profile?.timezone, ''),
    interests: list<string>(r.profile?.interests),
    currently: {
      into: str(r.profile?.currently?.into, ''),
      reading: str(r.profile?.currently?.reading, ''),
      building: str(r.profile?.currently?.building, ''),
    },
    progress: list<Progress>(r.profile?.progress)
      .filter((p) => p && p.label)
      .map((p) => ({ label: p.label, percent: Math.max(0, Math.min(100, Math.round(Number(p.percent) || 0))) })),
    bio: list<string>(r.profile?.bio),
    links: list<Link>(r.profile?.links).filter((l) => l && l.label && l.url),
  },
  comments: {
    provider: (r.comments?.provider === 'giscus' ? 'giscus' : 'native') as 'native' | 'giscus',
  },
  giscus: {
    repo: str(giscus.repo, ''),
    repoId: str(giscus.repoId, ''),
    category: str(giscus.category, 'Comments'),
    categoryId: str(giscus.categoryId, ''),
    mapping: 'pathname',
    reactionsEnabled: true,
    inputPosition: 'top' as 'top' | 'bottom',
    lang: str(r.language, 'en'),
    customTheme: giscus.useCustomTheme !== false,
  },
} as const;
