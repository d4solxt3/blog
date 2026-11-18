/**
 * /_admin → [pages]: arrange the boxes on the home page and the about page.
 *
 * Every edit is previewed live: the unsaved list goes to
 * /_admin/api/widget-draft (memory only) and the preview reloads with
 * ?widget-preview. Fields show what the site shows now; a field left as it
 * is stays linked to site settings (only real changes are stored).
 *
 * Saving only ever calls PUT /_admin/api/config with { widgets } and/or
 * { aboutWidgets } (merged into site.config.json on this computer). It never
 * publishes: that stays the settings tab's own "Save to …" button.
 */
import { CONFIG_KEY, MEDIA_SRC, WIDGET_TYPES, isPinned, legacyWidgets, onPage, type Widget, type WidgetPage, type WidgetType } from '../lib/widget-types';

type Item = Widget & { key: number };
type PageState = { items: Item[]; saved: string; fromConfig: boolean };

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s)!;
let seq = 0;
let page: WidgetPage = 'home';
const state: Record<WidgetPage, PageState> = { home: { items: [], saved: '', fromConfig: false }, about: { items: [], saved: '', fromConfig: false } };
let config: Record<string, any> = {};
let selected: number | null = null;
let loaded = false;

const items = () => state[page].items;
const setItems = (next: Item[]) => (state[page].items = next);
const pinned = (t: WidgetType) => isPinned(t, page);

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/_admin/api/${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const status = (t: string) => ($('#wg-status').textContent = `> ${t}`);
const toItem = (w: Partial<Widget>, pg: WidgetPage = page): Item => ({
  key: ++seq,
  id: String(w.id ?? w.type),
  type: w.type as WidgetType,
  area: isPinned(w.type as WidgetType, pg) ? 'main' : w.area === 'main' ? 'main' : 'side',
  width: w.width === 'half' ? 'half' : 'full',
  enabled: isPinned(w.type as WidgetType, pg) || w.enabled !== false,
  props: w.props && typeof w.props === 'object' ? structuredClone(w.props) : {},
});
const serialise = (pg: WidgetPage = page) =>
  state[pg].items.map(({ id, type, area, width, enabled, props }) => {
    const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));
    return { id, type, area, ...(area === 'main' && width === 'half' ? { width } : {}), enabled, props: clean };
  });
const isDirty = (pg: WidgetPage = page) => JSON.stringify(serialise(pg)) !== state[pg].saved;
const anyDirty = () => isDirty('home') || isDirty('about');

/** What the site shows for a field when the box doesn't override it. */
function fallback(item: Item, k: string): any {
  const p = config.profile ?? {};
  switch (k) {
    case 'title':
      return item.type === 'avatar' ? `@${String(config.authorHandle ?? 'anon').replace(/^@/, '')}` : WIDGET_TYPES[item.type].label;
    case 'text':
      if (item.type === 'about') return String(config.intro || config.siteSubtitle || '');
      if (item.type === 'note') return String(config.notice ?? '');
      if (item.type === 'hello') return (p.bio ?? []).join('\n\n');
      return '';
    case 'items':
      return Array.isArray(p.links) ? p.links : [];
    case 'list':
      return Array.isArray(p.interests) ? p.interests : [];
    case 'max':
      return item.type === 'recent' ? 5 : '';
    case 'weekStart':
      return 'mon';
    case 'track':
      return String(item.props.src ?? '').split('/').pop()?.replace(/\.[a-z0-9]+$/i, '') ?? '';
    default:
      return undefined;
  }
}
const titleOf = (i: Item) => String(i.props.title || fallback(i, 'title'));

function uniqueId(base: string) {
  const ids = new Set(items().map((i) => i.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function paintDirty() {
  const d = anyDirty();
  ($('#wg-save') as HTMLButtonElement).disabled = !d;
  ($('#wg-revert') as HTMLButtonElement).disabled = !d;
  $('#wg-save').textContent = d ? 'save locally *' : 'save locally';
  document.querySelectorAll<HTMLElement>('[data-wg-page]').forEach((b) => {
    b.textContent = `${b.dataset.wgPage}${isDirty(b.dataset.wgPage as WidgetPage) ? ' *' : ''}`;
  });
}

// ------------------------------------------------------------------ the board
function render() {
  for (const area of ['side', 'main'] as const) {
    const list = $(`[data-list="${area}"]`);
    list.replaceChildren(
      ...items()
        .filter((i) => i.area === area)
        .map((i) => {
          const li = document.createElement('li');
          li.className = 'wg-item';
          li.dataset.key = String(i.key);
          li.draggable = true;
          li.classList.toggle('is-off', !i.enabled);
          li.classList.toggle('is-sel', selected === i.key);
          const title = titleOf(i).replace(/"/g, '');
          const half = i.area === 'main' && i.width === 'half';
          const pin = pinned(i.type);
          li.innerHTML = `
            <span class="wg-grip" aria-hidden="true">⋮⋮</span>
            <button type="button" class="wg-name" data-act="select" aria-pressed="${selected === i.key}">
              <b></b><small></small>
            </button>
            <span class="wg-tools">
              ${pin ? '<span class="wg-pin" title="always shown">pinned</span>' : `<label class="wg-on" title="show this box"><input type="checkbox" data-act="toggle" ${i.enabled ? 'checked' : ''}/> on</label>`}
              ${i.area === 'main' && !pin ? `<button type="button" class="bevel wg-t" data-act="half" aria-pressed="${half}" title="half width: two half boxes in a row sit side by side">½</button>` : ''}
              <button type="button" class="bevel wg-t" data-act="up" aria-label="Move ${title} up">↑</button>
              <button type="button" class="bevel wg-t" data-act="down" aria-label="Move ${title} down">↓</button>
              ${pin ? '' : `<button type="button" class="bevel wg-t" data-act="move" aria-label="Move ${title} to the ${i.area === 'main' ? 'sidebar' : 'main column'}">${i.area === 'main' ? '←' : '→'}</button>`}
              ${pin ? '' : `<button type="button" class="bevel wg-t" data-act="remove" aria-label="Remove ${title}">×</button>`}
            </span>`;
          $('b', li).textContent = titleOf(i);
          $('small', li).textContent = `${i.type}${half ? ' · half' : ''}${i.enabled ? '' : ' · off'}`;
          return li;
        }),
    );
  }
  paintDirty();
  queuePreview();
}

function move(key: number, dir: -1 | 1) {
  const list = items();
  const i = list.findIndex((x) => x.key === key);
  const area = list[i].area;
  let j = i + dir;
  while (j >= 0 && j < list.length && list[j].area !== area) j += dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  render();
  focusAct(key, dir < 0 ? 'up' : 'down');
}

function focusAct(key: number, act: string) {
  document.querySelector<HTMLElement>(`.wg-item[data-key="${key}"] [data-act="${act}"]`)?.focus();
}

function onBoardClick(e: Event) {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  const li = btn?.closest<HTMLElement>('.wg-item');
  if (!btn || !li) return;
  if (e.type === 'click' && btn.dataset.act === 'toggle') return; // handled on change
  const key = Number(li.dataset.key);
  const item = items().find((x) => x.key === key)!;
  switch (btn.dataset.act) {
    case 'select':
      selected = key;
      render();
      renderProps();
      focusAct(key, 'select');
      break;
    case 'toggle':
      item.enabled = (btn as HTMLInputElement).checked;
      render();
      focusAct(key, 'toggle');
      break;
    case 'half':
      item.width = item.width === 'half' ? 'full' : 'half';
      render();
      focusAct(key, 'half');
      break;
    case 'up':
      move(key, -1);
      break;
    case 'down':
      move(key, 1);
      break;
    case 'move': {
      const rest = items().filter((x) => x !== item);
      item.area = item.area === 'main' ? 'side' : 'main';
      rest.splice(rest.map((x) => x.area).lastIndexOf(item.area) + 1, 0, item);
      setItems(rest);
      render();
      focusAct(key, 'move');
      break;
    }
    case 'remove':
      if (!confirm(`Remove the "${titleOf(item)}" box? (Nothing is saved until you press save locally.)`)) return;
      setItems(items().filter((x) => x.key !== key));
      if (selected === key) selected = null;
      render();
      renderProps();
      break;
  }
}

let dragKey: number | null = null;
function setupDrag() {
  const board = $('.wg-cols');
  board.addEventListener('dragstart', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('.wg-item');
    if (!li) return;
    dragKey = Number(li.dataset.key);
    li.classList.add('is-drag');
    e.dataTransfer?.setData('text/plain', li.dataset.key!);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  board.addEventListener('dragend', () => {
    dragKey = null;
    board.querySelectorAll('.is-drag, .is-over').forEach((n) => n.classList.remove('is-drag', 'is-over'));
  });
  board.addEventListener('dragover', (e) => {
    if (dragKey === null) return;
    const col = (e.target as HTMLElement).closest<HTMLElement>('.wg-col');
    if (!col) return;
    const item = items().find((x) => x.key === dragKey)!;
    if (pinned(item.type) && col.dataset.area !== 'main') return;
    e.preventDefault();
    board.querySelectorAll('.is-over').forEach((n) => n.classList.remove('is-over'));
    col.classList.add('is-over');
  });
  board.addEventListener('drop', (e) => {
    if (dragKey === null) return;
    const col = (e.target as HTMLElement).closest<HTMLElement>('.wg-col');
    if (!col) return;
    e.preventDefault();
    const area = col.dataset.area as 'main' | 'side';
    const list = items();
    const [item] = list.splice(list.findIndex((x) => x.key === dragKey), 1);
    item.area = area;
    const over = (e.target as HTMLElement).closest<HTMLElement>('.wg-item');
    let at: number;
    if (over && Number(over.dataset.key) !== item.key) {
      const r = over.getBoundingClientRect();
      at = list.findIndex((x) => x.key === Number(over.dataset.key)) + (e.clientY > r.top + r.height / 2 ? 1 : 0);
    } else at = list.map((x) => x.area).lastIndexOf(area) + 1;
    list.splice(at, 0, item);
    render();
  });
}

// ------------------------------------------------------------- the properties
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
function field(label: string, input: string, hint = '') {
  return `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
}
const linesOf = (kind: string | undefined, v: any) =>
  kind === 'links' ? (Array.isArray(v) ? v.map((l: any) => `${l.label} | ${l.url}`).join('\n') : '') : kind === 'lines' ? (Array.isArray(v) ? v.join('\n') : '') : v;
const parseKind = (kind: string | undefined, text: string) =>
  kind === 'links'
    ? text
        .split('\n')
        .map((line) => {
          const [label, ...rest] = line.split('|');
          return { label: (label || '').trim(), url: rest.join('|').trim() };
        })
        .filter((l) => l.label && l.url)
    : kind === 'lines'
      ? text.split('\n').map((s) => s.trim()).filter(Boolean)
      : text;

function renderProps() {
  const box = $('#wg-props');
  const item = items().find((x) => x.key === selected);
  if (!item) {
    $('#wg-props-title').textContent = 'properties';
    box.innerHTML = '<p class="empty-state">pick a box on the left to edit it.</p>';
    return;
  }
  const meta = WIDGET_TYPES[item.type];
  $('#wg-props-title').textContent = `${item.id}.props`;
  const has = (k: string) => (meta.props as readonly string[]).includes(k);
  const linked = (from: string) => `shown from site settings → ${from}; change it here to give this box its own`;
  const parts: string[] = [`<p class="wg-note">${meta.note}</p>`];
  parts.push(field('id', `<input type="text" data-prop="@id" spellcheck="false" />`, 'a short name; it also keeps each box’s rolled-up state'));
  if (has('title')) parts.push(field('title', `<input type="text" data-prop="title" />`));
  if (has('text')) {
    const from = item.type === 'about' ? 'front_page.txt (intro)' : item.type === 'note' ? 'front_page.txt (side note)' : item.type === 'hello' ? 'bio.txt' : '';
    parts.push(field('text', `<textarea data-prop="text" rows="${item.type === 'hello' ? 7 : 4}"></textarea>`, from ? linked(from) : 'leave a blank line between paragraphs'));
  }
  if (has('max')) parts.push(field('show at most', `<input type="number" min="0" max="30" data-prop="max" placeholder="all" />`, 'newest first'));
  if (has('weekStart')) parts.push(field('weeks start on', `<select data-prop="weekStart"><option value="mon">monday</option><option value="sun">sunday</option></select>`));
  if (has('items')) parts.push(field('links', `<textarea data-prop="items" data-kind="links" rows="4"></textarea>`, `one per line: label | address. ${linked('bio.txt (links)')}`));
  if (has('list')) parts.push(field('interests', `<textarea data-prop="list" data-kind="lines" rows="4"></textarea>`, `one per line. ${linked('bio.txt (interests)')}`));
  if (item.type === 'media') {
    parts.push(`<div class="field"><span>file</span>
      <div class="drop-zone" id="wg-drop" tabindex="0">drop an image, .gif, .mp4 or .webm here, or <label class="drop-pick">choose a file<input type="file" id="wg-file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm" hidden /></label></div>
      <input type="text" data-prop="src" placeholder="/images/my-picture.gif" spellcheck="false" />
      <small id="wg-src-hint">files live in public/images (no svg, nothing from other sites)</small></div>`);
    parts.push(field('alt text', `<input type="text" data-prop="alt" />`, 'what the picture shows, for screen readers'));
    parts.push(`<label class="check"><input type="checkbox" data-prop="decorative" /> decorative only (no alt text needed)</label>`);
    parts.push(field('caption', `<input type="text" data-prop="caption" />`));
    parts.push(`<label class="check"><input type="checkbox" data-prop="tint" data-default="true" /> tint it to the theme (GIFs always keep their colours)</label>`);
    parts.push(field('link (optional)', `<input type="text" data-prop="href" placeholder="/posts/… or https://…" spellcheck="false" />`));
  }
  if (item.type === 'audio') {
    parts.push(`<div class="field"><span>track file</span>
      <div class="drop-zone" id="wg-drop" tabindex="0">drop an .mp3, .ogg or .wav here, or <label class="drop-pick">choose a file<input type="file" id="wg-file" accept="audio/mpeg,audio/ogg,audio/wav,.mp3,.ogg,.wav" hidden /></label></div>
      <input type="text" data-prop="src" placeholder="/audio/my-loop.mp3" spellcheck="false" />
      <small id="wg-src-hint">your own file, kept in public/audio (never streamed from another site). it never autoplays</small></div>`);
    parts.push(field('track title', `<input type="text" data-prop="track" />`));
    parts.push(`<label class="check"><input type="checkbox" data-prop="loop" data-default="true" /> loop the track</label>`);
  }
  if (!meta.props.length) parts.push('<p class="wg-note">this box takes its settings from site settings → look.cfg.</p>');
  box.innerHTML = parts.join('');

  box.querySelectorAll<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>('[data-prop]').forEach((el) => {
    const k = el.dataset.prop!;
    const kind = el.dataset.kind;
    const def = k === '@id' ? undefined : fallback(item, k);
    const v = k === '@id' ? item.id : item.props[k] ?? def;
    if (el.type === 'checkbox') el.checked = v === undefined ? el.dataset.default === 'true' : v === true;
    else el.value = String(linesOf(kind, v) ?? '');
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      if (k === '@id') {
        const clean = el.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '');
        if (clean && !items().some((x) => x !== item && x.id === clean)) item.id = clean;
        $('#wg-props-title').textContent = `${item.id}.props`;
      } else if (el.type === 'checkbox') {
        item.props[k] = el.checked;
        if (el.dataset.default === 'true' ? el.checked : !el.checked) delete item.props[k];
      } else {
        const next = el.type === 'number' ? (el.value === '' ? '' : Math.max(0, Number(el.value) || 0)) : parseKind(kind, el.value);
        // Same as what the site already shows: keep it linked instead of copying it.
        const same = JSON.stringify(kind ? next : String(next).trim()) === JSON.stringify(kind ? fallback(item, k) : String(fallback(item, k) ?? '').trim());
        if (same || next === '') delete item.props[k];
        else item.props[k] = next;
      }
      if (k === 'src') hintSrc(el.value, item.type === 'audio');
      render();
    });
  });
  if (item.type === 'media' || item.type === 'audio') {
    const isAudio = item.type === 'audio';
    hintSrc(String(item.props.src ?? ''), isAudio);
    const upload = async (file?: File | null) => {
      if (isAudio ? !file || !/\.(mp3|ogg|wav)$/i.test(file.name) : !file || !/^(image|video)\//.test(file.type) || /svg/.test(file.type))
        return status(isAudio ? 'pick an .mp3, .ogg or .wav file' : 'pick a png, jpg, gif, webp, avif, mp4 or webm file');
      status('uploading…');
      const data = await new Promise<string>((ok) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result));
        r.readAsDataURL(file);
      });
      try {
        const { path } = await api('upload', { method: 'POST', body: JSON.stringify({ name: file.name, data }) });
        const src = $<HTMLInputElement>('[data-prop="src"]', box);
        src.value = path;
        src.dispatchEvent(new Event('input'));
        status(`uploaded ${path} (into public/${isAudio ? 'audio' : 'images'} on this computer)`);
      } catch (err) {
        status(err instanceof Error ? err.message : String(err));
      }
    };
    $<HTMLInputElement>('#wg-file', box).addEventListener('change', (e) => upload((e.target as HTMLInputElement).files?.[0]));
    const zone = $('#wg-drop', box);
    ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => (e.preventDefault(), zone.classList.add('is-over'))));
    ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, () => zone.classList.remove('is-over')));
    zone.addEventListener('drop', (e) => (e.preventDefault(), upload((e as DragEvent).dataTransfer?.files[0])));
  }
}

const AUDIO_SRC = /^\/(audio|images)\/[a-z0-9._\/-]+\.(mp3|ogg|wav)$/i;
function hintSrc(src: string, audio = false) {
  const hint = document.querySelector('#wg-src-hint');
  if (!hint) return;
  const ok = !src || ((audio ? AUDIO_SRC : MEDIA_SRC).test(src) && !src.includes('..'));
  hint.textContent = audio
    ? ok ? 'your own file, kept in public/audio (never streamed from another site). it never autoplays' : '⚠ must be an .mp3, .ogg or .wav inside /audio/ or /images/'
    : ok ? 'files live in public/images (no svg, nothing from other sites)' : '⚠ must be a png, jpg, gif, webp, avif, mp4 or webm inside /images/';
  hint.classList.toggle('wg-warn', !ok);
}

// ---------------------------------------------------------- live preview
let previewTimer = 0;
let lastPushed = '';
function queuePreview(force = false) {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void pushPreview(force), 300);
}

async function pushPreview(force = false) {
  const widgets = serialise();
  const sig = `${page}:${JSON.stringify(widgets)}`;
  if (!force && sig === lastPushed) return;
  lastPushed = sig;
  try {
    await api('widget-draft', { method: 'PUT', body: JSON.stringify({ page, widgets }) });
    reloadPreview();
  } catch (err) {
    status(`preview failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function reloadPreview() {
  const frame = $<HTMLIFrameElement>('#wg-frame');
  const path = page === 'about' ? '/about/' : '/';
  // Keep the preview's scroll position across reloads.
  let y = 0;
  try {
    if (frame.contentWindow?.location.pathname === path) y = frame.contentWindow.scrollY;
  } catch {}
  frame.addEventListener(
    'load',
    () => {
      try {
        frame.contentWindow?.scrollTo(0, y);
      } catch {}
    },
    { once: true },
  );
  frame.src = `${path}?widget-preview=${Date.now()}`;
  $('#wg-preview-title').textContent = `${page === 'about' ? 'about_page' : 'front_page'}.preview — live, unsaved`;
}

// ------------------------------------------------------------- load and save
async function load() {
  config = await api('config');
  for (const pg of ['home', 'about'] as WidgetPage[]) {
    const raw = config[CONFIG_KEY[pg]];
    state[pg].fromConfig = Array.isArray(raw);
    state[pg].items = (Array.isArray(raw) ? raw : legacyWidgets(pg)).filter((w: any) => w && w.type in WIDGET_TYPES && onPage(w.type, pg)).map((w: Widget) => toItem(w, pg));
    state[pg].saved = JSON.stringify(serialise(pg));
  }
  selected = null;
  showPage(page);
}

function showPage(next: WidgetPage) {
  page = next;
  selected = null;
  document.querySelectorAll<HTMLElement>('[data-wg-page]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.wgPage === page)));
  const add = $<HTMLSelectElement>('#wg-add-type');
  add.innerHTML = (Object.keys(WIDGET_TYPES) as WidgetType[])
    .filter((t) => onPage(t, page) && !pinned(t))
    .map((t) => `<option value="${t}">${WIDGET_TYPES[t].label}</option>`)
    .join('');
  add.value = 'calendar';
  render();
  renderProps();
  queuePreview(true);
  status(state[page].fromConfig ? `editing the ${page} page (from site.config.json)` : `editing the ${page} page (classic layout; nothing saved yet)`);
}

export async function saveWidgets() {
  const btn = $<HTMLButtonElement>('#wg-save');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const body: Record<string, unknown> = {};
    for (const pg of ['home', 'about'] as WidgetPage[]) if (isDirty(pg)) body[CONFIG_KEY[pg]] = serialise(pg);
    await api('config', { method: 'PUT', body: JSON.stringify(body) });
    for (const pg of ['home', 'about'] as WidgetPage[]) {
      if (!(CONFIG_KEY[pg] in body)) continue;
      state[pg].saved = JSON.stringify(body[CONFIG_KEY[pg]]);
      state[pg].fromConfig = true;
    }
    status(`saved locally at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: on this computer only, not published`);
  } catch (err) {
    status(`could not save: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    paintDirty();
  }
}

export function openWidgets() {
  if (loaded) return;
  loaded = true;
  $('#wg-add').addEventListener('click', () => {
    const type = $<HTMLSelectElement>('#wg-add-type').value as WidgetType;
    const item = toItem({ type, id: uniqueId(type), area: 'side', enabled: true, props: {} });
    items().push(item);
    selected = item.key;
    render();
    renderProps();
    status(`added a ${WIDGET_TYPES[type].label} box to the bottom of the sidebar`);
    focusAct(item.key, 'select');
  });
  document.querySelectorAll<HTMLElement>('[data-wg-page]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.wgPage as WidgetPage)));
  $('.wg-cols').addEventListener('click', onBoardClick);
  $('.wg-cols').addEventListener('change', onBoardClick);
  setupDrag();
  $('#wg-save').addEventListener('click', () => void saveWidgets());
  $('#wg-reload').addEventListener('click', () => void pushPreview(true));
  $('#wg-revert').addEventListener('click', () => void load());
  $('#wg-classic').addEventListener('click', () => {
    if (!confirm(`Go back to the classic ${page} page? Your extra boxes there are removed (nothing is saved until you press save locally).`)) return;
    setItems(legacyWidgets(page).map((w) => toItem(w)));
    selected = null;
    render();
    renderProps();
    status(`classic ${page} layout: press save locally to keep it`);
  });
  window.addEventListener('beforeunload', (e) => {
    if (anyDirty()) e.preventDefault();
  });
  load().catch((err) => status(`could not load: ${err.message}`));
}
