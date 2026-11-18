/**
 * /_admin → [front page]: arrange the front-page widgets.
 *
 * Saving only ever calls PUT /_admin/api/config with { widgets } (the server
 * merges it into site.config.json on this computer). It never publishes:
 * that stays the settings tab's own "Save to …" button.
 */
import { MEDIA_SRC, WIDGET_TYPES, legacyWidgets, type Widget, type WidgetType } from '../lib/widget-types';

type Item = Widget & { key: number };

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s)!;
const PINNED = new Set<WidgetType>(['about', 'feed']);
let seq = 0;
let items: Item[] = [];
let saved = '';
let selected: number | null = null;
let loaded = false;

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`/_admin/api/${path}`, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const status = (t: string) => ($('#wg-status').textContent = `> ${t}`);
const toItem = (w: Partial<Widget>): Item => ({
  key: ++seq,
  id: String(w.id ?? w.type),
  type: w.type as WidgetType,
  area: PINNED.has(w.type as WidgetType) ? 'main' : w.area === 'main' ? 'main' : 'side',
  width: w.width === 'half' ? 'half' : 'full',
  enabled: PINNED.has(w.type as WidgetType) || w.enabled !== false,
  props: w.props && typeof w.props === 'object' ? { ...w.props } : {},
});
const serialise = () =>
  items.map(({ id, type, area, width, enabled, props }) => {
    const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== '' && v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));
    return { id, type, area, ...(area === 'main' && width === 'half' ? { width } : {}), enabled, props: clean };
  });
const isDirty = () => JSON.stringify(serialise()) !== saved;

function uniqueId(base: string) {
  const ids = new Set(items.map((i) => i.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function paintDirty() {
  const d = isDirty();
  ($('#wg-save') as HTMLButtonElement).disabled = !d;
  ($('#wg-revert') as HTMLButtonElement).disabled = !d;
  $('#wg-save').textContent = d ? 'save locally *' : 'save locally';
}

// ------------------------------------------------------------------ the board
function render() {
  for (const area of ['side', 'main'] as const) {
    const list = $(`[data-list="${area}"]`);
    list.replaceChildren(
      ...items
        .filter((i) => i.area === area)
        .map((i) => {
          const li = document.createElement('li');
          li.className = 'wg-item';
          li.dataset.key = String(i.key);
          li.draggable = true;
          li.classList.toggle('is-off', !i.enabled);
          li.classList.toggle('is-sel', selected === i.key);
          const title = String(i.props.title || WIDGET_TYPES[i.type].label);
          const half = i.area === 'main' && i.width === 'half';
          li.innerHTML = `
            <span class="wg-grip" aria-hidden="true">⋮⋮</span>
            <button type="button" class="wg-name" data-act="select" aria-pressed="${selected === i.key}">
              <b></b><small></small>
            </button>
            <span class="wg-tools">
              ${PINNED.has(i.type) ? '<span class="wg-pin" title="always shown">pinned</span>' : `<label class="wg-on" title="show this box"><input type="checkbox" data-act="toggle" ${i.enabled ? 'checked' : ''}/> on</label>`}
              ${i.area === 'main' && !PINNED.has(i.type) ? `<button type="button" class="bevel wg-t" data-act="half" aria-pressed="${half}" title="half width: two half boxes in a row sit side by side">½</button>` : ''}
              <button type="button" class="bevel wg-t" data-act="up" aria-label="Move ${title} up">↑</button>
              <button type="button" class="bevel wg-t" data-act="down" aria-label="Move ${title} down">↓</button>
              ${PINNED.has(i.type) ? '' : `<button type="button" class="bevel wg-t" data-act="move" aria-label="Move ${title} to the ${i.area === 'main' ? 'sidebar' : 'main column'}">${i.area === 'main' ? '←' : '→'}</button>`}
              ${PINNED.has(i.type) ? '' : `<button type="button" class="bevel wg-t" data-act="remove" aria-label="Remove ${title}">×</button>`}
            </span>`;
          $('b', li).textContent = title;
          $('small', li).textContent = `${i.type}${half ? ' · half' : ''}${i.enabled ? '' : ' · off'}`;
          return li;
        }),
    );
  }
  paintDirty();
}

function move(key: number, dir: -1 | 1) {
  const i = items.findIndex((x) => x.key === key);
  const area = items[i].area;
  // Swap with the nearest neighbour in the same column.
  let j = i + dir;
  while (j >= 0 && j < items.length && items[j].area !== area) j += dir;
  if (j < 0 || j >= items.length) return;
  [items[i], items[j]] = [items[j], items[i]];
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
  const key = Number(li.dataset.key);
  const item = items.find((x) => x.key === key)!;
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
      // Lands at the bottom of the other column.
      items = items.filter((x) => x !== item);
      item.area = item.area === 'main' ? 'side' : 'main';
      items.splice(items.map((x) => x.area).lastIndexOf(item.area) + 1, 0, item);
      render();
      focusAct(key, 'move');
      break;
    }
    case 'remove':
      if (!confirm(`Remove the "${item.props.title || WIDGET_TYPES[item.type].label}" box? (Nothing is saved until you press save locally.)`)) return;
      items = items.filter((x) => x.key !== key);
      if (selected === key) selected = null;
      render();
      renderProps();
      break;
  }
}

// Drag and drop: within a column or across to the other one.
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
    const item = items.find((x) => x.key === dragKey)!;
    if (PINNED.has(item.type) && col.dataset.area !== 'main') return;
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
    const from = items.findIndex((x) => x.key === dragKey);
    const [item] = items.splice(from, 1);
    item.area = area;
    // Drop before the row under the pointer (or at the end of that column).
    const over = (e.target as HTMLElement).closest<HTMLElement>('.wg-item');
    let at = items.length;
    if (over && Number(over.dataset.key) !== item.key) {
      const r = over.getBoundingClientRect();
      at = items.findIndex((x) => x.key === Number(over.dataset.key)) + (e.clientY > r.top + r.height / 2 ? 1 : 0);
    } else {
      const lastInArea = items.map((x) => x.area).lastIndexOf(area);
      at = lastInArea + 1;
    }
    items.splice(at, 0, item);
    render();
  });
}

// ------------------------------------------------------------- the properties
function field(label: string, input: string, hint = '') {
  return `<label class="field"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
}

function renderProps() {
  const box = $('#wg-props');
  const item = items.find((x) => x.key === selected);
  if (!item) {
    $('#wg-props-title').textContent = 'properties';
    box.innerHTML = '<p class="empty-state">pick a box on the left to edit it.</p>';
    return;
  }
  const meta = WIDGET_TYPES[item.type];
  $('#wg-props-title').textContent = `${item.id}.props`;
  const has = (k: string) => (meta.props as readonly string[]).includes(k);
  const parts: string[] = [`<p class="wg-note">${meta.note}</p>`];
  parts.push(field('id', `<input type="text" data-prop="@id" spellcheck="false" />`, 'a short name; it also keeps each box’s rolled-up state'));
  if (has('title')) parts.push(field('title', `<input type="text" data-prop="title" placeholder="${meta.label}" />`, 'blank = the default'));
  if (has('text')) parts.push(field(item.type === 'text' ? 'text' : 'text (blank = the one in site settings)', `<textarea data-prop="text" rows="4"></textarea>`, item.type === 'text' ? 'leave a blank line between paragraphs' : ''));
  if (has('max')) parts.push(field('show at most', `<input type="number" min="0" max="50" data-prop="max" placeholder="all" />`, 'newest first; blank = all of them'));
  if (has('weekStart')) parts.push(field('weeks start on', `<select data-prop="weekStart"><option value="mon">monday</option><option value="sun">sunday</option></select>`));
  if (has('items') && item.type === 'links') parts.push(field('links', `<textarea data-prop="items" data-kind="links" rows="4" placeholder="github | https://github.com/you"></textarea>`, 'one per line: label | address. blank = your profile links'));
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
  if (!meta.props.length) parts.push('<p class="wg-note">this box takes its settings from site settings → look.cfg.</p>');
  box.innerHTML = parts.join('');

  box.querySelectorAll<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>('[data-prop]').forEach((el) => {
    const k = el.dataset.prop!;
    const v = k === '@id' ? item.id : item.props[k];
    if (el.type === 'checkbox') el.checked = v === undefined ? el.dataset.default === 'true' : v === true;
    else if (el.dataset.kind === 'links') el.value = Array.isArray(v) ? v.map((l: any) => `${l.label} | ${l.url}`).join('\n') : '';
    else el.value = v ?? (el.tagName === 'SELECT' ? (el as HTMLSelectElement).options[0].value : '');
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      if (k === '@id') {
        const clean = el.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '');
        if (clean && !items.some((x) => x !== item && x.id === clean)) item.id = clean;
        $('#wg-props-title').textContent = `${item.id}.props`;
      } else if (el.type === 'checkbox') {
        item.props[k] = el.checked;
        if (el.dataset.default === 'true' && el.checked) delete item.props[k];
        if (el.dataset.default !== 'true' && !el.checked) delete item.props[k];
      } else if (el.dataset.kind === 'links') {
        item.props[k] = el.value
          .split('\n')
          .map((line) => {
            const [label, ...rest] = line.split('|');
            return { label: (label || '').trim(), url: rest.join('|').trim() };
          })
          .filter((l) => l.label && l.url);
      } else if (el.type === 'number') {
        if (el.value === '') delete item.props[k];
        else item.props[k] = Math.max(0, Number(el.value) || 0);
      } else item.props[k] = el.value;
      if (k === 'src') hintSrc(el.value);
      render();
    });
  });
  if (item.type === 'media') {
    hintSrc(String(item.props.src ?? ''));
    const upload = async (file?: File | null) => {
      if (!file || !/^(image|video)\//.test(file.type) || /svg/.test(file.type)) return status('pick a png, jpg, gif, webp, avif, mp4 or webm file');
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
        status(`uploaded ${path} (into public/images on this computer)`);
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

function hintSrc(src: string) {
  const hint = document.querySelector('#wg-src-hint');
  if (!hint) return;
  const ok = !src || (MEDIA_SRC.test(src) && !src.includes('..'));
  hint.textContent = ok ? 'files live in public/images (no svg, nothing from other sites)' : '⚠ must be a png, jpg, gif, webp, avif, mp4 or webm inside /images/';
  hint.classList.toggle('wg-warn', !ok);
}

// ------------------------------------------------------------- load and save
async function load() {
  const config = await api('config');
  items = (Array.isArray(config.widgets) ? config.widgets : legacyWidgets()).filter((w: any) => w && w.type in WIDGET_TYPES).map(toItem);
  saved = JSON.stringify(serialise());
  selected = null;
  render();
  renderProps();
  status(Array.isArray(config.widgets) ? 'loaded your front page from site.config.json' : 'showing the classic layout (no widgets saved yet)');
}

function reloadPreview() {
  const frame = $<HTMLIFrameElement>('#wg-frame');
  frame.src = `/?widget-preview=${Date.now()}`;
}

export async function saveWidgets() {
  const btn = $<HTMLButtonElement>('#wg-save');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const widgets = serialise();
    await api('config', { method: 'PUT', body: JSON.stringify({ widgets }) });
    saved = JSON.stringify(widgets);
    status(`saved locally at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: on this computer only, not published`);
    setTimeout(reloadPreview, 400);
  } catch (err) {
    status(`could not save: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    paintDirty();
  }
}

export function openWidgets() {
  if (loaded) return;
  loaded = true;
  const add = $<HTMLSelectElement>('#wg-add-type');
  add.innerHTML = (Object.keys(WIDGET_TYPES) as WidgetType[])
    .filter((t) => !PINNED.has(t))
    .map((t) => `<option value="${t}">${WIDGET_TYPES[t].label}</option>`)
    .join('');
  add.value = 'calendar';
  $('#wg-add').addEventListener('click', () => {
    const type = add.value as WidgetType;
    const item = toItem({ type, id: uniqueId(type), area: 'side', enabled: true, props: {} });
    items.push(item);
    selected = item.key;
    render();
    renderProps();
    status(`added a ${WIDGET_TYPES[type].label} box to the bottom of the sidebar`);
    focusAct(item.key, 'select');
  });
  $('.wg-cols').addEventListener('click', onBoardClick);
  $('.wg-cols').addEventListener('change', onBoardClick);
  setupDrag();
  $('#wg-save').addEventListener('click', () => void saveWidgets());
  $('#wg-reload').addEventListener('click', reloadPreview);
  $('#wg-revert').addEventListener('click', () => void load());
  $('#wg-classic').addEventListener('click', () => {
    if (!confirm('Go back to the classic layout? Your extra boxes are removed (nothing is saved until you press save locally).')) return;
    items = legacyWidgets().map(toItem);
    selected = null;
    render();
    renderProps();
    status('classic layout: press save locally to keep it');
  });
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });
  load()
    .then(reloadPreview)
    .catch((err) => status(`could not load: ${err.message}`));
}
