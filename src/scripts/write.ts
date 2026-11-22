/**
 * The /write editor: a plain Markdown textarea that looks like the finished
 * post, plus:
 *  - "/" at the start of a line → block menu (headings, callouts, details,
 *    math, image/GIF, footnote); "[[" → link to another post;
 *  - a formatting bubble over selected text (and Ctrl/Cmd+B, I, E, K);
 *  - Ctrl/Cmd+Shift+F → footnote popover (adds [^n] and the note at the end);
 *  - paste or drop images/GIFs → uploaded, Markdown inserted, thumbnail shown
 *    beside the line;
 *  - every keystroke kept in localStorage; drafts saved to the server 2.5s
 *    after you stop typing; a "restore unsaved draft?" banner after a crash;
 *  - Ctrl/Cmd+P preview, Ctrl/Cmd+\ focus mode, Ctrl/Cmd+S save now.
 */

import { waitForLocalRelease } from './local-release';
import { initPreviews } from './previews';
import { initSpelling } from './studio-spelling';
import { initLatexStudio, type LatexStudioAPI } from './latex-studio';

type Fields = {
  title: string;
  subtitle: string;
  description: string;
  date: string;
  tags: string[];
  series: string;
  seriesOrder: number | null;
  pinned: boolean;
  font: '' | 'sans' | 'serif' | 'mono';
  draft: boolean;
  macros: string;
  bibliography: string;
  citationStyle: '' | 'numeric' | 'author-year';
};
type Doc = { slug: string; ext: 'md' | 'mdx'; fields: Fields; body: string; extra: Record<string, unknown> };
type Draft = Doc & { savedAt: number; basis: string | null };
type Data = {
  slug: string;
  mode: 'local' | 'github' | 'off';
  published: { doc: Doc; sha: string } | null;
  draft: Draft | null;
  siteFont: string;
  authorName?: string;
  globalMacros?: Record<string, string>;
  defaultCitationStyle?: 'numeric' | 'author-year';
  posts: { slug: string; title: string }[];
  meta: { tags: { name: string; count: number }[]; series: { name: string; parts: number; maxPart: number }[] };
};
type Local = { fields: Fields; body: string; basis: string | null; at: number; synced: boolean };
type Item = { label: string; hint?: string; run: () => void };

const DEV = import.meta.env.DEV;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'ctrl';
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const IMG_RE = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const SEL_START = '\u0001';
const SEL_END = '\u0002';

async function api(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...headers, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Error ${res.status}`), { status: res.status, field: data.field });
  return data;
}

// ---- chart snippets (pure, so they can be checked on their own) ----------------------
export type ChartSpec = { type: string; title: string; xLabel: string; yLabel: string; unit: string; caption: string; id: string; data: string };

/** "My Chart!" → "my-chart" (ids become #fig-<id> anchors). */
export const chartId = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

/** A YAML scalar: plain when that's safe, JSON-quoted (valid YAML) otherwise. */
const yamlValue = (v: string) =>
  /[:#,[\]{}]|^[\s'"!&*|>%@`?-]|\s$/.test(v) || /^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*)?\.?\d+(e[-+]?\d+)?)$/i.test(v) ? JSON.stringify(v) : v;

/** Pasted data, tidied: newlines normalised, common indent and blank edges removed. */
function chartData(raw: string) {
  const lines = raw.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0].length));
  return Number.isFinite(indent) ? lines.map((l) => l.slice(indent)) : [];
}

/** ```chart fence for .md posts. */
export function chartFence(s: ChartSpec) {
  const out = [`type: ${s.type || 'line'}`];
  if (s.title) out.push(`title: ${yamlValue(s.title)}`);
  if (s.caption) out.push(`caption: ${yamlValue(s.caption)}`);
  if (s.xLabel) out.push(`x: { label: ${yamlValue(s.xLabel)} }`);
  const y = [s.yLabel && `label: ${yamlValue(s.yLabel)}`, s.unit && `unit: ${yamlValue(s.unit)}`].filter(Boolean);
  if (y.length) out.push(`y: { ${y.join(', ')} }`);
  const data = chartData(s.data);
  if (data.length) {
    // A first line that's still indented needs an explicit indent, or YAML guesses wrong.
    out.push(/^\s/.test(data[0]) ? 'data: |2' : 'data: |', ...data.map((l) => (l ? `  ${l}` : '')));
  }
  const ticks = '`'.repeat(Math.max(3, ...[...s.data.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const id = chartId(s.id);
  return `${ticks}chart${id ? ` id=${id}` : ''}\n${out.join('\n')}\n${ticks}\n`;
}

/** <Chart … /> element for .mdx posts. */
export function chartMdx(s: ChartSpec) {
  const attr = (k: string, v: string) => (v ? ` ${k}="${v.replace(/"/g, '&quot;')}"` : '');
  const data = chartData(s.data).join('\n').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return (
    `<Chart${attr('type', s.type || 'line')}${attr('title', s.title)}${attr('caption', s.caption)}${attr('xLabel', s.xLabel)}` +
    `${attr('yLabel', s.yLabel)}${attr('unit', s.unit)}${attr('id', chartId(s.id))}${data ? ` data={\`${data}\`}` : ''} />\n`
  );
}

export function initWriter(signal: AbortSignal) {
  const studio = document.querySelector<HTMLElement>('[data-studio]');
  if (!studio) return;
  const root = studio;
  const data: Data = JSON.parse(root.querySelector('[data-studio-data]')?.textContent || '{}');
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const field = <T extends HTMLElement = HTMLInputElement>(name: string) => root.querySelector<T>(`[data-f="${name}"]`)!;
  const on = (el: EventTarget, type: string, fn: (e: any) => void) => el.addEventListener(type, fn, { signal });
  const coarse = () => window.matchMedia('(pointer: coarse)').matches;

  const ta = q<HTMLTextAreaElement>('[data-body]');
  const wrap = q('[data-wrap]');
  const gutter = q('[data-gutter]');
  const preview = q('[data-preview]');
  const statusEl = q('[data-status]');
  const msgEl = q('[data-msg]');
  const meta = q('[data-meta]');
  const fileInput = q<HTMLInputElement>('[data-file]');
  const dropEl = q('[data-drop]');
  const publishBtn = q<HTMLButtonElement>('[data-act="publish"]');
  const metaBtn = q('[data-act="meta"]');
  const keysBtn = q('[data-act="keys"]');
  const keysPanel = q('[data-keys]');
  const pubEl = q('[data-pubstate]');
  const localEl = q('[data-local]');
  const tagPicks = q('[data-tag-picks]');
  const seriesPicks = q('[data-series-picks]');
  const subtitle = field<HTMLTextAreaElement>('subtitle');
  const slug = data.slug;
  let latexStudio: LatexStudioAPI | null = null;
  if (MOD === '⌘') root.querySelectorAll('[data-mod]').forEach((dt) => (dt.textContent = (dt.textContent ?? '').replace(/^ctrl/, '⌘')));

  // ---- which version to open ----------------------------------------------
  const pubSha = data.published?.sha ?? null;
  let basis: string | null = pubSha;
  let serverSavedAt = 0;
  let doc: Doc;
  let older: Draft | null = null;
  if (data.draft && (data.draft.basis === pubSha || !data.published)) {
    doc = data.draft;
    serverSavedAt = data.draft.savedAt;
  } else {
    doc = data.published!.doc;
    older = data.draft;
  }
  let ext = doc.ext;
  const extra = doc.extra ?? {};
  /** What's in the published post file right now (null = never published). */
  let publishedDoc: { fields: Fields; body: string } | null = data.published ? { fields: data.published.doc.fields, body: data.published.doc.body } : null;

  // ---- fields ---------------------------------------------------------------
  function collect(): Fields {
    const order = field('seriesOrder').value.trim();
    return {
      title: field('title').value,
      subtitle: field('subtitle').value,
      description: field<HTMLTextAreaElement>('description').value,
      date: field('date').value,
      tags: field('tags')
        .value.split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      series: field('series').value,
      seriesOrder: order === '' || !Number.isFinite(Number(order)) ? null : Number(order),
      pinned: field('pinned').checked,
      font: field<HTMLSelectElement>('font').value as Fields['font'],
      draft: !q<HTMLInputElement>('[data-f="draft"][value="published"]').checked,
      macros: field<HTMLTextAreaElement>('macros').value,
      bibliography: field<HTMLTextAreaElement>('bibliography').value,
      citationStyle: field<HTMLSelectElement>('citationStyle').value as Fields['citationStyle'],
    };
  }

  /** `undoable`: put the new text in through the browser's undo stack (restore banners). */
  function fill(f: Fields, body: string, undoable = false) {
    field('title').value = f.title;
    subtitle.value = f.subtitle;
    field<HTMLTextAreaElement>('description').value = f.description;
    field('tags').value = f.tags.join(', ');
    field('date').value = f.date;
    field('series').value = f.series;
    field('seriesOrder').value = f.seriesOrder === null ? '' : String(f.seriesOrder);
    field<HTMLSelectElement>('font').value = f.font;
    field<HTMLSelectElement>('citationStyle').value = f.citationStyle ?? '';
    field<HTMLTextAreaElement>('macros').value = f.macros ?? '';
    field<HTMLTextAreaElement>('bibliography').value = f.bibliography ?? '';
    root.querySelectorAll<HTMLInputElement>('[data-f="draft"]').forEach((r) => (r.checked = (r.value === 'draft') === f.draft));
    field('pinned').checked = f.pinned;
    if (undoable && ta.value !== body) {
      const y = window.scrollY;
      ta.focus({ preventScroll: true });
      replace(0, ta.value.length, body, 0, 0);
      window.scrollTo({ top: y, behavior: 'instant' });
    } else ta.value = body;
    applyFont();
    syncPublishLabel();
    autosize();
    queueGutter();
    renderPicks();
    refreshSpelling?.();
    latexStudio?.handleInput();
  }

  // ---- existing tags & series ------------------------------------------------------
  const tagList = () =>
    field('tags')
      .value.split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  const currentToken = () => (field('tags').value.split(',').pop() ?? '').trim().toLowerCase();

  function setTags(tags: string[]) {
    field('tags').value = tags.length ? `${tags.join(', ')}, ` : '';
    renderPicks();
    edited();
  }

  function renderPicks() {
    const active = new Set(tagList().map((t) => t.toLowerCase()));
    const token = currentToken();
    const typing = token && !active.has(token);
    tagPicks.replaceChildren(
      ...data.meta.tags.map((t) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pick';
        b.dataset.tag = t.name;
        b.setAttribute('aria-pressed', String(active.has(t.name.toLowerCase())));
        if (typing && t.name.toLowerCase().startsWith(token)) b.classList.add('is-match');
        b.innerHTML = `#${esc(t.name)} <span class="n">(${t.count})</span>`;
        return b;
      }),
    );
    const series = field('series').value.trim();
    seriesPicks.replaceChildren(
      ...data.meta.series.map((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pick';
        b.dataset.series = s.name;
        b.setAttribute('aria-pressed', String(series === s.name));
        b.innerHTML = `${esc(s.name)} <span class="n">(${s.parts} ${s.parts === 1 ? 'part' : 'parts'})</span>`;
        return b;
      }),
    );
    // Suggest the next part number without filling it in.
    const known = data.meta.series.find((s) => s.name === series);
    field('seriesOrder').placeholder = known ? `next: ${known.maxPart + 1}` : '';
  }

  on(tagPicks, 'click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tag]');
    if (!b) return;
    const name = b.dataset.tag!;
    const tags = tagList();
    const i = tags.findIndex((t) => t.toLowerCase() === name.toLowerCase());
    if (i >= 0) tags.splice(i, 1);
    else {
      // A half-typed tag that this one completes gets replaced by it.
      const last = tags.at(-1)?.toLowerCase() ?? '';
      const typing = last && !/,\s*$/.test(field('tags').value) && !data.meta.tags.some((t) => t.name.toLowerCase() === last);
      if (typing && name.toLowerCase().startsWith(last)) tags.pop();
      tags.push(name);
    }
    setTags(tags);
  });

  // Typing a tag: Enter completes it from the first matching existing tag.
  on(field('tags'), 'keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const token = currentToken();
    const match = token && data.meta.tags.find((t) => t.name.toLowerCase().startsWith(token));
    const tags = tagList();
    if (match) setTags([...tags.slice(0, -1).filter((t) => t.toLowerCase() !== match.name.toLowerCase()), match.name]);
    else setTags(tags);
  });

  // Picking an existing series fills the next part number only if it's empty.
  on(seriesPicks, 'click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-series]');
    if (!b) return;
    const s = data.meta.series.find((x) => x.name === b.dataset.series);
    if (!s) return;
    field('series').value = s.name;
    if (!field('seriesOrder').value.trim()) field('seriesOrder').value = String(s.maxPart + 1);
    renderPicks();
    edited();
  });

  // ---- save states ------------------------------------------------------------------
  const norm = (f: Fields, body: string) =>
    JSON.stringify([
      f.title.trim(),
      f.subtitle.trim(),
      f.description.trim(),
      f.date,
      f.tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
      f.series.trim(),
      f.series.trim() ? f.seriesOrder : null,
      f.pinned,
      f.font,
      f.draft,
      (f.macros ?? '').trim(),
      (f.bibliography ?? '').trim(),
      f.citationStyle ?? '',
      body.replace(/\s+$/, ''),
    ]);

  function renderState() {
    const local = readLocal();
    localEl.hidden = !(local && !local.synced);
    if (!publishedDoc) {
      pubEl.textContent = 'not published yet';
      pubEl.dataset.state = 'new';
    } else if (norm(collect(), ta.value) === norm(publishedDoc.fields, publishedDoc.body)) {
      pubEl.textContent = data.mode === 'github' ? 'same as the committed version' : 'same as the post file';
      pubEl.dataset.state = 'same';
    } else {
      pubEl.textContent = 'unpublished changes';
      pubEl.dataset.state = 'changed';
    }
  }

  const snapshot = () => JSON.stringify([collect(), ta.value]);

  function applyFont() {
    document.documentElement.dataset.font = field<HTMLSelectElement>('font').value || data.siteFont;
  }

  function syncPublishLabel() {
    const draft = collect().draft;
    const label = draft ? (data.mode === 'local' ? 'save file' : 'commit draft') : 'publish';
    publishBtn.innerHTML = `<span class="br" aria-hidden="true">[ </span>${label}<span class="br" aria-hidden="true"> ]</span>`;
    publishBtn.title = data.mode === 'off' ? 'Check the publishing connection in settings' : draft
      ? 'Saves the post with draft: true (hidden on the live site)'
      : data.mode === 'github'
        ? 'Publishes this version on heartcache.xyz'
        : 'Deploys the post to heartcache.xyz';
  }

  function setStatus(text: string, state: 'saved' | 'saving' | 'edited' | 'error' = 'saved') {
    statusEl.textContent = text;
    statusEl.dataset.state = state;
    const pane = root.querySelector<HTMLElement>('[data-pane-status]');
    if (pane) {
      pane.textContent = state === 'saved' ? 'saved' : text;
      pane.dataset.state = state;
    }
  }

  function say(html: string | null) {
    msgEl.hidden = !html;
    msgEl.innerHTML = html ?? '';
  }

  // ---- crash buffer (localStorage) -------------------------------------------
  const LS = `write:${slug}`;
  const readLocal = (): Local | null => {
    try {
      return JSON.parse(localStorage.getItem(LS) || 'null');
    } catch {
      return null;
    }
  };
  const writeLocal = (synced: boolean) => {
    try {
      const entry: Local = { fields: collect(), body: ta.value, basis, at: Date.now(), synced };
      localStorage.setItem(LS, JSON.stringify(entry));
    } catch {}
  };
  const dropLocal = () => {
    try {
      localStorage.removeItem(LS);
    } catch {}
  };

  // ---- autosave to the server ------------------------------------------------
  let timer = 0;
  let saving = false;
  let lastSaved = '';
  const savedLabel = () => (serverSavedAt ? `draft saved ${hhmm(serverSavedAt)}` : 'no draft changes');
  const payload = () => ({ slug, ext, extra, basis, fields: collect(), body: ta.value });
  // Nothing is saved (server draft, page-leave flush, browser backup) until the
  // post has actually been loaded into the editor. If setup ever fails part-way,
  // leaving the page must not save a blank editor over the real post.
  let ready = false;
  /** A blank editor (no title, no text) never replaces a post that has content. */
  const blankOverReal = () => !ta.value.trim() && !field('title').value.trim() && !!(publishedDoc?.body.trim() || doc.body.trim());

  function edited() {
    if (!ready) return;
    writeLocal(false);
    clearTimeout(timer);
    renderState();
    if (snapshot() === lastSaved) return setStatus(savedLabel());
    setStatus('not saved yet', 'edited');
    timer = window.setTimeout(save, 2500);
  }

  async function save(): Promise<void> {
    clearTimeout(timer);
    if (!ready || blankOverReal()) return;
    const snap = snapshot();
    if (snap === lastSaved) return;
    if (saving) {
      timer = window.setTimeout(save, 600);
      return;
    }
    saving = true;
    setStatus('saving…', 'saving');
    try {
      const r = await api('/api/write/post', 'PUT', payload());
      lastSaved = snap;
      serverSavedAt = r.savedAt;
      if (snapshot() === snap) writeLocal(true);
      setStatus(savedLabel());
    } catch (err) {
      const code = (err as { status?: number }).status;
      if (code === 410) {
        setStatus('post deleted · edits only in this browser', 'error');
        return;
      }
      setStatus(code === 401 ? 'server: signed out' : 'server: offline', 'error');
      timer = window.setTimeout(save, 10_000);
    } finally {
      saving = false;
      renderState();
    }
  }

  // Leaving the page with unsaved edits: send them on the way out.
  const flush = () => {
    if (!ready || blankOverReal() || snapshot() === lastSaved) return;
    writeLocal(false);
    const body = JSON.stringify(payload());
    fetch('/api/write/post', { method: 'PUT', keepalive: body.length < 60_000, headers: { 'content-type': 'application/json' }, body }).catch(() => {});
  };
  on(window, 'pagehide', flush);
  on(document, 'astro:before-preparation', flush);

  // [ view as published ↗ ]: save what's typed, then show the post in the
  // real article layout in its own tab (one tab, refreshed on each click).
  // The tab is opened right away, inside the click, so pop-up blockers allow it.
  const viewBtn = root.querySelector<HTMLButtonElement>('[data-act="view"]');
  if (viewBtn)
    on(viewBtn, 'click', async () => {
      const href = viewBtn.dataset.viewHref!;
      const tab = window.open('', `heartcache-preview-${slug}`);
      try {
        await save();
        // A save already in flight: wait for it to land.
        for (let i = 0; i < 40 && saving; i++) await new Promise((r) => setTimeout(r, 100));
      } catch {}
      if (tab) tab.location.href = href;
      else window.location.href = href;
    });

  // ---- textarea helpers ---------------------------------------------------------
  const nativeSizing = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');
  function autosize() {
    if (nativeSizing) return;
    const y = window.scrollY;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    window.scrollTo(0, y);
  }

  function afterEdit() {
    autosize();
    edited();
    queueGutter();
  }

  /** Replace [start, end) with text, keeping the browser's undo history where possible. */
  function replace(start: number, end: number, text: string, selStart = start + text.length, selEnd = selStart) {
    if (start === end && !text) return;
    const focused = document.activeElement === ta;
    let ok = false;
    if (focused) {
      ta.setSelectionRange(start, end);
      try {
        ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
      } catch {}
      ok = ok && ta.value.slice(start, start + text.length) === text;
    }
    if (!ok) {
      ta.setRangeText(text, start, end, 'end');
      afterEdit();
    }
    ta.setSelectionRange(selStart, selEnd);
  }

  // Caret position (relative to the editor box), measured with a hidden copy of the text.
  const mirror = document.createElement('div');
  mirror.className = 'w-mirror';
  mirror.setAttribute('aria-hidden', 'true');
  wrap.append(mirror);
  function caret(pos: number) {
    mirror.style.top = `${ta.offsetTop}px`;
    mirror.style.left = `${ta.offsetLeft}px`;
    mirror.style.width = `${ta.clientWidth}px`;
    mirror.textContent = ta.value.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = `${ta.value.slice(pos).match(/^\S*/)?.[0] ?? ''}​`;
    mirror.append(mark);
    const h = parseFloat(getComputedStyle(ta).lineHeight) || 26;
    return { x: ta.offsetLeft + mark.offsetLeft, y: ta.offsetTop + mark.offsetTop, h };
  }

  function place(el: HTMLElement, x: number, y: number) {
    el.hidden = false;
    el.style.left = `${Math.max(0, Math.min(x, wrap.clientWidth - el.offsetWidth))}px`;
    el.style.top = `${y}px`;
  }

  // ---- menus: "/" blocks and "[[" links -------------------------------------------
  const makePop = (cls: string) => {
    const el = document.createElement('div');
    el.className = `w-pop ${cls}`;
    el.hidden = true;
    wrap.append(el);
    return el;
  };
  const slashEl = makePop('w-slash');
  const wikiEl = makePop('w-wiki');
  let menu: { el: HTMLElement; items: Item[]; active: number } | null = null;

  function openMenu(el: HTMLElement, head: string, items: Item[], at: number) {
    latexStudio?.closePopups();
    if (menu && menu.el !== el) menu.el.hidden = true;
    el.innerHTML =
      `<div class="w-pop-head">${esc(head)}</div>` +
      (items.length
        ? `<ul role="listbox" aria-label="${esc(head)}">${items
            .map(
              (it, i) =>
                `<li role="option" data-i="${i}" aria-selected="${i === 0}"><span>${esc(it.label)}</span>${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}</li>`,
            )
            .join('')}</ul>`
        : '<p class="empty">no matches</p>');
    const c = caret(at);
    place(el, c.x, c.y + c.h + 2);
    menu = { el, items, active: 0 };
  }

  function closeMenu() {
    if (menu) menu.el.hidden = true;
    menu = null;
  }

  function moveMenu(step: number) {
    if (!menu?.items.length) return;
    const m = menu;
    m.active = (m.active + step + m.items.length) % m.items.length;
    m.el.querySelectorAll('li').forEach((li, i) => {
      li.setAttribute('aria-selected', String(i === m.active));
      if (i === m.active) li.scrollIntoView({ block: 'nearest' });
    });
  }

  function pickMenu(i = menu?.active ?? 0) {
    const item = menu?.items[i];
    closeMenu();
    item?.run();
  }

  for (const el of [slashEl, wikiEl]) {
    on(el, 'mousedown', (e: MouseEvent) => e.preventDefault());
    on(el, 'click', (e: MouseEvent) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
      if (li) pickMenu(Number(li.dataset.i));
    });
  }

  const lineStartOf = (pos: number) => ta.value.lastIndexOf('\n', pos - 1) + 1;

  function insertTemplate(start: number, end: number, tpl: string) {
    const a = tpl.indexOf(SEL_START);
    const b = tpl.indexOf(SEL_END);
    const clean = tpl.replace(/[\u0001\u0002]/g, '');
    const s = a < 0 ? clean.length : a;
    const e = b < 0 ? s : b - 1;
    replace(start, end, clean, start + s, start + e);
  }

  // ---- one command list --------------------------------------------------------------
  // The "/" menu, the formatting ribbon, the selection bubble and keyboard
  // shortcuts all run the same command objects, so they can never disagree.
  type Via = 'slash' | 'ribbon' | 'key' | 'bubble';
  type Cmd = {
    id: string;
    label: string;
    icon: string;
    keys: string;
    hint?: string;
    /** "mod+b", "mod+shift+f", "mod+alt+2" — mod is Ctrl, or ⌘ on a Mac. */
    shortcut?: string;
    /** main = always on the ribbon; more = in the "more" menu. */
    ribbon?: 'main' | 'more';
    /** main-row buttons that stay visible on phones (the rest move into "more"). */
    phone?: boolean;
    slash?: boolean;
    run: (via: Via) => void;
  };

  const lineEndOf = (pos: number) => {
    const i = ta.value.indexOf('\n', pos);
    return i < 0 ? ta.value.length : i;
  };

  /** Drop the "/query" the slash menu was opened with. */
  function clearSlash() {
    const pos = ta.selectionStart;
    const start = lineStartOf(pos);
    if (/^\/[\w;$<-]*$/.test(ta.value.slice(start, pos))) replace(start, pos, '');
  }

  /** Insert a block template on its own line (the current one if it's empty). */
  function blockInsert(tpl: string, via: Via) {
    if (via === 'slash') {
      const pos = ta.selectionStart;
      return insertTemplate(lineStartOf(pos), pos, tpl);
    }
    const { selectionStart: s, selectionEnd: e } = ta;
    const ls = lineStartOf(s);
    const le = lineEndOf(e);
    if (s === e && !ta.value.slice(ls, le).trim()) return insertTemplate(ls, le, tpl);
    insertTemplate(le, le, `\n\n${tpl}`);
  }

  function jumpToLine(line: number) {
    if (layout === 'preview') setLayout(editLayout());
    let off = 0;
    for (let n = 1; n < line; n++) {
      const i = ta.value.indexOf('\n', off);
      if (i < 0) break;
      off = i + 1;
    }
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(off, off);
    const y = wrap.getBoundingClientRect().top + window.scrollY + caret(off).y;
    window.scrollTo({ top: Math.max(0, y - stickyTop() - window.innerHeight / 4), behavior: 'instant' });
  }

  /** Rewrite the selected lines (or the caret's line), keeping the caret on its line. */
  function editLines(transform: (lines: string[]) => string[]) {
    const { selectionStart: s, selectionEnd: e } = ta;
    const start = lineStartOf(s);
    const end = lineEndOf(e > s && ta.value[e - 1] === '\n' ? e - 1 : e);
    const before = ta.value.slice(start, end).split('\n');
    const after = transform(before);
    const out = after.join('\n');
    if (s === e && before.length === 1) {
      const col = Math.max(0, Math.min(after[0].length, s - start + after[0].length - before[0].length));
      replace(start, end, out, start + col);
    } else replace(start, end, out, start, start + out.length);
  }

  function heading(level: number, via: Via) {
    if (via === 'slash') clearSlash();
    const prefix = `${'#'.repeat(level)} `;
    editLines((lines) => {
      const all = lines.every((l) => l.startsWith(prefix) && !l.startsWith(`${prefix}#`));
      return lines.map((l) => {
        const bare = l.replace(/^#{1,6}\s+/, '');
        return all ? bare : `${prefix}${bare}`;
      });
    });
  }

  function list(kind: 'ul' | 'ol', via: Via) {
    if (via === 'slash') clearSlash();
    const marker = kind === 'ul' ? /^(\s*)[-*+]\s+/ : /^(\s*)\d+[.)]\s+/;
    editLines((lines) => {
      // An empty line just starts a list.
      if (lines.every((l) => !l.trim())) return [kind === 'ul' ? '- ' : '1. ', ...lines.slice(1)];
      const all = lines.every((l) => marker.test(l) || !l.trim());
      let n = 0;
      return lines.map((l) => {
        if (!l.trim()) return l;
        const bare = l.replace(/^(\s*)([-*+]|\d+[.)])\s+/, '$1');
        if (all) return bare;
        n += 1;
        const indent = bare.match(/^\s*/)![0];
        return `${indent}${kind === 'ul' ? '-' : `${n}.`} ${bare.slice(indent.length)}`;
      });
    });
  }

  function quoteLines(via: Via) {
    if (via === 'slash') clearSlash();
    editLines((lines) => {
      const quoted = lines.every((l) => l.startsWith('>'));
      return lines.map((l) => (quoted ? l.replace(/^> ?/, '') : `> ${l}`));
    });
  }

  function makeLink() {
    const { selectionStart: s, selectionEnd: e } = ta;
    const text = ta.value.slice(s, e).trim();
    if (/^https?:\/\/\S+$/.test(text)) replace(s, e, `[link text](${text})`, s + 1, s + 10);
    else {
      const label = text || 'link text';
      const url = s + label.length + 3;
      replace(s, e, `[${label}](https://)`, url, url + 8);
    }
  }

  const CMDS: Cmd[] = [
    { id: 'bold', label: 'bold', icon: 'B', keys: 'bold strong', shortcut: 'mod+b', ribbon: 'main', phone: true, run: () => wrapSelection('**', '**', 'bold text') },
    { id: 'italic', label: 'italic', icon: 'I', keys: 'italic emphasis', shortcut: 'mod+i', ribbon: 'main', phone: true, run: () => wrapSelection('*', '*', 'italic text') },
    { id: 'link', label: 'link', icon: 'link', keys: 'link url', shortcut: 'mod+k', ribbon: 'main', phone: true, run: makeLink },
    { id: 'h2', label: 'H2 subtitle', icon: 'H2', keys: 'h2 heading subtitle', hint: '##', shortcut: 'mod+alt+2', ribbon: 'main', phone: true, slash: true, run: (via) => heading(2, via) },
    { id: 'h3', label: 'H3 sub-subtitle', icon: 'H3', keys: 'h3 heading', hint: '###', shortcut: 'mod+alt+3', ribbon: 'main', slash: true, run: (via) => heading(3, via) },
    { id: 'ul', label: 'bulleted list', icon: '•', keys: 'list bullet unordered ul', hint: '-', shortcut: 'mod+shift+8', ribbon: 'main', phone: true, slash: true, run: (via) => list('ul', via) },
    { id: 'ol', label: 'numbered list', icon: '1.', keys: 'list numbered ordered ol', hint: '1.', shortcut: 'mod+shift+7', ribbon: 'main', slash: true, run: (via) => list('ol', via) },
    { id: 'quote', label: 'quote', icon: '“', keys: 'quote blockquote', hint: '>', ribbon: 'main', phone: true, slash: true, run: (via) => quoteLines(via) },
    { id: 'code', label: 'inline code', icon: '</>', keys: 'code inline', ribbon: 'main', run: () => wrapSelection('`', '`', 'code') },
    { id: 'math', label: 'inline math $', icon: '$', keys: 'math inline latex', shortcut: 'mod+m', ribbon: 'main', phone: true, run: () => wrapSelection('$', '$', 'x^2') },
    { id: 'mathblock', label: 'Math block $$', icon: '$$', keys: 'math equation latex block display', shortcut: 'mod+shift+m', ribbon: 'main', slash: true, run: (via) => blockInsert(`$$\n${SEL_START}${SEL_END}\n$$\n`, via) },
    { id: 'math-palette', label: 'math symbols & environments', icon: 'Σ', keys: 'math symbols palette greek latex', ribbon: 'main', phone: true, run: () => latexStudio?.togglePalette() },
    { id: 'footnote', label: 'footnote', icon: 'fn', keys: 'footnote note', shortcut: 'mod+shift+f', ribbon: 'main', slash: true, run: (via) => (via === 'slash' && clearSlash(), openFootnote()) },
    { id: 'image', label: 'image / GIF', icon: 'img', keys: 'image gif picture upload', hint: 'upload', ribbon: 'main', phone: true, slash: true, run: (via) => (via === 'slash' && clearSlash(), pickFile()) },
    { id: 'chart', label: 'chart', icon: 'chart', keys: 'chart graph plot data csv line bar area scatter', hint: 'from data', ribbon: 'main', phone: true, slash: true, run: (via) => openChart(via) },
    {
      id: 'equation',
      label: 'Equation (numbered)',
      icon: 'eq',
      keys: 'equation numbered latex math label',
      hint: '\\begin{equation}',
      ribbon: 'more',
      slash: true,
      run: (via) => blockInsert(`\\begin{equation}\n\\label{eq:${SEL_START}name${SEL_END}}\n\n\\end{equation}\n`, via),
    },
    {
      id: 'align',
      label: 'Align equations',
      icon: 'align',
      keys: 'align equations multiline latex math',
      hint: '\\begin{align}',
      ribbon: 'more',
      slash: true,
      run: (via) => blockInsert(`\\begin{align}\n${SEL_START}a &= b${SEL_END} \\\\\n  &= c\n\\end{align}\n`, via),
    },
    {
      id: 'cases',
      label: 'Cases (piecewise)',
      icon: '{…',
      keys: 'cases piecewise function latex math',
      hint: '\\begin{cases}',
      slash: true,
      run: (via) => blockInsert(`$$\nf(x) = \\begin{cases}\n  ${SEL_START}x${SEL_END}, & x \\ge 0 \\\\\n  -x, & x < 0\n\\end{cases}\n$$\n`, via),
    },
    {
      id: 'matrix',
      label: 'Matrix builder (matrix.exe)',
      icon: '[M]',
      keys: 'matrix pmatrix bmatrix array vector latex',
      hint: 'matrix.exe',
      ribbon: 'more',
      slash: true,
      run: (via) => {
        if (via === 'slash') clearSlash();
        latexStudio?.openMatrixBuilder(via);
      },
    },
    {
      id: 'theorem',
      label: 'Theorem',
      icon: 'Thm',
      keys: 'theorem math arxiv env',
      hint: '\\begin{theorem}',
      ribbon: 'more',
      slash: true,
      run: (via) => blockInsert(`\\begin{theorem}[${SEL_START}Title${SEL_END}]\n\\label{thm:name}\nStatement here.\n\\end{theorem}\n`, via),
    },
    {
      id: 'lemma',
      label: 'Lemma',
      icon: 'Lem',
      keys: 'lemma math arxiv env',
      hint: '\\begin{lemma}',
      slash: true,
      run: (via) => blockInsert(`\\begin{lemma}[${SEL_START}Title${SEL_END}]\n\\label{lem:name}\nStatement here.\n\\end{lemma}\n`, via),
    },
    {
      id: 'definition',
      label: 'Definition',
      icon: 'Def',
      keys: 'definition math arxiv env',
      hint: '\\begin{definition}',
      slash: true,
      run: (via) => blockInsert(`\\begin{definition}[${SEL_START}Term${SEL_END}]\n\\label{def:name}\nDefinition here.\n\\end{definition}\n`, via),
    },
    {
      id: 'proposition',
      label: 'Proposition',
      icon: 'Prop',
      keys: 'proposition math arxiv env',
      hint: '\\begin{proposition}',
      slash: true,
      run: (via) => blockInsert(`\\begin{proposition}[${SEL_START}Title${SEL_END}]\n\\label{prop:name}\nStatement here.\n\\end{proposition}\n`, via),
    },
    {
      id: 'proof',
      label: 'Proof',
      icon: '∎',
      keys: 'proof qed math arxiv env',
      hint: '\\begin{proof}',
      ribbon: 'more',
      slash: true,
      run: (via) => blockInsert(`\\begin{proof}\n${SEL_START}Proof goes here.${SEL_END}\n\\end{proof}\n`, via),
    },
    {
      id: 'algorithm',
      label: 'Algorithm (pseudocode)',
      icon: 'Alg',
      keys: 'algorithm pseudocode procedure arxiv env',
      hint: '\\begin{algorithm}',
      ribbon: 'more',
      slash: true,
      run: (via) =>
        blockInsert(
          `\\begin{algorithm}[${SEL_START}Algorithm Title${SEL_END}]\n\\label{alg:name}\nInput: $x \\in \\R^d$\nOutput: $y$\nfor $t = 1, \\dots, T$ do\n  $x \\gets x - \\eta \\nabla f(x)$\nreturn $x$\n\\end{algorithm}\n`,
          via,
        ),
    },
    {
      id: 'bib',
      label: 'BibTeX references',
      icon: 'bib',
      keys: 'bib bibtex citations references literature',
      hint: 'drawer',
      slash: true,
      run: (via) => {
        if (via === 'slash') clearSlash();
        latexStudio?.toggleBibMacros('bib', true);
      },
    },
    {
      id: 'macros',
      label: 'LaTeX preamble macros',
      icon: '\\def',
      keys: 'macros newcommand preamble operator latex',
      hint: 'drawer',
      slash: true,
      run: (via) => {
        if (via === 'slash') clearSlash();
        latexStudio?.toggleBibMacros('macros', true);
      },
    },
    { id: 'tldr', label: 'TL;DR box', icon: 'tl;dr', keys: 'tldr summary box callout', ribbon: 'more', slash: true, run: (via) => blockInsert('> [!TLDR]\n> ', via) },
    { id: 'epistemic', label: 'Epistemic status', icon: 'status', keys: 'epistemic status confidence callout', ribbon: 'more', slash: true, run: (via) => blockInsert('> [!EPISTEMIC] Epistemic status\n> ', via) },
    { id: 'pullquote', label: 'Pull quote', icon: 'pull', keys: 'quote pull callout', ribbon: 'more', slash: true, run: (via) => blockInsert('> [!QUOTE] Who said it\n> ', via) },
    {
      id: 'details',
      label: 'Collapsible <details>',
      icon: 'details',
      keys: 'details collapsible toggle',
      ribbon: 'more',
      slash: true,
      run: (via) => blockInsert(`<details>\n<summary>${SEL_START}Title${SEL_END}</summary>\n\nHidden text goes here.\n\n</details>\n`, via),
    },
    { id: 'codeblock', label: 'code block', icon: '{ }', keys: 'code block fence pre', hint: '```', ribbon: 'more', slash: true, run: (via) => blockInsert(`\`\`\`\n${SEL_START}${SEL_END}\n\`\`\`\n`, via) },
    {
      id: 'diagram',
      label: 'diagram',
      icon: 'diagram',
      keys: 'diagram flow flowchart boxes arrows',
      hint: 'A -> B',
      ribbon: 'more',
      slash: true,
      run: (via) => blockInsert(`\`\`\`diagram\ndirection: right\ncaption: ${SEL_START}What this shows${SEL_END}\nA[Input] -> B[Process] -> C[Output]\n\`\`\`\n`, via),
    },
    {
      id: 'zeta',
      label: 'zeta animation',
      icon: 'ζ',
      keys: 'zeta riemann animation critical line zeros primes',
      ribbon: 'more',
      slash: true,
      // the fence works in .md and .mdx alike (plugins/remark-zeta.mjs)
      run: (via) => blockInsert(`\`\`\`zeta\ncaption: ${SEL_START}every pass through the origin is a nontrivial zero${SEL_END}\n\`\`\`\n`, via),
    },
    {
      id: 'figure',
      label: 'figure (images side by side)',
      icon: 'figure',
      keys: 'figure images gallery grid side caption',
      ribbon: 'more',
      slash: true,
      run: (via) =>
        blockInsert(
          ext === 'mdx'
            ? `<Figure caption="${SEL_START}Caption${SEL_END}" cols="2">\n\n![left](/images/…)\n\n![right](/images/…)\n\n</Figure>\n`
            : `\`\`\`figure\ncaption: ${SEL_START}Caption${SEL_END}\ncols: 2\nitems:\n  - image: /images/…\n    alt: left\n  - image: /images/…\n    alt: right\n\`\`\`\n`,
          via,
        ),
    },
    { id: 'strike', label: 'strikethrough', icon: 'del', keys: 'strike strikethrough delete', ribbon: 'more', run: () => wrapSelection('~~', '~~', 'text') },
    { id: 'hr', label: 'divider', icon: '—', keys: 'divider rule hr line', hint: '---', ribbon: 'more', slash: true, run: (via) => blockInsert('---\n', via) },
  ];
  const cmd = (id: string) => CMDS.find((c) => c.id === id)!;
  const keyLabel = (sc?: string) => (sc ? sc.replace('mod', MOD).replace('alt', MOD === '⌘' ? '⌥' : 'alt') : '');

  /** Run a command from anywhere, on the text's own selection, keeping undo. */
  function runCmd(c: Cmd, via: Via) {
    closeMenu();
    // The textarea keeps its selection while blurred; focusing it again (without
    // scrolling) lets the edit go through the browser's undo stack.
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    c.run(via);
    if (via === 'bubble') requestAnimationFrame(showBubble);
  }

  function detect() {
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return closeMenu();
    const start = lineStartOf(pos);
    const slash = ta.value.slice(start, pos).match(/^\/([\w;-]{0,20})$/);
    if (slash) {
      const query = slash[1].toLowerCase();
      // Best first: label starts with it, then a word starts with it, then it appears anywhere.
      const score = (b: Cmd) => {
        const label = b.label.toLowerCase();
        const words = `${label} ${b.keys}`.split(/[^a-z0-9$<]+/);
        if (!query || label.startsWith(query)) return 0;
        if (words.some((w) => w.startsWith(query))) return 1;
        if (label.includes(query) || b.keys.includes(query)) return 2;
        return 9;
      };
      const items: Item[] = CMDS.filter((c) => c.slash)
        .map((b) => ({ b, s: score(b) }))
        .filter((x) => x.s < 9)
        .sort((x, y) => x.s - y.s)
        .map(({ b }) => ({ label: b.label, hint: b.shortcut ? keyLabel(b.shortcut) : b.hint, run: () => runCmd(b, 'slash') }));
      return openMenu(slashEl, 'insert', items, start);
    }
    const wiki = ta.value.slice(Math.max(0, pos - 100), pos).match(/\[\[([^[\]\n|]{0,60})$/);
    if (wiki) {
      const query = wiki[1].toLowerCase();
      const items: Item[] = data.posts
        .filter((p) => p.slug !== slug && (p.title.toLowerCase().includes(query) || p.slug.includes(query)))
        .slice(0, 8)
        .map((p) => ({
          label: p.title,
          hint: p.slug,
          run: () => {
            const now = ta.selectionStart;
            const typed = ta.value.slice(Math.max(0, now - 100), now).match(/\[\[([^[\]\n|]{0,60})$/)?.[1] ?? '';
            const closed = ta.value.startsWith(']]', now) ? 2 : 0;
            replace(now - typed.length, now + closed, `${p.slug}]]`);
          },
        }));
      return openMenu(wikiEl, 'link a post', items, pos - wiki[1].length - 2);
    }
    closeMenu();
  }

  // ---- formatting bubble (desktop; the ribbon covers touch screens) ----------------
  const bubble = document.createElement('div');
  bubble.className = 'w-bubble';
  bubble.setAttribute('role', 'toolbar');
  bubble.setAttribute('aria-label', 'Format selection');
  bubble.hidden = true;
  const proseBubbleHtml = ['bold', 'italic', 'code', 'link', 'math', 'quote']
    .map((id) => {
      const c = cmd(id);
      return `<button type="button" data-cmd="${c.id}" title="${esc(c.label)}${c.shortcut ? ` (${keyLabel(c.shortcut)})` : ''}" aria-label="${esc(c.label)}">${esc(c.icon)}</button>`;
    })
    .join('');
  bubble.innerHTML = proseBubbleHtml;
  let mathBubbleActions: Array<{ id: string; icon: string; label: string; run: () => void }> = [];
  wrap.append(bubble);
  on(bubble, 'mousedown', (e: MouseEvent) => e.preventDefault());
  on(bubble, 'click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd], [data-math-act]');
    if (!b) return;
    if (b.dataset.mathAct !== undefined) {
      const act = mathBubbleActions[Number(b.dataset.mathAct)];
      if (act) {
        if (document.activeElement !== ta) ta.focus({ preventScroll: true });
        act.run();
        requestAnimationFrame(showBubble);
      }
      return;
    }
    if (b.dataset.cmd) runCmd(cmd(b.dataset.cmd), 'bubble');
  });

  function showBubble() {
    if (document.activeElement !== ta || ta.selectionStart === ta.selectionEnd || menu || coarse()) return hideBubble();
    const inMath = latexStudio?.isInMath(ta.selectionStart) ?? false;
    if (inMath) {
      mathBubbleActions = latexStudio?.getMathBubbleActions() ?? [];
      if (mathBubbleActions.length) {
        bubble.dataset.mode = 'math';
        bubble.innerHTML = mathBubbleActions
          .map(
            (a, i) =>
              `<button type="button" data-math-act="${i}" title="${esc(a.label)}" aria-label="${esc(a.label)}">${esc(a.icon)}</button>`,
          )
          .join('');
      } else if (bubble.dataset.mode === 'math') {
        delete bubble.dataset.mode;
        bubble.innerHTML = proseBubbleHtml;
      }
    } else {
      mathBubbleActions = [];
      if (bubble.dataset.mode === 'math') {
        delete bubble.dataset.mode;
        bubble.innerHTML = proseBubbleHtml;
      }
    }
    const c = caret(ta.selectionStart);
    bubble.hidden = false;
    const above = c.y - bubble.offsetHeight - 6;
    place(bubble, c.x, above < -60 ? c.y + c.h + 4 : above);
  }
  const hideBubble = () => (bubble.hidden = true);

  function wrapSelection(before: string, after: string, placeholder: string) {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const sel = v.slice(s, e);
    const outside = v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after;
    const boldNotItalic = before === '*' && v.slice(s - 2, s) === '**' && v.slice(s - 3, s) !== '***';
    if (outside && !boldNotItalic) {
      replace(s - before.length, e + after.length, sel, s - before.length, e - before.length);
    } else if (sel.length > before.length + after.length && sel.startsWith(before) && sel.endsWith(after)) {
      const inner = sel.slice(before.length, sel.length - after.length);
      replace(s, e, inner, s, s + inner.length);
    } else {
      const text = sel || placeholder;
      replace(s, e, `${before}${text}${after}`, s + before.length, s + before.length + text.length);
    }
  }

  // ---- ribbon: a compact second row in the bar ----------------------------------------
  const bar = root.querySelector<HTMLElement>('.studio-bar')!;
  const ribbon = document.createElement('div');
  ribbon.className = 'sb-ribbon';
  ribbon.setAttribute('role', 'toolbar');
  ribbon.setAttribute('aria-label', 'Formatting');
  ribbon.setAttribute('aria-controls', ta.id || 'w-body');
  if (!ta.id) ta.id = 'w-body';
  const title = (c: Cmd) => `${c.label}${c.shortcut ? ` (${keyLabel(c.shortcut)})` : ''}`;
  const mains = CMDS.filter((c) => c.ribbon === 'main');
  const menuCmds = [...mains.filter((c) => !c.phone), ...CMDS.filter((c) => c.ribbon === 'more')];
  ribbon.innerHTML =
    mains
      .map(
        (c, i) =>
          `<button type="button" class="rb bevel${c.phone ? '' : ' rb-wide'}" data-cmd="${c.id}" tabindex="${i === 0 ? 0 : -1}" title="${esc(title(c))}" aria-label="${esc(title(c))}">${esc(c.icon)}</button>`,
      )
      .join('') +
    `<span class="rb-more-wrap"><button type="button" class="rb rb-more bevel" tabindex="-1" aria-haspopup="menu" aria-expanded="false" aria-controls="rb-menu">more ▾</button>` +
    `<div class="rb-menu" id="rb-menu" role="menu" aria-label="More formatting" hidden>${menuCmds
      .map(
        (c) =>
          `<button type="button" role="menuitem" tabindex="-1" class="${c.ribbon === 'main' ? 'rb-phone-only' : ''}" data-cmd="${c.id}"><span>${esc(c.label)}</span>${c.shortcut ? `<kbd>${esc(keyLabel(c.shortcut))}</kbd>` : c.hint ? `<kbd>${esc(c.hint)}</kbd>` : ''}</button>`,
      )
      .join('')}</div></span>`;
  q('[data-ribbon-slot]').append(ribbon);
  const moreBtn = ribbon.querySelector<HTMLButtonElement>('.rb-more')!;
  const moreMenu = ribbon.querySelector<HTMLElement>('.rb-menu')!;
  const visible = (els: Iterable<HTMLElement>) => [...els].filter((b) => b.offsetParent !== null);
  const ribbonButtons = () => visible(ribbon.querySelectorAll<HTMLElement>(':scope > .rb, .rb-more'));
  const menuItems = () => visible(moreMenu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  // One tab stop for the whole row (arrow keys move inside it).
  const rove = (to: HTMLElement) => {
    ribbonButtons().forEach((b) => (b.tabIndex = b === to ? 0 : -1));
    to.focus();
  };
  const resetRove = () => {
    const btns = ribbonButtons();
    btns.forEach((b, i) => (b.tabIndex = i === 0 ? 0 : -1));
  };
  // (A timer, not requestAnimationFrame: that never fires in a background tab.)
  window.setTimeout(resetRove, 0);
  on(window, 'resize', resetRove);
  // Pressing a button must not take the text's focus or selection away.
  on(ribbon, 'mousedown', (e: MouseEvent) => e.preventDefault());

  function openMore(focusFirst: boolean) {
    moreMenu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    if (focusFirst) menuItems()[0]?.focus();
  }
  function closeMore(focusButton: boolean) {
    if (moreMenu.hidden) return;
    moreMenu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    if (focusButton) moreBtn.focus();
  }
  const backToWriting = () => ta.focus({ preventScroll: true });

  on(ribbon, 'click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b === moreBtn) return moreMenu.hidden ? openMore(e.detail === 0) : closeMore(false);
    if (b.dataset.cmd) {
      // Who to give focus back to if the command opens a dialog (a menu item vanishes: use "more").
      const was = document.activeElement as HTMLElement | null;
      cmdOpener = was && moreMenu.contains(was) ? moreBtn : was;
      closeMore(false);
      runCmd(cmd(b.dataset.cmd), 'ribbon');
      cmdOpener = null;
    }
  });
  on(ribbon, 'keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (moreMenu.contains(target)) {
      const items = menuItems();
      const i = items.indexOf(target);
      if (e.key === 'ArrowDown') return e.preventDefault(), items[(i + 1) % items.length]?.focus();
      if (e.key === 'ArrowUp') return e.preventDefault(), items[(i - 1 + items.length) % items.length]?.focus();
      if (e.key === 'Home') return e.preventDefault(), items[0]?.focus();
      if (e.key === 'End') return e.preventDefault(), items.at(-1)?.focus();
      if (e.key === 'Escape') return e.preventDefault(), closeMore(true);
      if (e.key === 'Tab') return closeMore(false);
      return;
    }
    const btns = ribbonButtons();
    const i = btns.indexOf(target);
    if (i < 0) return;
    if (e.key === 'ArrowRight') return e.preventDefault(), rove(btns[(i + 1) % btns.length]);
    if (e.key === 'ArrowLeft') return e.preventDefault(), rove(btns[(i - 1 + btns.length) % btns.length]);
    if (e.key === 'Home') return e.preventDefault(), rove(btns[0]);
    if (e.key === 'End') return e.preventDefault(), rove(btns.at(-1)!);
    if (e.key === 'ArrowDown' && target === moreBtn) return e.preventDefault(), openMore(true);
    if (e.key === 'Escape') return e.preventDefault(), closeMore(false), backToWriting();
  });
  on(document, 'pointerdown', (e: PointerEvent) => !ribbon.contains(e.target as Node) && closeMore(false));

  // ---- footnotes ------------------------------------------------------------------------
  const footEl = makePop('w-foot');
  footEl.innerHTML = '<label for="w-foot-in">footnote</label><input id="w-foot-in" type="text" autocomplete="off" placeholder="type the note, then enter" />';
  const footInput = footEl.querySelector('input')!;
  footInput.setAttribute('data-spelling', '');
  footInput.setAttribute('autocorrect', 'off');
  footInput.spellcheck = true;
  const refreshSpelling = initSpelling(root, signal);
  let footAt = 0;

  function openFootnote() {
    closeMenu();
    hideBubble();
    footAt = ta.selectionEnd;
    const c = caret(footAt);
    place(footEl, c.x, c.y + c.h + 2);
    footInput.value = '';
    footInput.focus();
  }

  function backToText() {
    footEl.hidden = true;
    ta.focus();
    ta.setSelectionRange(footAt, footAt);
  }

  function addFootnote(text: string) {
    const y = window.scrollY;
    const n = Math.max(0, ...[...ta.value.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1]))) + 1;
    const marker = `[^${n}]`;
    ta.focus();
    replace(footAt, footAt, marker);
    const back = footAt + marker.length;
    const v = ta.value;
    const trimmed = v.replace(/\s+$/, '');
    const last = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
    replace(trimmed.length, v.length, `${/^\[\^\d+\]:/.test(last) ? '\n' : '\n\n'}[^${n}]: ${text}\n`, back, back);
    window.scrollTo(0, y);
  }

  on(footInput, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      backToText();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const text = footInput.value.trim();
      footEl.hidden = true;
      if (text) addFootnote(text);
      else backToText();
    }
  });
  on(footInput, 'blur', () => window.setTimeout(() => {
    if (document.activeElement !== footInput && !document.activeElement?.closest('.spell-menu')) footEl.hidden = true;
  }, 150));

  // ---- chart dialog: fields + data on the left, the real renderer's output on the right ----
  const chartDlg = q<HTMLDialogElement>('[data-chart]');
  const chartForm = q<HTMLFormElement>('[data-chart-form]');
  const chartOut = q('[data-chart-out]');
  const chartState = q('[data-chart-state]');
  const chartSrc = q('[data-chart-src]');
  const chartInput = <T extends HTMLElement = HTMLInputElement>(name: string) => chartForm.elements.namedItem(name) as unknown as T;
  const CHART_EMPTY = '<p class="studio-note">paste or type data to see the chart.</p>';
  /** Set by the ribbon just before a command runs (the button, or the text if the mouse was used). */
  let cmdOpener: HTMLElement | null = null;
  let chartBack = { s: 0, e: 0, d: 'none' as Dir, y: 0, opener: ta as HTMLElement };
  let chartTimer = 0;
  let chartSeq = 0;

  const chartSpec = (): ChartSpec => {
    const v = (n: string) => chartInput(n).value.trim();
    return { type: v('type') || 'line', title: v('title'), xLabel: v('xLabel'), yLabel: v('yLabel'), unit: v('unit'), caption: v('caption'), id: v('id'), data: chartInput<HTMLTextAreaElement>('data').value };
  };
  const chartSnippet = (s: ChartSpec) => (ext === 'mdx' ? chartMdx(s) : chartFence(s));

  function openChart(via: Via) {
    if (chartDlg.open) return;
    const opener = via === 'ribbon' && cmdOpener && cmdOpener !== document.body ? cmdOpener : ta;
    closeMenu();
    hideBubble();
    closeMore(false);
    // Inserting needs the text on screen (and focusable, so undo works).
    if (layout === 'preview') setLayout(editLayout());
    if (via === 'slash') clearSlash();
    chartBack = { s: ta.selectionStart, e: ta.selectionEnd, d: ta.selectionDirection as Dir, y: window.scrollY, opener };
    chartForm.reset();
    chartOut.innerHTML = CHART_EMPTY;
    chartSrc.textContent = '';
    chartState.textContent = '';
    chartDlg.showModal();
    chartInput<HTMLSelectElement>('type').focus();
  }

  /** Close, put the caret/selection and scroll back; with a snippet, insert it there (undoable). */
  function closeChart(snippet?: string) {
    clearTimeout(chartTimer);
    chartSeq += 1;
    if (chartDlg.open) chartDlg.close();
    const { s, e, d, y, opener } = chartBack;
    window.scrollTo({ top: y, behavior: 'instant' });
    const toText = !!snippet || opener === ta || !opener.isConnected || opener.offsetParent === null;
    if (toText) ta.focus({ preventScroll: true });
    ta.setSelectionRange(s, e, d);
    if (!toText) opener.focus({ preventScroll: true });
    if (snippet) blockInsert(snippet, 'ribbon');
  }

  function queueChartPreview() {
    clearTimeout(chartTimer);
    chartState.textContent = 'updating…';
    chartTimer = window.setTimeout(renderChartPreview, 350);
  }

  async function renderChartPreview() {
    const spec = chartSpec();
    const seq = ++chartSeq;
    chartSrc.textContent = chartSnippet(spec);
    if (!spec.data.trim()) {
      chartOut.innerHTML = CHART_EMPTY;
      chartState.textContent = '';
      return;
    }
    try {
      // The preview renders Markdown, so it gets the fence (the same spec an .mdx <Chart> carries).
      const { html } = await api('/api/write/preview', 'POST', { slug, body: chartFence(spec) });
      if (seq !== chartSeq || !chartDlg.open) return;
      chartOut.innerHTML = html || CHART_EMPTY;
      const failed = chartOut.querySelector('.chart-error, [class*="error"]');
      chartState.textContent = failed ? 'the renderer rejected this: see the preview' : 'preview up to date';
    } catch (err) {
      if (seq !== chartSeq) return;
      chartOut.innerHTML = `<p class="studio-note">couldn't render the preview: ${esc(err instanceof Error ? err.message : 'error')}</p>`;
      chartState.textContent = 'preview failed';
    }
  }

  on(chartForm, 'input', queueChartPreview);
  on(chartForm, 'change', queueChartPreview);
  on(chartInput('id'), 'change', () => (chartInput('id').value = chartId(chartInput('id').value)));
  on(chartForm, 'submit', (e: SubmitEvent) => {
    e.preventDefault();
    const spec = chartSpec();
    if (!spec.data.trim()) {
      chartState.textContent = 'add some data first (CSV, JSON or a Markdown table).';
      return chartInput<HTMLTextAreaElement>('data').focus();
    }
    closeChart(chartSnippet(spec));
  });
  // Escape (the dialog's own cancel), × and [ cancel ] all close without inserting.
  on(chartDlg, 'cancel', (e: Event) => {
    e.preventDefault();
    closeChart();
  });
  chartDlg.querySelectorAll('[data-chart-close]').forEach((b) => on(b, 'click', () => closeChart()));

  // ---- images: upload, insert, thumbnails ---------------------------------------------
  const mediaSrc = new Map<string, string>();
  /** Local previews while an upload is in flight, keyed by the placeholder's alt text. */
  const pending = new Map<string, string>();
  let pickSel: { s: number; e: number; d: Dir } | null = null;
  const pickFile = () => {
    pickSel = { s: ta.selectionStart, e: ta.selectionEnd, d: ta.selectionDirection as Dir };
    fileInput.value = '';
    fileInput.click();
  };
  on(fileInput, 'change', () => {
    // Back to the exact caret, focused, so the insert keeps undo working.
    if (pickSel) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(pickSel.s, pickSel.e, pickSel.d);
      pickSel = null;
    }
    upload([...(fileInput.files ?? [])]);
  });

  function swapToken(token: string, text: string) {
    const i = ta.value.indexOf(token);
    if (i < 0) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const shift = (p: number) => (p >= i + token.length ? p + text.length - token.length : p > i ? i + text.length : p);
    const y = window.scrollY;
    replace(i, i + token.length, text, shift(s), shift(e));
    window.scrollTo(0, y);
  }

  async function upload(files: File[]) {
    const images = files.filter((f) => /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(f.type));
    if (!images.length) {
      if (files.length) say('only png, jpg, gif, webp or svg images can be added.');
      return;
    }
    for (const file of images) {
      if (file.size > 20 * 1024 * 1024) {
        say(`${esc(file.name)} is over 20 MB.`);
        continue;
      }
      const label = `uploading ${Math.random().toString(36).slice(2, 7)}…`;
      const token = `![${label}]()`;
      const local = URL.createObjectURL(file);
      pending.set(label, local);
      const pos = ta.selectionEnd;
      const before = ta.value.slice(0, pos);
      const after = ta.value.slice(pos);
      const pre = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const post = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
      replace(pos, pos, `${pre}${token}${post}`);
      // Show the picture beside its block right away, from the local file.
      clearTimeout(gutterTimer);
      renderGutter();
      setStatus(`uploading ${file.name || 'image'}…`, 'saving');
      try {
        const kind = file.type.split('/')[1].replace('+xml', '').replace('jpeg', 'jpg');
        const name = file.name && !/^image\.\w+$/.test(file.name) ? file.name : `pasted.${kind}`;
        const res = await fetch(`/api/upload-media?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream', accept: 'application/json' },
          body: file,
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error ?? `upload failed (${res.status})`);
        // Keep showing the local copy: it's already decoded, so nothing flickers.
        mediaSrc.set(d.path, local);
        pending.delete(label);
        swapToken(token, `![](${d.path})`);
        say(null);
        refreshTray();
      } catch (err) {
        pending.delete(label);
        URL.revokeObjectURL(local);
        swapToken(token, '');
        say(`couldn't upload ${esc(file.name || 'the image')}: ${esc(err instanceof Error ? err.message : 'error')}`);
        setStatus('upload failed', 'error');
      }
    }
  }

  on(ta, 'paste', (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith('image/')) && !e.clipboardData?.getData('text/plain')) {
      e.preventDefault();
      upload(files);
    }
  });

  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  let dragDepth = 0;
  on(document, 'dragenter', (e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth += 1;
    dropEl.hidden = false;
  });
  on(document, 'dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropEl.hidden = true;
  });
  on(document, 'dragover', (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  on(document, 'drop', (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    dropEl.hidden = true;
    if (document.activeElement !== ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    upload([...(e.dataTransfer?.files ?? [])]);
  });

  function thumbSrc(url: string) {
    if (mediaSrc.has(url)) return mediaSrc.get(url)!;
    const m = !DEV && url.match(/^\/images\/posts\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]*\.(?:png|jpg|gif|webp|svg))$/);
    return m ? `/api/media/${m[1]}/${m[2]}` : url;
  }

  let gutterTimer = 0;
  function queueGutter() {
    clearTimeout(gutterTimer);
    gutterTimer = window.setTimeout(renderGutter, 250);
  }

  function renderGutter() {
    const beside = getComputedStyle(gutter).position === 'absolute';
    let minTop = 0;
    const found = [...ta.value.matchAll(IMG_RE)].filter((m) => m[2] || pending.has(m[1]));
    gutter.replaceChildren(
      ...found.map((m) => {
        const uploading = !m[2];
        const src = uploading ? pending.get(m[1])! : thumbSrc(m[2]);
        const a = document.createElement('a');
        a.className = 'w-thumb';
        a.href = src;
        a.target = '_blank';
        a.rel = 'noopener';
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.src = src;
        if (!uploading && src !== m[2]) img.onerror = () => ((img.onerror = null), (img.src = m[2]));
        const cap = document.createElement('span');
        cap.textContent = uploading ? 'uploading…' : (m[2].split('/').pop() ?? '');
        if (uploading) a.classList.add('is-uploading');
        a.append(img, cap);
        if (beside) {
          const top = Math.max(caret(m.index!).y - gutter.offsetTop, minTop);
          a.style.top = `${top}px`;
          minTop = top + 150;
        }
        return a;
      }),
    );
  }

  // ---- media tray: every upload of this post (and every image the text uses) ----------
  // Opens under the sticky bar, so the caret and scroll stay exactly where they are.
  type MediaFile = { name: string; path: string; src: string; size: number; type: string; modified: string; uses: string[]; published: boolean };
  const trayBtn = q<HTMLButtonElement>('[data-act="media"]');
  const tray = q('[data-tray]');
  const trayList = q('[data-tray-list]');
  const trayNote = q('[data-tray-note]');
  const trayCount = q('[data-tray-count]');
  let trayFiles: MediaFile[] = [];
  let trayLoaded = false;

  const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const usedHere = (path: string) => [...ta.value.matchAll(IMG_RE)].filter((m) => m[2] === path).length;

  async function refreshTray() {
    try {
      const r = await api(`/api/upload-media?slug=${encodeURIComponent(slug)}`, 'GET');
      trayFiles = r.files ?? [];
      trayLoaded = true;
    } catch (err) {
      trayNote.textContent = `couldn't list the uploads: ${err instanceof Error ? err.message : 'error'}`;
    }
    renderTray();
  }

  function renderTray() {
    // Uploads of this post, plus anything else the text points at (other posts' images, links).
    const known = new Set(trayFiles.map((f) => f.path));
    const others = [...new Set([...ta.value.matchAll(IMG_RE)].map((m) => m[2]).filter((p) => p && !known.has(p)))];
    trayCount.textContent = String(trayFiles.length + others.length);
    if (tray.hidden) return;
    trayNote.textContent = !trayLoaded ? 'loading…' : trayFiles.length + others.length ? '[ insert ] puts it at the cursor; [ remove ] takes it out of this post (undo with ctrl+z).' : 'no images yet: paste, drop or use the img button.';
    const row = (o: { path: string; src: string; name: string; meta: string; file?: MediaFile }) => {
      const here = usedHere(o.path);
      const elsewhere = (o.file?.uses ?? []).filter((u) => u !== slug);
      const li = document.createElement('li');
      li.className = 'tray-item';
      li.dataset.path = o.path;
      const isVideo = /\.(mp4|webm)$/i.test(o.path);
      li.innerHTML = `
        <span class="tray-thumb">${isVideo ? `<video muted loop playsinline preload="metadata" src="${esc(o.src)}"></video>` : `<img alt="" decoding="async" loading="lazy" src="${esc(o.src)}" />`}</span>
        <span class="tray-info">
          <span class="tray-name">${esc(o.name)}</span>
          <span class="tray-meta">${esc(o.meta)} · ${here ? `used ${here}× here` : 'not used here'}${elsewhere.length ? ` · also in ${esc(elsewhere.join(', '))}` : ''}${o.file?.published ? ' · on the live site' : ''}</span>
        </span>
        <span class="tray-acts">
          <button type="button" class="bevel" data-tray-insert>insert</button>
          <button type="button" class="bevel" data-tray-remove ${here ? '' : 'disabled'}>remove</button>
          ${o.file ? `<button type="button" class="bevel tray-del" data-tray-delete ${o.file.published ? 'disabled title="Already on the live site: deleting it here would not remove it there."' : ''}>delete file…</button>` : ''}
        </span>`;
      return li;
    };
    trayList.replaceChildren(
      ...trayFiles.map((f) => row({ path: f.path, src: mediaSrc.get(f.path) ?? f.src, name: f.name, meta: kb(f.size), file: f })),
      ...others.map((p) => row({ path: p, src: thumbSrc(p), name: p.split('/').pop() ?? p, meta: 'not an upload of this post' })),
    );
  }

  function openTray(open: boolean, focusInside = false) {
    tray.hidden = !open;
    trayBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      renderTray();
      refreshTray();
      if (focusInside) window.setTimeout(() => tray.querySelector<HTMLElement>('button:not([disabled])')?.focus(), 0);
    }
  }

  /** Take every use of `path` out of the text in one undoable step. */
  function removeRefs(path: string) {
    const v = ta.value;
    const hits = [...v.matchAll(IMG_RE)].filter((m) => m[2] === path);
    if (!hits.length) return;
    let out = '';
    let last = 0;
    let first = -1;
    let lastEnd = 0;
    for (const m of hits) {
      let a = m.index!;
      let b = a + m[0].length;
      // An image alone on its line takes the line (and its newline) with it.
      const ls = lineStartOf(a);
      const le = v.indexOf('\n', b) < 0 ? v.length : v.indexOf('\n', b);
      if (!v.slice(ls, a).trim() && !v.slice(b, le).trim()) {
        a = ls;
        b = le < v.length ? le + 1 : le;
      }
      if (first < 0) first = a;
      out += v.slice(last, a);
      last = b;
      lastEnd = b;
    }
    const span = out.slice(first) + v.slice(last, lastEnd);
    const { selectionStart: s, selectionEnd: e } = ta;
    const delta = span.length - (lastEnd - first);
    const map = (p: number) => (p >= lastEnd ? p + delta : p > first ? first : p);
    const y = window.scrollY;
    ta.focus({ preventScroll: true });
    replace(first, lastEnd, span, map(s), map(e));
    window.scrollTo({ top: y, behavior: 'instant' });
  }

  async function deleteFile(f: MediaFile) {
    const here = usedHere(f.path);
    const elsewhere = f.uses.filter((u) => u !== slug);
    const impact = [here ? `it's used ${here}× in this post` : '', elsewhere.length ? `it's used in: ${elsewhere.join(', ')}` : ''].filter(Boolean);
    const question = impact.length
      ? `Delete ${f.name}? ${impact.join(', and ')}: those images will break. (Use [ remove ] first to take it out of this post.) This can't be undone.`
      : `Delete ${f.name}? It isn't used anywhere. This can't be undone.`;
    if (!window.confirm(question)) return;
    const uses = [...new Set([...f.uses, ...(here ? [slug] : [])])].sort().join(',');
    try {
      const headers: Record<string, string> = { 'x-studio-action': 'delete-media' };
      if (uses) headers['x-studio-confirm-uses'] = uses;
      await api(`/api/upload-media?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(f.name)}`, 'DELETE', undefined, headers);
      say(`deleted ${esc(f.name)}.`);
    } catch (err) {
      say(`didn't delete ${esc(f.name)}: ${esc(err instanceof Error ? err.message : 'error')}`);
    }
    refreshTray();
  }

  on(trayBtn, 'click', (e: MouseEvent) => openTray(tray.hidden, e.detail === 0));
  on(tray, 'mousedown', (e: MouseEvent) => (e.target as HTMLElement).closest('button') && e.preventDefault());
  on(tray, 'click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    const item = b?.closest<HTMLElement>('[data-path]');
    if (!b || !item) return;
    const path = item.dataset.path!;
    if (b.hasAttribute('data-tray-insert')) {
      ta.focus({ preventScroll: true });
      blockInsert(`![](${path})\n`, 'ribbon');
      renderTray();
    } else if (b.hasAttribute('data-tray-remove')) {
      removeRefs(path);
      renderTray();
    } else if (b.hasAttribute('data-tray-delete')) {
      const f = trayFiles.find((x) => x.path === path);
      if (f) deleteFile(f);
    }
  });
  on(tray, 'keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    openTray(false);
    trayBtn.focus({ preventScroll: true });
  });
  let trayTimer = 0;
  on(ta, 'input', () => {
    clearTimeout(trayTimer);
    trayTimer = window.setTimeout(renderTray, 400);
  });

  // ---- preview, focus, details ------------------------------------------------------------
  // Where you were (scroll, cursor, selection, whether you were typing) before
  // preview or details, so coming back puts all of it back exactly.
  // Several of these can be open at once (preview, then details): the place is
  // taken when the first one opens and given back when the last one closes.
  type Dir = 'forward' | 'backward' | 'none';
  let spot = { y: 0, s: 0, e: 0, d: 'none' as Dir, typing: false };
  const away = new Set<string>();
  // Bar buttons take focus on press, so note whether the text had it first.
  let typingBeforePress = false;
  for (const el of root.querySelectorAll('.studio-bar, .w-pane-bar, [data-ribbon-slot]')) on(el, 'pointerdown', () => (typingBeforePress = document.activeElement === ta));
  const remember = (why: string) => {
    if (!away.size) {
      spot = { y: window.scrollY, s: ta.selectionStart, e: ta.selectionEnd, d: ta.selectionDirection as Dir, typing: document.activeElement === ta || typingBeforePress };
    }
    away.add(why);
    typingBeforePress = false;
  };
  const returnToText = (why: string) => {
    // Opened by itself (e.g. details on a post with no description): nothing to return to.
    if (!away.has(why)) return;
    away.delete(why);
    if (away.size) return;
    window.scrollTo({ top: spot.y, behavior: 'instant' });
    if (!spot.typing) return;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(spot.s, spot.e, spot.d);
  };
  /** Keep the line you're on in the same place on screen while things above it change. */
  const keepPlace = (change: () => void) => {
    const before = layout === 'preview' ? null : ta.getBoundingClientRect().top;
    change();
    if (before !== null) window.scrollBy({ top: ta.getBoundingClientRect().top - before, behavior: 'instant' });
  };

  // ---- split workspace: [ split | write | preview ] ------------------------------------------
  // The page scrolls the source (so every caret/scroll rule above still holds);
  // the preview is a sticky pane with its own scroll beside it.
  type Layout = 'split' | 'write' | 'preview';
  const LAYOUT_KEY = 'write:layout';
  const SPLIT_KEY = 'write:split';
  const SYNC_KEY = 'write:sync';
  const splitEl = q('[data-split]');
  const splitter = q('[data-splitter]');
  const previewScroll = q('[data-preview-scroll]');
  const previewHead = q('[data-preview-head]');
  const countEl = q('[data-count]');
  const paneStatus = q('[data-pane-status]');
  const syncBtn = q<HTMLButtonElement>('[data-sync]');
  const modeBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-mode]')];
  const wideQuery = window.matchMedia('(min-width: 1024px)');
  const canSplit = () => wideQuery.matches;
  const store = {
    get: (k: string) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k: string, v: string) => {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };
  /** What you picked (split survives a trip through a narrow window). */
  let wanted: Layout = (['split', 'write', 'preview'].includes(store.get(LAYOUT_KEY) ?? '') ? store.get(LAYOUT_KEY) : 'split') as Layout;
  let layout: Layout = 'write';
  root.dataset.layout = layout;
  let lastEditing: Layout = 'split';
  let sync = store.get(SYNC_KEY) !== 'off';

  const effective = (l: Layout): Layout => (l === 'split' && !canSplit() ? 'write' : l);

  function setLayout(next: Layout, remember_ = true) {
    const to = effective(next);
    // Only the editing layout is remembered: preview is a look, not a preference,
    // and on a narrow screen "write" is the only choice, so neither overwrites
    // a split preference for when the window is wide again.
    if (remember_ && next !== 'preview' && (next !== 'write' || canSplit())) {
      wanted = next;
      store.set(LAYOUT_KEY, next);
    }
    const from = layout;
    if (to === from) return paintModes();
    if (to === 'preview') {
      remember('preview');
      closeMenu();
      hideBubble();
    }
    if (to !== 'preview') lastEditing = to;
    layout = to;
    root.dataset.layout = to;
    paintModes();
    if (from === 'preview') returnToText('preview');
    if (to !== 'write') renderLive();
    queueGutter();
  }

  function paintModes() {
    const split = canSplit();
    for (const b of modeBtns) {
      b.hidden = b.dataset.mode === 'split' && !split;
      b.setAttribute('aria-pressed', String(b.dataset.mode === layout));
    }
  }

  // Back to editing (from preview): the layout you were writing in.
  const editLayout = (): Layout => effective(lastEditing === 'preview' ? 'split' : lastEditing);
  const togglePreview = () => setLayout(layout === 'preview' ? editLayout() : 'preview');

  on(wideQuery, 'change', () => setLayout(wanted, false));
  // (Belt and braces: some environments resize without firing the media-query event.)
  on(window, 'resize', () => effective(wanted) !== layout && layout !== 'preview' && setLayout(wanted, false));

  // ---- live rendering (~120ms after you stop typing; stale replies are dropped) ----------------
  let liveTimer = 0;
  let liveSeq = 0;
  let liveCtl: AbortController | null = null;
  let previewCtl: AbortController | null = null;
  function queueLive() {
    if (layout === 'write') return;
    clearTimeout(liveTimer);
    liveTimer = window.setTimeout(renderLive, 120);
  }
  async function renderLive() {
    clearTimeout(liveTimer);
    const seq = ++liveSeq;
    liveCtl?.abort();
    liveCtl = new AbortController();
    try {
      const f = collect();
      const res = await fetch('/api/write/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          slug,
          body: ta.value,
          macros: f.macros,
          bibliography: f.bibliography,
          citationStyle: f.citationStyle,
        }),
        signal: liveCtl.signal,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? `error ${res.status}`);
      if (seq !== liveSeq || signal.aborted) return;
      const keep = previewScroll.scrollTop;
      preview.innerHTML = d.html || '<p class="studio-note">nothing to preview yet.</p>';
      previewScroll.scrollTop = keep;
      latexStudio?.setDiagnostics(Array.isArray(d.diagnostics) ? d.diagnostics : []);
      afterRender();
    } catch (err) {
      if ((err as Error).name === 'AbortError' || seq !== liveSeq) return;
      previewHead.dataset.error = `couldn't render the preview: ${err instanceof Error ? err.message : 'error'}`;
    }
  }
  function afterRender() {
    delete previewHead.dataset.error;
    // Footnote and [[link]] hover cards, chart values on tap — same as the article.
    previewCtl?.abort();
    previewCtl = new AbortController();
    initPreviews(preview, previewCtl.signal);
    blocks = null;
    if (sync && layout === 'split') queueSync();
  }
  // The article's title block, kept in step with the fields (no server trip needed).
  function paintHead() {
    const t = field('title').value.trim();
    const s = subtitle.value.trim();
    previewHead.innerHTML = `${t ? `<h1 class="display-title">${esc(t)}</h1>` : '<p class="studio-note">untitled</p>'}${s ? `<p class="display-subtitle">${esc(s)}</p>` : ''}`;
  }
  on(field('title'), 'input', paintHead);
  on(subtitle, 'input', paintHead);
  on(preview, 'pointerup', (e: PointerEvent) => {
    const pt = (e.target as Element).closest?.('.chart-svg .pt');
    preview.querySelectorAll('.chart-svg .pt.is-shown').forEach((p) => p !== pt && p.classList.remove('is-shown'));
    pt?.classList.toggle('is-shown');
  });

  // ---- preview font [Aa] and [ sync ] ------------------------------------------------------------
  const fontBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-preview-font]')];
  function setPreviewFont(f: string) {
    previewScroll.dataset.font = f;
    fontBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.previewFont === f)));
  }
  fontBtns.forEach((b) => on(b, 'click', () => setPreviewFont(b.dataset.previewFont!)));
  // Starts on the post's own font (or the site default); the post's font field moves it too.
  const postFont = () => field<HTMLSelectElement>('font').value || data.siteFont || 'sans';
  on(field<HTMLSelectElement>('font'), 'change', () => setPreviewFont(postFont()));

  function paintSync() {
    syncBtn.setAttribute('aria-pressed', String(sync));
    syncBtn.querySelector('[data-sync-label]')!.textContent = sync ? 'on' : 'off';
  }
  on(syncBtn, 'click', () => {
    sync = !sync;
    store.set(SYNC_KEY, sync ? 'on' : 'off');
    paintSync();
    if (sync) queueSync();
  });

  // ---- splitter: drag, arrows, double-click resets to 50 / 50 -----------------------------------
  const clampSplit = (v: number) => Math.min(75, Math.max(25, v));
  function setSplit(pct: number, save = true) {
    const v = clampSplit(Math.round(pct * 10) / 10);
    splitEl.style.setProperty('--split-n', String(v / 100));
    splitter.setAttribute('aria-valuenow', String(Math.round(v)));
    splitter.setAttribute('aria-valuetext', `source ${Math.round(v)}%, preview ${Math.round(100 - v)}%`);
    if (save) store.set(SPLIT_KEY, String(v));
    blocks = null;
  }
  on(splitter, 'pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitEl.classList.add('is-dragging');
    const box = splitEl.getBoundingClientRect();
    const move = (ev: PointerEvent) => setSplit(((ev.clientX - box.left) / box.width) * 100, false);
    const up = (ev: PointerEvent) => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      splitEl.classList.remove('is-dragging');
      setSplit(((ev.clientX - box.left) / box.width) * 100);
      queueGutter();
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  on(splitter, 'dblclick', () => setSplit(50));
  on(splitter, 'keydown', (e: KeyboardEvent) => {
    const now = Number(splitter.getAttribute('aria-valuenow')) || 50;
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') setSplit(now - step);
    else if (e.key === 'ArrowRight') setSplit(now + step);
    else if (e.key === 'Home') setSplit(25);
    else if (e.key === 'End') setSplit(75);
    else if (e.key === 'Enter') setSplit(50);
    else return;
    e.preventDefault();
  });

  // ---- scroll sync: source → preview (the preview follows the line beside your view) ----------
  // Block map: for each rendered block (data-line), where its source line sits on the page.
  let blocks: { y: number; el: HTMLElement }[] | null = null;
  function measureBlocks() {
    const els = [...preview.querySelectorAll<HTMLElement>(':scope > [data-line]')];
    const starts = [0];
    const v = ta.value;
    for (let i = 0; i < v.length; i++) if (v[i] === '\n') starts.push(i + 1);
    // One pass of the hidden mirror with a marker at each block's first line.
    mirror.style.top = `${ta.offsetTop}px`;
    mirror.style.left = `${ta.offsetLeft}px`;
    mirror.style.width = `${ta.clientWidth}px`;
    mirror.textContent = '';
    const marks: HTMLElement[] = [];
    let at = 0;
    for (const el of els) {
      const off = Math.min(v.length, starts[Math.max(0, Number(el.dataset.line) - 1)] ?? v.length);
      if (off < at) {
        marks.push(marks.at(-1) ?? mirror);
        continue;
      }
      mirror.append(v.slice(at, off));
      const m = document.createElement('span');
      m.textContent = '​';
      mirror.append(m);
      marks.push(m);
      at = off;
    }
    mirror.append(v.slice(at));
    const base = wrap.getBoundingClientRect().top + window.scrollY;
    blocks = els.map((el, i) => ({ el, y: base + ta.offsetTop + (marks[i] === mirror ? 0 : marks[i].offsetTop) }));
  }
  let syncQueued = false;
  let syncFromCaret = false;
  function queueSync(fromCaret = false) {
    if (!sync || layout !== 'split') return;
    syncFromCaret ||= fromCaret;
    if (syncQueued) return;
    syncQueued = true;
    // A timer (not rAF): rAF never fires in a background tab.
    window.setTimeout(() => {
      syncQueued = false;
      const caretMode = syncFromCaret;
      syncFromCaret = false;
      syncPreview(caretMode);
    }, 16);
  }
  function syncPreview(fromCaret: boolean) {
    if (!blocks) measureBlocks();
    const list = blocks!;
    if (!list.length) return;
    const barH = splitEl.getBoundingClientRect().top + window.scrollY > 0 ? stickyTop() : 0;
    // Anchor: the caret's line while typing, otherwise the top of what you can see.
    const viewTop = window.scrollY + barH;
    const caretY = fromCaret ? wrap.getBoundingClientRect().top + window.scrollY + caret(ta.selectionStart).y : NaN;
    const anchor = Number.isFinite(caretY) && caretY > viewTop && caretY < window.scrollY + window.innerHeight ? caretY : viewTop + 24;
    let i = 0;
    while (i + 1 < list.length && list[i + 1].y <= anchor) i += 1;
    const a = list[i];
    const b = list[i + 1];
    const frac = b && b.y > a.y ? Math.min(1, Math.max(0, (anchor - a.y) / (b.y - a.y))) : 0;
    const pa = a.el.offsetTop;
    const pb = b ? b.el.offsetTop : a.el.offsetTop + a.el.offsetHeight;
    const target = anchor < list[0].y ? 0 : pa + frac * (pb - pa) - (anchor - window.scrollY - barH);
    previewScroll.scrollTop = Math.max(0, target);
  }
  const stickyTop = () => parseFloat(getComputedStyle(root).getPropertyValue('--sb-h')) || 0;
  on(window, 'scroll', () => queueSync(false));
  on(window, 'resize', () => {
    blocks = null;
    queueSync(false);
  });

  // ---- preview → source: double-click a block to jump to its line ------------------------------
  on(preview, 'dblclick', (e: MouseEvent) => {
    const block = (e.target as Element).closest<HTMLElement>('[data-line]');
    if (!block || !preview.contains(block)) return;
    window.getSelection()?.removeAllRanges();
    jumpToLine(Number(block.dataset.line));
  });

  // ---- counts + bar height -------------------------------------------------------------------
  function paintCount() {
    const words = (ta.value.match(/\S+/g) ?? []).length;
    countEl.textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${ta.value.length.toLocaleString()} chars`;
  }
  // Sticky pane headers sit just under the studio bar, whatever its height.
  const barEl = root.querySelector<HTMLElement>('.studio-bar')!;
  const paintBarH = () => root.style.setProperty('--sb-h', `${Math.ceil(barEl.getBoundingClientRect().height)}px`);
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(paintBarH);
    ro.observe(barEl);
    signal.addEventListener('abort', () => ro.disconnect());
  }
  paintBarH();
  signal.addEventListener('abort', () => {
    liveCtl?.abort();
    previewCtl?.abort();
  });

  /** Focus mode hides the bars above: one measured adjustment keeps your line still. */
  function toggleFocus(force?: boolean) {
    const typing = document.activeElement === ta || typingBeforePress;
    typingBeforePress = false;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const d = ta.selectionDirection as Dir;
    let active = false;
    keepPlace(() => {
      active = document.documentElement.classList.toggle('write-focus', force);
      if (active) {
        showMeta(false);
        away.delete('details');
      }
    });
    q('[data-act="focus"]').setAttribute('aria-pressed', String(active));
    if (typing) {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(s, e, d);
    }
  }

  /** Just show or hide the drawer (no scrolling). */
  function showMeta(open: boolean) {
    meta.hidden = !open;
    metaBtn.setAttribute('aria-expanded', String(open));
  }

  /** [ details ]: bring the panel into view under the sticky bar… */
  function openDetails() {
    remember('details');
    showMeta(true);
    const bar = root.querySelector<HTMLElement>('.studio-bar')!.getBoundingClientRect().height;
    window.scrollTo({ top: Math.max(0, meta.getBoundingClientRect().top + window.scrollY - bar - 10), behavior: 'instant' });
  }

  /** …and closing it returns to exactly where you were writing. */
  function closeDetails() {
    // Opened by itself, not by you: just fold it away without moving your line.
    if (!away.has('details')) return keepPlace(() => showMeta(false));
    showMeta(false);
    returnToText('details');
  }

  // ---- publish ---------------------------------------------------------------------------------
  async function publishNow() {
    const f = collect();
    if (!f.title.trim()) {
      say('give the post a title first.');
      return field('title').focus();
    }
    if (!f.description.trim()) {
      showMeta(true);
      say('add a description first: one or two sentences for the front page.');
      return field<HTMLTextAreaElement>('description').focus();
    }
    if (data.mode === 'off') {
      say('publishing needs a working GitHub token. <a href="/write/settings/">check the connection</a>');
      return;
    }
    const live = data.mode === 'github';
    const question = f.draft
      ? live
        ? `Commit "${f.title}" to GitHub as a draft? It stays hidden on the live site.`
        : `Save "${f.title}" to content/posts as a draft?`
      : live
        ? `Publish "${f.title}"? This makes the current version public on heartcache.xyz.`
        : `Publish "${f.title}" to heartcache.xyz?`;
    if (!window.confirm(question)) return;
    clearTimeout(timer);
    publishBtn.disabled = true;
    setStatus('publishing…', 'saving');
    try {
      const body = ta.value;
      const sent = snapshot();
      const headers: Record<string, string> = {};
      if (data.mode === 'local' && !f.draft) headers['X-Editor-Action'] = 'publish';
      const { result } = await api('/api/write/post', 'POST', { slug, ext, extra, fields: f, body, basis }, headers);
      basis = result.sha;
      ext = String(result.path).endsWith('.mdx') ? 'mdx' : 'md';
      publishedDoc = { fields: f, body };
      lastSaved = sent;
      serverSavedAt = 0;
      if (snapshot() === sent) {
        dropLocal();
        setStatus(savedLabel());
      } else {
        edited();
      }
      renderState();
      if (result.mode === 'local') {
        if (f.draft) {
          say('Draft saved on this computer.');
        } else {
          say('Waiting for heartcache.xyz to serve this revision…');
          await waitForLocalRelease(result.commit, signal);
          say('Published on heartcache.xyz · <a href="https://heartcache.xyz' + esc(result.url) + '">view live post</a>');
        }
      } else if (f.draft) {
        say(`committed ${esc(result.commit)} as a draft. it stays hidden on the live site.`);
      } else {
        say('published on heartcache.xyz · <a href="' + esc(result.url) + '">view live post</a>');
      }
    } catch (err) {
      const e = err as Error & { field?: string };
      setStatus('not published', 'error');
      say(esc(e.message));
      if (e.field === 'description') {
        showMeta(true);
        field<HTMLTextAreaElement>('description').focus();
      } else if (e.field === 'title') field('title').focus();
    } finally {
      publishBtn.disabled = false;
    }
  }

  // ---- LaTeX studio (autocomplete, math peek, symbol palette, matrix.exe, outline, bib/macros, .tex export) ----
  latexStudio = initLatexStudio({
    root,
    ta,
    wrap,
    preview,
    signal,
    globalMacros: data.globalMacros ?? {},
    defaultCitationStyle: data.defaultCitationStyle ?? 'numeric',
    replace,
    insertTemplate,
    blockInsert,
    caret,
    place,
    getMeta: () => {
      const f = collect();
      return {
        title: f.title,
        subtitle: f.subtitle,
        description: f.description,
        date: f.date,
        author: data.authorName || '',
        slug,
        macros: f.macros,
        bibliography: f.bibliography,
        citationStyle: f.citationStyle,
      };
    },
    setPostMacros: (v: string) => {
      const el = field<HTMLTextAreaElement>('macros');
      if (el.value !== v) {
        el.value = v;
        edited();
        queueLive();
      }
    },
    setPostBib: (v: string) => {
      const el = field<HTMLTextAreaElement>('bibliography');
      if (el.value !== v) {
        el.value = v;
        edited();
        queueLive();
      }
    },
    jumpToLine,
    onEdited: () => {
      edited();
      queueLive();
    },
  });

  // ---- wiring ---------------------------------------------------------------------------------
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-f]').forEach((el) => {
    const instant = el.tagName === 'SELECT' || el.type === 'radio' || el.type === 'checkbox';
    on(el, instant ? 'change' : 'input', () => {
      if (el.dataset.f === 'font') applyFont();
      if (el.dataset.f === 'draft') syncPublishLabel();
      if (el.dataset.f === 'tags' || el.dataset.f === 'series') renderPicks();
      if (el === subtitle) sizeSubtitle();
      if (el.dataset.f === 'macros' || el.dataset.f === 'bibliography' || el.dataset.f === 'citationStyle') {
        latexStudio?.handleInput();
        queueLive();
      }
      edited();
    });
  });

  // Browsers without field-sizing: grow the subtitle by hand.
  function sizeSubtitle() {
    if (nativeSizing) return;
    subtitle.style.height = 'auto';
    subtitle.style.height = `${subtitle.scrollHeight}px`;
  }
  on(field('title'), 'keydown', (e: KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), field('subtitle').focus()));
  on(field('subtitle'), 'keydown', (e: KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), ta.focus()));

  on(ta, 'input', () => {
    autosize();
    edited();
    detect();
    latexStudio?.handleInput();
    queueGutter();
    hideBubble();
    paintCount();
    blocks = null;
    queueLive();
    queueSync(true);
  });
  on(ta, 'click', () => {
    detect();
    latexStudio?.handleSelection();
  });
  on(ta, 'mouseup', () => window.setTimeout(showBubble, 0));
  on(ta, 'keyup', (e: KeyboardEvent) => {
    latexStudio?.handleSelection();
    if (e.shiftKey || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) showBubble();
    else if (ta.selectionStart === ta.selectionEnd) hideBubble();
  });
  on(ta, 'blur', () =>
    window.setTimeout(() => {
      if (document.activeElement === ta || footEl.contains(document.activeElement)) return;
      closeMenu();
      hideBubble();
      latexStudio?.handleBlur();
    }, 120),
  );
  on(ta, 'keydown', (e: KeyboardEvent) => {
    if (menu) {
      if (e.key === 'ArrowDown') return e.preventDefault(), moveMenu(1);
      if (e.key === 'ArrowUp') return e.preventDefault(), moveMenu(-1);
      if ((e.key === 'Enter' || e.key === 'Tab') && menu.items.length) return e.preventDefault(), pickMenu();
      if (e.key === 'Escape') return e.preventDefault(), closeMenu();
    }
    if (latexStudio?.handleKeydown(e)) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    // (No Ctrl+E for code: browsers use it for the address bar. The ribbon has a code button.)
    const digit = /^Digit(\d)$/.exec(e.code)?.[1];
    const combo = ['mod', e.altKey && 'alt', e.shiftKey && 'shift', digit ?? e.key.toLowerCase()].filter(Boolean).join('+');
    const hit = CMDS.find((c) => c.shortcut === combo);
    if (hit) {
      e.preventDefault();
      runCmd(hit, 'key');
    }
  });

  on(document, 'keydown', (e: KeyboardEvent) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    // Behind a modal dialog only "save now" makes sense.
    if ((chartDlg.open || !!root.querySelector('dialog[open]')) && k !== 's') return;
    if (k === 'p' && !e.shiftKey) {
      e.preventDefault();
      togglePreview();
    } else if (e.key === '\\') {
      e.preventDefault();
      toggleFocus();
    } else if (k === 's' && !e.shiftKey) {
      e.preventDefault();
      save();
    }
  });

  const latexPaletteBtn = root.querySelector<HTMLButtonElement>('[data-act="latex-palette"]');
  const latexOutlineBtn = root.querySelector<HTMLButtonElement>('[data-act="latex-outline"]');
  const latexBibBtn = root.querySelector<HTMLButtonElement>('[data-act="latex-bib"]');
  const latexExportBtn = root.querySelector<HTMLButtonElement>('[data-act="latex-export"]');
  if (latexPaletteBtn) on(latexPaletteBtn, 'click', () => latexStudio?.togglePalette());
  if (latexOutlineBtn) on(latexOutlineBtn, 'click', () => latexStudio?.toggleOutline());
  if (latexBibBtn) on(latexBibBtn, 'click', () => latexStudio?.toggleBibMacros());
  if (latexExportBtn) on(latexExportBtn, 'click', () => latexStudio?.openTexExport());

  // Keep studio-bar aria-expanded in sync with each LaTeX drawer's hidden state.
  const drawerPairs: Array<[HTMLButtonElement | null, HTMLElement | null]> = [
    [latexPaletteBtn, root.querySelector<HTMLElement>('[data-latex-palette]')],
    [latexOutlineBtn, root.querySelector<HTMLElement>('[data-latex-outline]')],
    [latexBibBtn, root.querySelector<HTMLElement>('[data-latex-bibmacros]')],
  ];
  if ('MutationObserver' in window) {
    const syncDrawerAria = () => {
      for (const [btn, panel] of drawerPairs) {
        if (btn && panel) btn.setAttribute('aria-expanded', String(!panel.hidden));
      }
    };
    const mo = new MutationObserver(syncDrawerAria);
    for (const [, panel] of drawerPairs) {
      if (panel) mo.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    }
    signal.addEventListener('abort', () => mo.disconnect());
  }

  modeBtns.forEach((b) => on(b, 'click', () => setLayout(b.dataset.mode as Layout)));
  on(q('[data-act="focus"]'), 'click', () => toggleFocus());
  on(metaBtn, 'click', () => (meta.hidden ? openDetails() : closeDetails()));
  // Escape (from the [ details ] button or anywhere in the panel) closes it
  // and goes back to where you were writing — same as clicking the button.
  // A native picker (select, date) that's open eats its own Escape first.
  const escDetails = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || meta.hidden || e.defaultPrevented) return;
    e.preventDefault();
    const fromPanel = meta.contains(document.activeElement);
    closeDetails();
    // The focused field just got hidden: hand focus to the button that opens it.
    if (fromPanel || document.activeElement === document.body) metaBtn.focus({ preventScroll: true });
  };
  on(metaBtn, 'keydown', escDetails);
  on(meta, 'keydown', escDetails);
  on(keysBtn, 'click', () => {
    keysPanel.hidden = !keysPanel.hidden;
    keysBtn.setAttribute('aria-expanded', String(!keysPanel.hidden));
  });
  on(publishBtn, 'click', publishNow);
  on(window, 'resize', queueGutter);
  on(document, 'astro:before-swap', () => document.documentElement.classList.remove('write-focus'));

  // ---- your place (caret, direction, scroll), kept across reloads and back/forward ----------
  const PLACE = `write:${slug}:place`;
  const bodyKey = (b: string) => {
    let h = 5381;
    for (let i = 0; i < b.length; i += 1) h = ((h * 33) ^ b.charCodeAt(i)) >>> 0;
    return `${b.length}:${h}`;
  };
  const savePlace = () => {
    if (layout !== 'preview' && !away.size) {
      spot = { y: window.scrollY, s: ta.selectionStart, e: ta.selectionEnd, d: ta.selectionDirection as Dir, typing: document.activeElement === ta };
    }
    try {
      localStorage.setItem(PLACE, JSON.stringify({ k: bodyKey(ta.value), ...spot }));
    } catch {}
  };
  let placeTimer = 0;
  const queuePlace = () => {
    clearTimeout(placeTimer);
    placeTimer = window.setTimeout(savePlace, 300);
  };
  on(document, 'selectionchange', () => {
    if (document.activeElement === ta) {
      queuePlace();
      latexStudio?.handleSelection();
    }
  });
  on(window, 'scroll', queuePlace);
  on(window, 'pagehide', savePlace);
  on(document, 'astro:before-preparation', savePlace);

  // ---- start ---------------------------------------------------------------------------------
  fill(doc.fields, doc.body);
  lastSaved = snapshot();
  ready = true;
  setStatus(serverSavedAt ? `draft saved ${hhmm(serverSavedAt)}` : savedLabel());
  if (!doc.fields.description) showMeta(true);

  const local = readLocal();
  if (local && !local.synced && (local.body !== doc.body || JSON.stringify(local.fields) !== JSON.stringify(collect()))) {
    const banner = q('[data-restore]');
    const delta = local.body.length - doc.body.length;
    const fieldsDiffer = JSON.stringify(local.fields) !== JSON.stringify(collect());
    const what = [
      delta ? `${delta > 0 ? '+' : '−'}${Math.abs(delta)} characters in the text` : local.body !== doc.body ? 'edits in the text' : '',
      fieldsDiffer ? 'changed details' : '',
    ]
      .filter(Boolean)
      .join(', ');
    banner.querySelector('span')!.textContent = `this browser kept newer changes from ${new Date(local.at).toLocaleString()} that the server doesn't have (${what}).`;
    banner.hidden = false;
    on(q('[data-restore-yes]'), 'click', () => {
      fill(local.fields, local.body, true);
      banner.hidden = true;
      edited();
    });
    on(q('[data-restore-no]'), 'click', () => {
      dropLocal();
      banner.hidden = true;
      renderState();
    });
  }
  renderState();
  sizeSubtitle();
  refreshTray(); // fills the [ media n ] count
  // Split workspace: saved splitter position, preview font, sync toggle, then the layout.
  setSplit(Number(store.get(SPLIT_KEY)) || 50, false);
  setPreviewFont(postFont());
  paintSync();
  paintCount();
  paintHead();
  setLayout(wanted, false);
  paintModes();

  if (older) {
    const banner = q('[data-older]');
    const draft = older;
    q('[data-older-time]').textContent = new Date(draft.savedAt).toLocaleString();
    banner.hidden = false;
    on(q('[data-older-yes]'), 'click', () => {
      fill(draft.fields, draft.body, true);
      banner.hidden = true;
      edited();
    });
    on(q('[data-older-no]'), 'click', async () => {
      banner.hidden = true;
      await api(`/api/write/post?slug=${encodeURIComponent(slug)}`, 'DELETE').catch(() => {});
    });
  }

  // Come back to exactly where you were if the text is unchanged; otherwise
  // start at the top with the cursor at the beginning. (Focusing a long post's
  // textarea normally scrolls to the cursor at the very end.) On touch screens
  // nothing is focused, so the keyboard doesn't pop up by itself.
  let saved: (typeof spot & { k: string }) | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(PLACE) || 'null');
  } catch {}
  if (saved && saved.k === bodyKey(ta.value)) {
    const p = saved;
    ta.setSelectionRange(p.s, p.e, p.d);
    if (p.typing && !coarse()) ta.focus({ preventScroll: true });
    spot = { y: p.y, s: p.s, e: p.e, d: p.d, typing: p.typing };
    // Once the text is laid out in its real font — unless you've already moved.
    let moved = false;
    const stop = () => (moved = true);
    for (const t of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(t, stop, { once: true, capture: true, signal });
    const settle = () => !signal.aborted && !moved && window.scrollTo({ top: p.y, behavior: 'instant' });
    window.setTimeout(settle, 0);
    (document.fonts?.ready ?? Promise.resolve()).then(() => window.setTimeout(settle, 0));
  } else {
    if (doc.fields.title) {
      ta.setSelectionRange(0, 0);
      if (!coarse()) ta.focus({ preventScroll: true });
    } else if (!coarse()) field('title').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}
