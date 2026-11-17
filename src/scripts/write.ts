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
};
type Doc = { slug: string; ext: 'md' | 'mdx'; fields: Fields; body: string; extra: Record<string, unknown> };
type Draft = Doc & { savedAt: number; basis: string | null };
type Data = {
  slug: string;
  mode: 'local' | 'github' | 'off';
  published: { doc: Doc; sha: string } | null;
  draft: Draft | null;
  siteFont: string;
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

async function api(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Error ${res.status}`), { status: res.status, field: data.field });
  return data;
}

export function initWriter(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>('[data-studio]');
  if (!root) return;
  const data: Data = JSON.parse(root.querySelector('[data-studio-data]')?.textContent || '{}');
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const field = <T extends HTMLElement = HTMLInputElement>(name: string) => root.querySelector<T>(`[data-f="${name}"]`)!;
  const on = (el: EventTarget, type: string, fn: (e: any) => void) => el.addEventListener(type, fn, { signal });

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
    };
  }

  function fill(f: Fields, body: string) {
    field('title').value = f.title;
    subtitle.value = f.subtitle;
    field<HTMLTextAreaElement>('description').value = f.description;
    field('tags').value = f.tags.join(', ');
    field('date').value = f.date;
    field('series').value = f.series;
    field('seriesOrder').value = f.seriesOrder === null ? '' : String(f.seriesOrder);
    field<HTMLSelectElement>('font').value = f.font;
    root.querySelectorAll<HTMLInputElement>('[data-f="draft"]').forEach((r) => (r.checked = (r.value === 'draft') === f.draft));
    field('pinned').checked = f.pinned;
    ta.value = body;
    applyFont();
    syncPublishLabel();
    autosize();
    queueGutter();
    renderPicks();
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
    publishBtn.textContent = draft ? (data.mode === 'local' ? '[ save file ]' : '[ commit draft ]') : '[ publish ]';
    publishBtn.title = draft
      ? 'Saves the post with draft: true (hidden on the live site)'
      : data.mode === 'github'
        ? 'Commits to GitHub; live after Railway rebuilds'
        : `Writes content/posts/${slug}.${ext}`;
  }

  function setStatus(text: string, state: 'saved' | 'saving' | 'edited' | 'error' = 'saved') {
    statusEl.textContent = text;
    statusEl.dataset.state = state;
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

  function edited() {
    writeLocal(false);
    clearTimeout(timer);
    renderState();
    if (snapshot() === lastSaved) return setStatus(savedLabel());
    setStatus('not saved yet', 'edited');
    timer = window.setTimeout(save, 2500);
  }

  async function save(): Promise<void> {
    clearTimeout(timer);
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
      setStatus(code === 401 ? 'server: signed out' : 'server: offline', 'error');
      timer = window.setTimeout(save, 10_000);
    } finally {
      saving = false;
      renderState();
    }
  }

  // Leaving the page with unsaved edits: send them on the way out.
  const flush = () => {
    if (snapshot() === lastSaved) return;
    writeLocal(false);
    const body = JSON.stringify(payload());
    fetch('/api/write/post', { method: 'PUT', keepalive: body.length < 60_000, headers: { 'content-type': 'application/json' }, body }).catch(() => {});
  };
  on(window, 'pagehide', flush);
  on(document, 'astro:before-preparation', flush);

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

  /** Remove the "/query" the menu was opened with, then run the block. */
  const atSlash = (fn: (pos: number) => void) => () => {
    const pos = ta.selectionStart;
    const start = lineStartOf(pos);
    replace(start, pos, '');
    fn(start);
  };
  const template = (tpl: string) => () => {
    const pos = ta.selectionStart;
    insertTemplate(lineStartOf(pos), pos, tpl);
  };

  const BLOCKS: { label: string; hint?: string; keys: string; run: () => void }[] = [
    { label: 'H2 subtitle', hint: '##', keys: 'h2 heading subtitle', run: template('## ') },
    { label: 'H3 sub-subtitle', hint: '###', keys: 'h3 heading', run: template('### ') },
    { label: 'TL;DR box', keys: 'tldr summary box', run: template('> [!TLDR]\n> ') },
    { label: 'Epistemic status', keys: 'epistemic status confidence', run: template('> [!EPISTEMIC] Epistemic status\n> ') },
    {
      label: 'Collapsible <details>',
      keys: 'details collapsible toggle',
      run: template(`<details>\n<summary>${SEL_START}Title${SEL_END}</summary>\n\nHidden text goes here.\n\n</details>\n`),
    },
    { label: 'Math block $$', keys: 'math equation latex block', run: template(`$$\n${SEL_START}${SEL_END}\n$$\n`) },
    { label: 'Image / GIF', hint: 'upload', keys: 'image gif picture upload', run: atSlash(() => pickFile()) },
    { label: 'Footnote', hint: `${MOD}+shift+f`, keys: 'footnote note', run: atSlash(() => openFootnote()) },
    { label: 'Pull quote', keys: 'quote pull', run: template('> [!QUOTE] Who said it\n> ') },
  ];

  function detect() {
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return closeMenu();
    const start = lineStartOf(pos);
    const slash = ta.value.slice(start, pos).match(/^\/([\w;-]{0,20})$/);
    if (slash) {
      const query = slash[1].toLowerCase();
      // Best first: label starts with it, then a word starts with it, then it appears anywhere.
      const score = (b: (typeof BLOCKS)[number]) => {
        const label = b.label.toLowerCase();
        const words = `${label} ${b.keys}`.split(/[^a-z0-9$<]+/);
        if (!query || label.startsWith(query)) return 0;
        if (words.some((w) => w.startsWith(query))) return 1;
        if (label.includes(query) || b.keys.includes(query)) return 2;
        return 9;
      };
      const items = BLOCKS.map((b) => ({ b, s: score(b) }))
        .filter((x) => x.s < 9)
        .sort((x, y) => x.s - y.s)
        .map((x) => x.b);
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

  // ---- formatting bubble ------------------------------------------------------------
  const bubble = document.createElement('div');
  bubble.className = 'w-bubble';
  bubble.setAttribute('role', 'toolbar');
  bubble.setAttribute('aria-label', 'Format selection');
  bubble.hidden = true;
  const FORMATS: [string, string, string][] = [
    ['bold', 'B', `${MOD}+b`],
    ['italic', 'I', `${MOD}+i`],
    ['code', '</>', ''],
    ['link', 'link', `${MOD}+k`],
    ['math', '$', ''],
    ['quote', '“', ''],
  ];
  bubble.innerHTML = FORMATS.map(
    ([id, label, key]) => `<button type="button" data-fmt="${id}" title="${id}${key ? ` (${key})` : ''}" aria-label="${id}">${esc(label)}</button>`,
  ).join('');
  wrap.append(bubble);
  on(bubble, 'mousedown', (e: MouseEvent) => e.preventDefault());
  on(bubble, 'click', (e: MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-fmt]');
    if (b) fmt(b.dataset.fmt!);
  });

  function showBubble() {
    if (document.activeElement !== ta || ta.selectionStart === ta.selectionEnd || menu) return hideBubble();
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

  function fmt(kind: string) {
    const { selectionStart: s, selectionEnd: e } = ta;
    if (kind === 'bold') wrapSelection('**', '**', 'bold text');
    else if (kind === 'italic') wrapSelection('*', '*', 'italic text');
    else if (kind === 'code') wrapSelection('`', '`', 'code');
    else if (kind === 'math') wrapSelection('$', '$', 'x^2');
    else if (kind === 'link') {
      const text = ta.value.slice(s, e).trim();
      if (/^https?:\/\/\S+$/.test(text)) replace(s, e, `[link text](${text})`, s + 1, s + 10);
      else {
        const label = text || 'link text';
        const url = s + label.length + 3;
        replace(s, e, `[${label}](https://)`, url, url + 8);
      }
    } else if (kind === 'quote') {
      const start = lineStartOf(s);
      let end = ta.value.indexOf('\n', e);
      if (end < 0) end = ta.value.length;
      const lines = ta.value.slice(start, end).split('\n');
      const quoted = lines.every((l) => l.startsWith('>'));
      const out = lines.map((l) => (quoted ? l.replace(/^> ?/, '') : `> ${l}`)).join('\n');
      replace(start, end, out, start, start + out.length);
    }
    requestAnimationFrame(showBubble);
  }

  // ---- footnotes ------------------------------------------------------------------------
  const footEl = makePop('w-foot');
  footEl.innerHTML = '<label for="w-foot-in">footnote</label><input id="w-foot-in" type="text" autocomplete="off" placeholder="type the note, then enter" />';
  const footInput = footEl.querySelector('input')!;
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
  on(footInput, 'blur', () => window.setTimeout(() => document.activeElement !== footInput && (footEl.hidden = true), 150));

  // ---- images: upload, insert, thumbnails ---------------------------------------------
  const mediaSrc = new Map<string, string>();
  const pickFile = () => {
    fileInput.value = '';
    fileInput.click();
  };
  on(fileInput, 'change', () => upload([...(fileInput.files ?? [])]));

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
      const token = `![uploading ${Math.random().toString(36).slice(2, 7)}…]()`;
      const pos = ta.selectionEnd;
      const before = ta.value.slice(0, pos);
      const after = ta.value.slice(pos);
      const pre = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const post = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
      replace(pos, pos, `${pre}${token}${post}`);
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
        mediaSrc.set(d.path, d.src);
        swapToken(token, `![](${d.path})`);
        say(null);
      } catch (err) {
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
    const found = [...ta.value.matchAll(IMG_RE)].filter((m) => !m[1].startsWith('uploading') && m[2]);
    gutter.replaceChildren(
      ...found.map((m) => {
        const src = thumbSrc(m[2]);
        const a = document.createElement('a');
        a.className = 'w-thumb';
        a.href = src;
        a.target = '_blank';
        a.rel = 'noopener';
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.src = src;
        if (src !== m[2]) img.onerror = () => ((img.onerror = null), (img.src = m[2]));
        const cap = document.createElement('span');
        cap.textContent = m[2].split('/').pop() ?? '';
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

  // ---- preview, focus, details ------------------------------------------------------------
  // Where you were before preview / details, so coming back puts the cursor and page back.
  let spot = { y: 0, s: 0, e: 0 };
  const remember = () => (spot = { y: window.scrollY, s: ta.selectionStart, e: ta.selectionEnd });

  async function togglePreview(force?: boolean) {
    const show = force ?? preview.hidden;
    q('[data-act="preview"]').setAttribute('aria-pressed', String(show));
    if (!show) {
      preview.hidden = true;
      wrap.hidden = false;
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(spot.s, spot.e);
      window.scrollTo(0, spot.y);
      return;
    }
    remember();
    closeMenu();
    hideBubble();
    preview.hidden = false;
    wrap.hidden = true;
    preview.innerHTML = '<p class="studio-note">rendering…</p>';
    try {
      const { html } = await api('/api/write/preview', 'POST', { slug, body: ta.value });
      preview.innerHTML = html || '<p class="studio-note">nothing to preview yet.</p>';
    } catch (err) {
      preview.innerHTML = `<p class="studio-note">couldn't render the preview: ${esc(err instanceof Error ? err.message : 'error')}</p>`;
    }
  }

  function toggleFocus(force?: boolean) {
    const active = document.documentElement.classList.toggle('write-focus', force);
    q('[data-act="focus"]').setAttribute('aria-pressed', String(active));
    if (active) showMeta(false);
  }

  /** Open/close the details drawer without the text jumping on screen. */
  function showMeta(open: boolean) {
    if (meta.hidden === !open) return;
    const before = ta.getBoundingClientRect().top;
    meta.hidden = !open;
    metaBtn.setAttribute('aria-expanded', String(open));
    if (!wrap.hidden) window.scrollBy(0, ta.getBoundingClientRect().top - before);
  }

  // ---- publish ---------------------------------------------------------------------------------
  function watchLive() {
    let tries = 0;
    const tick = async () => {
      if (signal.aborted || ++tries > 36) return;
      const live = await fetch(`/posts/${slug}/`, { method: 'HEAD', cache: 'no-store' })
        .then((r) => r.ok)
        .catch(() => false);
      if (live) say(`the post page now loads on the live site ✓ <a href="/posts/${slug}/">view post</a>`);
      else window.setTimeout(tick, 10_000);
    };
    window.setTimeout(tick, 15_000);
  }

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
      say('publishing from the live site needs a GITHUB_TOKEN on your host. your draft is saved. <a href="/write/settings/">settings</a>');
      return;
    }
    const live = data.mode === 'github';
    const question = f.draft
      ? live
        ? `Commit "${f.title}" to GitHub as a draft? It stays hidden on the live site.`
        : `Save "${f.title}" to content/posts as a draft?`
      : live
        ? `Publish "${f.title}"? It goes live after Railway rebuilds the site (about 1–2 minutes).`
        : `Save "${f.title}" to content/posts/${slug}.${ext}?`;
    if (!window.confirm(question)) return;
    clearTimeout(timer);
    publishBtn.disabled = true;
    setStatus('publishing…', 'saving');
    try {
      const { result } = await api('/api/write/post', 'POST', { slug, ext, extra, fields: f, body: ta.value });
      basis = result.sha;
      ext = String(result.path).endsWith('.mdx') ? 'mdx' : 'md';
      lastSaved = snapshot();
      serverSavedAt = 0;
      publishedDoc = { fields: f, body: ta.value };
      dropLocal();
      setStatus(savedLabel());
      renderState();
      const view = f.draft ? '' : ` · <a href="/posts/${slug}/">view post</a>`;
      if (result.mode === 'local') {
        say(`saved to ${esc(result.path)}${view}. it's on this computer only: commit and push (or ask Claude to ship it) to put it on the live site.`);
      } else if (f.draft) {
        say(`committed ${esc(result.commit)} as a draft. it stays hidden on the live site.`);
      } else {
        // Only the commit is known here; the rebuild happens on Railway's side.
        say(`committed ${esc(result.commit)} to github. railway rebuilds the site from it, so the change appears once that finishes (usually a minute or two).`);
        if (result.created) watchLive();
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

  // ---- wiring ---------------------------------------------------------------------------------
  root.querySelectorAll<HTMLInputElement>('[data-f]').forEach((el) => {
    const instant = el.tagName === 'SELECT' || el.type === 'radio' || el.type === 'checkbox';
    on(el, instant ? 'change' : 'input', () => {
      if (el.dataset.f === 'font') applyFont();
      if (el.dataset.f === 'draft') syncPublishLabel();
      if (el.dataset.f === 'tags' || el.dataset.f === 'series') renderPicks();
      if (el === subtitle) sizeSubtitle();
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
    queueGutter();
    hideBubble();
  });
  on(ta, 'click', detect);
  on(ta, 'mouseup', () => window.setTimeout(showBubble, 0));
  on(ta, 'keyup', (e: KeyboardEvent) => {
    if (e.shiftKey || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) showBubble();
    else if (ta.selectionStart === ta.selectionEnd) hideBubble();
  });
  on(ta, 'blur', () =>
    window.setTimeout(() => {
      if (document.activeElement === ta || footEl.contains(document.activeElement)) return;
      closeMenu();
      hideBubble();
    }, 120),
  );
  on(ta, 'keydown', (e: KeyboardEvent) => {
    if (menu) {
      if (e.key === 'ArrowDown') return e.preventDefault(), moveMenu(1);
      if (e.key === 'ArrowUp') return e.preventDefault(), moveMenu(-1);
      if ((e.key === 'Enter' || e.key === 'Tab') && menu.items.length) return e.preventDefault(), pickMenu();
      if (e.key === 'Escape') return e.preventDefault(), closeMenu();
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    // (No Ctrl+E for code: browsers use it for the address bar. The bubble has a code button.)
    const formats: Record<string, string> = { b: 'bold', i: 'italic', k: 'link' };
    if (!e.shiftKey && formats[k]) {
      e.preventDefault();
      fmt(formats[k]);
    } else if (e.shiftKey && k === 'f') {
      e.preventDefault();
      openFootnote();
    }
  });

  on(document, 'keydown', (e: KeyboardEvent) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
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

  on(q('[data-act="preview"]'), 'click', () => togglePreview());
  on(q('[data-act="focus"]'), 'click', () => toggleFocus());
  on(metaBtn, 'click', () => {
    const opening = meta.hidden;
    if (opening) {
      if (document.activeElement === ta) remember();
      showMeta(true);
    } else {
      showMeta(false);
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(spot.s, spot.e);
    }
  });
  // Remember the cursor when the details button is pressed (it takes focus from the text).
  on(metaBtn, 'pointerdown', () => document.activeElement === ta && remember());
  on(keysBtn, 'click', () => {
    keysPanel.hidden = !keysPanel.hidden;
    keysBtn.setAttribute('aria-expanded', String(!keysPanel.hidden));
  });
  on(publishBtn, 'click', publishNow);
  on(window, 'resize', queueGutter);
  on(document, 'astro:before-swap', () => document.documentElement.classList.remove('write-focus'));

  // ---- start ---------------------------------------------------------------------------------
  fill(doc.fields, doc.body);
  lastSaved = snapshot();
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
      fill(local.fields, local.body);
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

  if (older) {
    const banner = q('[data-older]');
    const draft = older;
    q('[data-older-time]').textContent = new Date(draft.savedAt).toLocaleString();
    banner.hidden = false;
    on(q('[data-older-yes]'), 'click', () => {
      fill(draft.fields, draft.body);
      banner.hidden = true;
      edited();
    });
    on(q('[data-older-no]'), 'click', async () => {
      banner.hidden = true;
      await api(`/api/write/post?slug=${encodeURIComponent(slug)}`, 'DELETE').catch(() => {});
    });
  }

  (doc.fields.title ? ta : field('title')).focus();
}
