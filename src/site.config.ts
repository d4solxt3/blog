/**
 * Reads /site.config.json (the file you edit) and fills in safe defaults.
 * You shouldn't need to change this file — edit site.config.json or use /_admin.
 */
import { normalizeSiteUrl } from '../scripts/site-url.mjs';
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
const url = normalizeSiteUrl(r.siteUrl);
const frontpageImage = str(r.frontpageImage, '/images/frontpage-art.png');
const giscus = r.comments?.giscus ?? {};

/** Tab-title emoticon presets; "frames" in the config overrides the preset's frames. */
export const TAB_PRESETS: Record<string, string[]> = {
  kaomoji: ['(´･_･`)', '(´･ω･`)', '( •_•)>⌐■-■', '(⌐■_■)', '(ﾉ´ヮ`)ﾉ*:･ﾟ'],
  /** A signal moving down a residual stream. */
  stream: ['▸···', '·▸··', '··▸·', '···▸'],
  /** The same half-moon as the paper / cyber switch, turning. */
  moon: ['◐', '◓', '◑', '◒'],
  'cyber-hud': ['[▮    ]', '[▮▮   ]', '[▮▮▮  ]', '[▮▮▮▮ ]', '[▮▮▮▮▮]', '[ ok  ]'],
  'classic-blink': ['>>', '> ', '  '],
  off: [],
};

function tabAnimation(v: any) {
  const preset = typeof v?.preset === 'string' && v.preset in TAB_PRESETS ? v.preset : 'kaomoji';
  const custom = Array.isArray(v?.frames) ? v.frames.map(String).filter((f: string) => f.trim()) : [];
  const frames = custom.length ? custom : TAB_PRESETS[preset];
  const ms = Number(v?.intervalMs);
  return {
    enabled: v?.enabled !== false && preset !== 'off' && frames.length > 0,
    preset,
    intervalMs: Number.isFinite(ms) ? Math.min(10_000, Math.max(400, ms)) : 950,
    frames,
  };
}

const fill = (template: string) =>
  template
    .replace(/\{year\}/g, String(new Date().getFullYear()))
    .replace(/\{siteName\}/g, name)
    .replace(/\{authorName\}/g, authorName || name);

type BannerMode = 'dither-horizon' | 'wireframe' | 'image';
function bannerMode(v: unknown): BannerMode {
  const legacy: Record<string, BannerMode> = { sigil: 'dither-horizon', hud: 'wireframe', custom: 'image' };
  if (v === 'dither-horizon' || v === 'wireframe' || v === 'image') return v;
  return (typeof v === 'string' && legacy[v]) || 'dither-horizon';
}

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
  /** Text file with the front-page ASCII drawing (made by `npm run ascii`). */
  frontpageAscii: str(r.frontpageAscii, '/images/frontpage-ascii.txt'),
  invertArt: r.invertFrontpageImageInDarkMode !== false,
  /** "quiet" (default): only transitions move. "full": also the clock seconds, ticker,
   *  blinking cursor, rotating HUD ring and tab-title emoticons. Visitors can switch. */
  motion: (r.motion === 'full' ? 'full' : 'quiet') as 'quiet' | 'full',
  /** Article contents panel: true = it opens with each post, then tucks itself away after ~1s
   *  (unless the reader is using it); false = it starts closed. Readers can reopen it. */
  defaultShowToc: r.defaultShowToc !== false,
  /** Sidebar visual card: which view shows first ("image", "wireframe" or "ascii"); visitors can switch. */
  defaultVisualView: (['image', 'wireframe', 'ascii'].includes(r.defaultVisualView) ? r.defaultVisualView : 'image') as 'image' | 'wireframe' | 'ascii',
  /** Picture or GIF in the card's "image" view ("" = a built-in dithered sky). */
  sidebarImageUrl: str(r.sidebarImageUrl, ''),
  /** Tint the sidebar picture to the theme (off = full colour). */
  sidebarImageTint: r.sidebarImageTint !== false,
  /** Optional picture or GIF that replaces the built-in cube in the card's "wire" view. */
  sidebarWireUrl: str(r.sidebarWireUrl, ''),
  /** Tint that wire picture to the theme (off = its own colours). */
  sidebarWireTint: r.sidebarWireTint !== false,
  /** The wire picture has light lines on a dark background: flip it before tinting. */
  sidebarWireInvert: r.sidebarWireInvert === true,
  /** Masthead strip: "dither-horizon" (1-bit sky + halftone), "wireframe" (globe, oscilloscope, barcode) or "image" (customBannerUrl). */
  bannerMode: bannerMode(r.bannerMode),
  /** Image or looping GIF for bannerMode "image" (falls back to banner.image). */
  customBannerUrl: str(r.customBannerUrl, str(r.banner?.image, '')),
  /** The two words on the theme switch in the window bar (paper = the archival default, cyber = icy blue). */
  themeLabels: {
    paper: str(r.themeLabels?.paper, 'paper'),
    cyber: str(r.themeLabels?.cyber, 'cyber'),
  },
  /** Animated emoticons before the browser tab title (quiet and full; off for reduced motion; paused when the tab is hidden). */
  tabAnimation: tabAnimation(r.tabAnimation),
  /** Slim dithered strip under the nav on the hub pages. image "" = the built-in horizon. */
  banner: {
    show: r.banner?.show !== false,
    image: str(r.banner?.image, ''),
    alt: str(r.banner?.alt, ''),
  },
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
