/**
 * Writing studio: scale images right in the preview (split or preview-only).
 * Hover or focus a picture: a small toolbar offers 25 / 50 / 75 / 100 %, and
 * the corner grip drags to any size (5% steps; arrow keys on the grip too).
 * The size is written into the image's Markdown as a title token, which the
 * site's pipeline turns into the figure width everywhere (rehype-figures):
 *
 *   ![alt](/images/posts/x/cat.png "Caption {w=60%}")
 *
 * The edit goes through the editor as a normal, undoable change (Ctrl/Cmd+Z),
 * so autosave, the live preview and the published view all follow.
 */
const PRESETS = [25, 50, 75, 100];
const IMG = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^\s)\n]+)(?:\s+"([^"\n]*)")?\s*\)/g;

const snap = (n: number) => Math.max(10, Math.min(100, Math.round(n / 5) * 5));
const widthOf = (fig: HTMLElement) => Number([...fig.classList].find((c) => /^fig-w-\d+$/.test(c))?.slice(6) ?? 100);

function setFigureWidth(fig: HTMLElement, w: number) {
  [...fig.classList].filter((c) => /^fig-w-\d+$/.test(c)).forEach((c) => fig.classList.remove(c));
  fig.classList.toggle('figure--sized', w < 100);
  if (w < 100) fig.classList.add(`fig-w-${w}`);
}

/** The new title with {w=..} set (or removed at 100%), keeping any {#fig:id} last. */
function retitle(title: string | undefined, w: number) {
  let t = (title ?? '').replace(/\s*\{w=\d{1,3}%?\}\s*/gi, ' ').trim();
  if (w < 100) {
    const id = t.match(/\s*\{#fig:[a-z0-9-]+\}\s*$/i);
    t = id ? `${t.slice(0, id.index).trim()} {w=${w}%} ${id[0].trim()}`.trim() : `${t} {w=${w}%}`.trim();
  }
  return t;
}

export function initImageScale(signal: AbortSignal) {
  const ta = document.querySelector<HTMLTextAreaElement>('[data-body]');
  const preview = document.querySelector<HTMLElement>('[data-preview]');
  if (!ta || !preview) return;

  /** Where this preview image's Markdown is in the editor: [start, end, match]. */
  function locate(img: HTMLImageElement): { start: number; end: number; m: RegExpExecArray } | null {
    const block = img.closest<HTMLElement>('[data-line]');
    const src = ta!.value;
    const file = (img.getAttribute('src') ?? '').split('/').pop() ?? '';
    const all: RegExpExecArray[] = [];
    IMG.lastIndex = 0;
    for (let m; (m = IMG.exec(src)); ) all.push(m);
    const sameFile = (m: RegExpExecArray) => !!file && m[2].replace(/^<|>$/g, '').split('/').pop() === file;
    let hit: RegExpExecArray | undefined;
    if (block) {
      // Nth image of this block, counted from the block's first source line.
      const line = Number(block.dataset.line) || 1;
      let off = 0;
      for (let i = 1; i < line; i++) off = src.indexOf('\n', off) + 1 || src.length;
      const n = [...block.querySelectorAll('img')].indexOf(img);
      const after = all.filter((m) => m.index >= off);
      hit = after[n] && (sameFile(after[n]) || !file) ? after[n] : undefined;
    }
    hit ??= all.find(sameFile);
    return hit ? { start: hit.index, end: hit.index + hit[0].length, m: hit } : null;
  }

  /** Write the width into the source as one undoable edit, without moving the view. */
  function commit(img: HTMLImageElement, w: number) {
    const at = locate(img);
    if (!at) return;
    const [, alt, url, title] = at.m;
    const t = retitle(title, w);
    const next = `![${alt}](${url}${t ? ` "${t}"` : ''})`;
    if (next === at.m[0]) return;
    const active = document.activeElement as HTMLElement | null;
    const sel = [ta!.selectionStart, ta!.selectionEnd, ta!.selectionDirection] as const;
    const shift = next.length - at.m[0].length;
    const keep = { y: window.scrollY, top: ta!.scrollTop };
    ta!.focus({ preventScroll: true });
    ta!.setSelectionRange(at.start, at.end);
    // insertText keeps the browser's undo history (and fires the usual input event).
    const ok = document.execCommand?.('insertText', false, next);
    if (!ok) {
      ta!.setRangeText(next, at.start, at.end, 'end');
      ta!.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const fix = (p: number) => (p >= at.end ? p + shift : p);
    ta!.setSelectionRange(fix(sel[0]), fix(sel[1]), sel[2] ?? 'none');
    ta!.scrollTop = keep.top;
    window.scrollTo({ top: keep.y, behavior: 'instant' as ScrollBehavior });
    active?.focus({ preventScroll: true });
  }

  function decorate() {
    preview!.querySelectorAll<HTMLElement>('figure.figure').forEach((fig) => {
      const img = fig.querySelector<HTMLImageElement>(':scope > img');
      if (!img || fig.querySelector(':scope > .w-scale')) return;
      const w = widthOf(fig);
      const tools = document.createElement('div');
      tools.className = 'w-scale';
      tools.innerHTML = `
        <span class="w-scale-bar" role="group" aria-label="Image size">
          ${PRESETS.map((p) => `<button type="button" class="bevel" data-scale="${p}" aria-pressed="${p === w}">${p}%</button>`).join('')}
        </span>
        <span class="w-scale-read" aria-hidden="true">${w}%</span>
        <button type="button" class="w-scale-grip" role="slider" aria-label="Image width" aria-valuemin="10" aria-valuemax="100" aria-valuenow="${w}" aria-valuetext="${w}%" title="Drag to resize · arrow keys: 5% steps"></button>`;
      fig.append(tools);
    });
  }

  /** Fit the tools to the picture itself (the caption sits below it). */
  const fit = (fig: HTMLElement) => {
    const img = fig.querySelector<HTMLImageElement>(':scope > img');
    if (img) fig.style.setProperty('--cap-h', `${Math.max(0, fig.clientHeight - img.offsetTop - img.offsetHeight)}px`);
  };
  preview.addEventListener('pointerover', (e) => {
    const fig = (e.target as HTMLElement).closest<HTMLElement>('figure.figure');
    if (fig) fit(fig);
  }, { signal });
  preview.addEventListener('focusin', (e) => {
    const fig = (e.target as HTMLElement).closest<HTMLElement>('figure.figure');
    if (fig) fit(fig);
  }, { signal });

  const paint = (fig: HTMLElement, w: number) => {
    setFigureWidth(fig, w);
    fit(fig);
    const tools = fig.querySelector<HTMLElement>('.w-scale');
    if (!tools) return;
    tools.querySelector('.w-scale-read')!.textContent = `${w}%`;
    tools.querySelectorAll<HTMLElement>('[data-scale]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.scale) === w)));
    const grip = tools.querySelector<HTMLElement>('.w-scale-grip')!;
    grip.setAttribute('aria-valuenow', String(w));
    grip.setAttribute('aria-valuetext', `${w}%`);
  };

  // Presets.
  preview.addEventListener(
    'click',
    (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-scale]');
      const fig = b?.closest<HTMLElement>('figure.figure');
      const img = fig?.querySelector<HTMLImageElement>(':scope > img');
      if (!b || !fig || !img) return;
      e.preventDefault();
      const w = Number(b.dataset.scale);
      paint(fig, w);
      commit(img, w);
    },
    { signal },
  );

  // Drag the corner grip: the figure is centred, so each pixel of travel is two of width.
  let dragging = false;
  preview.addEventListener(
    'pointerdown',
    (e) => {
      const grip = (e.target as HTMLElement).closest<HTMLElement>('.w-scale-grip');
      const fig = grip?.closest<HTMLElement>('figure.figure');
      const img = fig?.querySelector<HTMLImageElement>(':scope > img');
      if (!grip || !fig || !img || e.button !== 0) return;
      e.preventDefault();
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {}
      dragging = true;
      fig.classList.add('is-scaling');
      const full = fig.parentElement!.getBoundingClientRect().width || 1;
      const startW = fig.getBoundingClientRect().width;
      const startX = e.clientX;
      let w = widthOf(fig);
      const move = (ev: PointerEvent) => {
        w = snap(((startW + 2 * (ev.clientX - startX)) / full) * 100);
        paint(fig, w);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        fig.classList.remove('is-scaling');
        dragging = false;
        commit(img, w);
      };
      grip.addEventListener('pointermove', move, { signal });
      grip.addEventListener('pointerup', up, { once: true, signal });
      grip.addEventListener('pointercancel', up, { once: true, signal });
    },
    { signal },
  );

  // Keyboard on the grip: ←/→ (or ↓/↑) 5%, Home 10%, End 100%.
  let keyTimer = 0;
  preview.addEventListener(
    'keydown',
    (e) => {
      const grip = (e.target as HTMLElement).closest<HTMLElement>('.w-scale-grip');
      const fig = grip?.closest<HTMLElement>('figure.figure');
      const img = fig?.querySelector<HTMLImageElement>(':scope > img');
      if (!grip || !fig || !img) return;
      const cur = widthOf(fig);
      const next = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? cur + 5 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? cur - 5 : e.key === 'Home' ? 10 : e.key === 'End' ? 100 : null;
      if (next === null) return;
      e.preventDefault();
      const w = snap(next);
      paint(fig, w);
      window.clearTimeout(keyTimer);
      keyTimer = window.setTimeout(() => commit(img, w), 350);
    },
    { signal },
  );

  // The tools aren't part of the post: keep double-click-to-jump off them.
  preview.addEventListener('dblclick', (e) => (e.target as HTMLElement).closest('.w-scale') && e.stopPropagation(), { capture: true, signal });

  // Re-decorate after every live render (the preview's HTML is replaced).
  const mo = new MutationObserver(() => {
    if (!dragging) decorate();
  });
  mo.observe(preview, { childList: true });
  signal.addEventListener('abort', () => mo.disconnect());
  decorate();
}
