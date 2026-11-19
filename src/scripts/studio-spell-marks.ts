import { preferredSpelling, type SpellingWord } from './spelling-words';
import type { SpellReply, SpellRequest } from './spelling.worker';

type Field = HTMLInputElement | HTMLTextAreaElement;
type Replacement = (field: Field, word: SpellingWord, replacement: string) => void;

function makeLayer(field: Field) {
  const layer = document.createElement('div');
  layer.className = 'spell-layer';
  layer.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('div');
  layer.append(copy);
  field.after(layer);
  return { field, layer, copy, source: '', revision: 0, timer: 0, issues: [] as SpellingWord[] };
}
type View = ReturnType<typeof makeLayer>;

// Match the real control's text metrics without replacing its editable text,
// selection, input method, gutter, or undo history.
function align({ field, layer, copy }: View) {
  layer.hidden = !field.clientWidth;
  if (layer.hidden) return;
  const style = getComputedStyle(field);
  for (const prop of ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-kerning',
    'font-variant-ligatures', 'font-variation-settings', 'letter-spacing', 'word-spacing', 'line-height',
    'text-align', 'text-indent', 'text-transform', 'direction', 'tab-size', 'padding', 'word-break']) {
    copy.style.setProperty(prop, style.getPropertyValue(prop));
  }
  const single = field instanceof HTMLInputElement;
  copy.style.whiteSpace = single ? 'pre' : 'pre-wrap';
  copy.style.overflowWrap = single ? 'normal' : 'break-word';
  layer.style.left = field.offsetLeft + field.clientLeft + 'px';
  layer.style.top = field.offsetTop + field.clientTop + 'px';
  layer.style.width = field.clientWidth + 'px';
  layer.style.height = field.clientHeight + 'px';
  if (single) copy.style.paddingTop = Math.max(0, (field.clientHeight - (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2)) / 2) + 'px';
  layer.scrollLeft = field.scrollLeft;
  layer.scrollTop = field.scrollTop;
}

export function initSpellMarks(root: HTMLElement, signal: AbortSignal, replace: Replacement) {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./spelling.worker.ts', import.meta.url), { type: 'module' });
  } catch { return; } // Native spellcheck is still enabled.
  const send = (message: SpellRequest) => worker.postMessage(message);
  const views = Array.from(root.querySelectorAll<Field>('[data-spelling]'), makeLayer);
  const ignored = new Set<string>();
  const menu = document.createElement('div');
  menu.className = 'spell-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  document.body.append(menu);
  let current: { view: View; item: SpellingWord; x: number; y: number; request: number } | null = null;
  let sequence = 0;
  let frame = 0;

  function close(restoreFocus = false) {
    const field = current?.view.field;
    current = null;
    menu.hidden = true;
    if (restoreFocus) field?.focus({ preventScroll: true });
  }
  function position() {
    if (!current) return;
    const x = Math.min(current.x, document.documentElement.clientWidth - menu.offsetWidth - 4);
    const y = Math.min(current.y, window.innerHeight - menu.offsetHeight - 4);
    menu.style.left = Math.max(4, x) + 'px';
    menu.style.top = Math.max(4, y) + 'px';
  }

  function paint(view: View) {
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const item of view.issues) {
      if (ignored.has(item.word.toLowerCase())) continue;
      frag.append(view.source.slice(last, item.start));
      const mark = document.createElement('span');
      mark.className = 'spell-word';
      mark.dataset.start = String(item.start);
      mark.textContent = item.word;
      frag.append(mark);
      last = item.start + item.word.length;
    }
    frag.append(view.source.slice(last));
    view.copy.replaceChildren(frag);
    align(view);
  }

  function showChoices(choices: string[], pending = false) {
    if (!current) return;
    const { view, item } = current;
    const focused = menu.contains(document.activeElement);
    menu.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'spell-menu-title';
    heading.textContent = 'Spelling · ' + item.word;
    menu.append(heading);
    function button(label: string, action: () => void) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.addEventListener('click', action, { once: true });
      menu.append(b);
    }
    for (const choice of choices) button(choice, () => {
      close();
      if (view.field.value === view.source) replace(view.field, item, choice);
    });
    if (!choices.length) {
      const note = document.createElement('div');
      note.className = 'spell-menu-note';
      note.textContent = pending ? 'Finding suggestions…' : 'No suggestions';
      menu.append(note);
    }
    button('Ignore word', () => {
      ignored.add(item.word.toLowerCase());
      close(true);
      for (const other of views) paint(other);
    });
    position();
    if (focused) menu.querySelector('button')?.focus({ preventScroll: true });
  }

  function open(view: View, x: number, y: number, keyboard: boolean) {
    if (view.field.value !== view.source) return false;
    const at = view.field.selectionStart ?? -1;
    for (const mark of view.copy.querySelectorAll<HTMLElement>('.spell-word')) {
      const word = mark.textContent!;
      const start = Number(mark.dataset.start);
      const rect = Array.from(mark.getClientRects()).find((r) => keyboard ?
        at >= start && at <= start + word.length : x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
      if (!rect) continue;
      const item = { word, start };
      current = { view, item, x: keyboard ? rect.left : x, y: keyboard ? rect.bottom : y, request: ++sequence };
      menu.hidden = false;
      menu.setAttribute('aria-label', 'Spelling suggestions for ' + word);
      const preferred = preferredSpelling(word);
      showChoices(preferred ? [preferred] : [], true);
      menu.querySelector('button')?.focus({ preventScroll: true });
      send({ request: sequence, word });
      return true;
    }
    return false;
  }

  function refresh(view: View, index: number) {
    if (current?.view === view) close();
    const source = view.field.value;
    if (source === view.source && view.revision > 0) return;
    view.source = source;
    view.revision++;
    view.issues = [];
    view.copy.replaceChildren();
    clearTimeout(view.timer);
    view.timer = window.setTimeout(() => send({ field: index, revision: view.revision, source, markdown: view.field.hasAttribute('data-body') }), 120);
  }

  worker.onmessage = ({ data }: MessageEvent<SpellReply>) => {
    if ('suggestions' in data) {
      if (current?.request !== data.request) return;
      const preferred = preferredSpelling(current.item.word);
      const choices = [...new Set([...(preferred ? [preferred] : []), ...data.suggestions])];
      showChoices(choices.slice(0, 5));
    } else {
      const view = views[data.field];
      if (view.revision !== data.revision || view.field.value !== view.source) return;
      view.issues = data.issues;
      view.field.spellcheck = false;
      paint(view);
    }
  };
  const resize = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; views.forEach(align); });
  };
  const observer = new ResizeObserver(resize);
  const events = new AbortController();
  const options = { signal: events.signal };
  views.forEach((view, index) => {
    const field = view.field;
    observer.observe(field);
    field.addEventListener('input', () => refresh(view, index), options);
    field.addEventListener('focus', () => { refresh(view, index); resize(); }, options);
    field.addEventListener('scroll', () => { view.layer.scrollTop = field.scrollTop; view.layer.scrollLeft = field.scrollLeft; }, options);
    field.addEventListener('contextmenu', (e) => {
      const event = e as MouseEvent;
      if (open(view, event.clientX, event.clientY, !event.clientX && !event.clientY)) event.preventDefault();
    }, options);
    field.addEventListener('keydown', (e) => {
      const event = e as KeyboardEvent;
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        if (open(view, 0, 0, true)) event.preventDefault();
      }
    }, options);
  });
  menu.addEventListener('keydown', (e) => {
    const buttons = [...menu.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  }, options);
  document.addEventListener('pointerdown', (e) => {
    if (current && !menu.contains(e.target as Node)) close();
  }, { ...options, capture: true });
  window.addEventListener('resize', () => { close(); resize(); }, options);
  document.addEventListener('scroll', (e) => {
    if (current && !menu.contains(e.target as Node)) close();
  }, { ...options, capture: true });
  root.addEventListener('change', resize, options);
  document.fonts.addEventListener('loadingdone', resize, options);
  function dispose() {
    events.abort(); observer.disconnect(); worker.terminate(); close(); menu.remove();
    cancelAnimationFrame(frame);
    for (const view of views) { clearTimeout(view.timer); view.layer.remove(); view.field.spellcheck = true; }
  }
  worker.onerror = dispose;
  signal.addEventListener('abort', dispose, { once: true });
  return () => {
    if (events.signal.aborted) return;
    views.forEach(refresh);
    resize();
  };
}
