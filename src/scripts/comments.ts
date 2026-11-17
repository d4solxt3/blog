/**
 * Native comments + highlight-to-comment annotations.
 *
 * Anchoring follows the W3C text-quote idea: each annotation stores the exact
 * quote plus ~32 chars of prefix/suffix and the index of the block (paragraph,
 * heading, list item…) it was made in. On load we search that block first,
 * then the others, and pick the occurrence whose surrounding text matches
 * best — so edits elsewhere in the post don't break existing highlights.
 */
import { deleteComment, ownerKey } from './owner';

type Anchor = { id: string; exact: string; prefix: string; suffix: string; blockIndex: number };
type Comment = { id: string; post: string; name: string; body: string; createdAt: string; anchor: Anchor | null };
type Located = { anchor: Anchor; block: HTMLElement; start: number; end: number; order: number };

const BLOCKS = 'p, li, h2, h3, h4, td, th, figcaption, dd, dt, summary';
const EXCLUDE = '.footnotes, pre, .code-frame, .katex, .win-bar, .callout-label, .callout-heading, [data-no-annotate]';
const SKIP_TEXT = '.katex-mathml, .anno-badge, .heading-anchor, .sr-only';
const CONTEXT = 32;

const pad = (n: number) => String(n).padStart(2, '0');
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const formatTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function initComments(signal: AbortSignal) {
  const root = document.querySelector<HTMLElement>('[data-comment-system]');
  const prose = document.querySelector<HTMLElement>('[data-post-body]');
  if (!root || !prose) return;

  const post = root.dataset.post ?? '';
  const native = root.dataset.provider === 'native';
  const annotationsOn = root.dataset.annotations === 'on';

  const feed = root.querySelector<HTMLOListElement>('[data-feed]');
  const feedCount = root.querySelector<HTMLElement>('[data-feed-count]');
  const feedEmpty = root.querySelector<HTMLElement>('[data-feed-empty]');
  const offline = root.querySelector<HTMLElement>('[data-offline]');
  const mainForm = root.querySelector<HTMLFormElement>('[data-comment-form]');

  const drawer = document.querySelector<HTMLElement>('[data-qt]');
  const qtQuote = drawer?.querySelector<HTMLElement>('[data-qt-quote]');
  const qtList = drawer?.querySelector<HTMLOListElement>('[data-qt-replies]');
  const qtCount = drawer?.querySelector<HTMLElement>('[data-qt-count]');
  const qtForm = drawer?.querySelector<HTMLFormElement>('[data-qt-form]');
  const tip = document.querySelector<HTMLElement>('[data-anno-tip]');

  let comments: Comment[] = [];
  let located = new Map<string, Located>();
  let pending: Anchor | null = null; // anchor for a brand-new quote thread
  let openAnchorId: string | null = null;
  let lastFocus: HTMLElement | null = null;
  let owner = ownerKey(); // signed in on /moderate/ → show delete buttons
  const shownAt = new WeakMap<HTMLFormElement, number>();

  /* ------------------------------------------------------------ text index */

  const blocks = () =>
    Array.from(prose.querySelectorAll<HTMLElement>(BLOCKS)).filter(
      (el) => !el.closest(EXCLUDE) && !el.querySelector(BLOCKS) && el.textContent?.trim(),
    );

  function textIndex(block: HTMLElement) {
    const segments: { node: Text; start: number; end: number }[] = [];
    let text = '';
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => ((n.parentElement?.closest(SKIP_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)),
    });
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      segments.push({ node: n, start: text.length, end: text.length + n.data.length });
      text += n.data;
    }
    return { text, segments };
  }

  function offsetIn(block: HTMLElement, container: Node, offset: number): number {
    const { text, segments } = textIndex(block);
    if (container.nodeType === Node.TEXT_NODE) {
      const seg = segments.find((s) => s.node === container);
      if (seg) return seg.start + Math.min(offset, seg.node.data.length);
    }
    const point = document.createRange();
    point.setStart(container, offset);
    for (const seg of segments) if (point.comparePoint(seg.node, 0) >= 0) return seg.start;
    return text.length;
  }

  const blockOf = (node: Node | null) => {
    const el = node instanceof Element ? node : node?.parentElement;
    const b = el?.closest<HTMLElement>(BLOCKS);
    return b && prose.contains(b) && !b.closest(EXCLUDE) && !b.querySelector(BLOCKS) ? b : null;
  };

  function selectionAnchor(): { anchor: Anchor; rect: DOMRect } | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const block = blockOf(range.startContainer);
    if (!block || block !== blockOf(range.endContainer)) return null;
    const { text } = textIndex(block);
    let start = offsetIn(block, range.startContainer, range.startOffset);
    let end = offsetIn(block, range.endContainer, range.endOffset);
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    const exact = text.slice(start, end);
    if (exact.length < 3 || exact.length > 600) return null;
    const blockIndex = blocks().indexOf(block);
    if (blockIndex < 0) return null;
    return {
      anchor: { id: '', exact, prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT), blockIndex },
      // Anchor the tip to the first line of the selection, not the whole multi-line box.
      rect: Array.from(range.getClientRects()).find((r) => r.width > 1) ?? range.getBoundingClientRect(),
    };
  }

  /* ----------------------------------------------------------- re-anchor */

  const commonSuffix = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  };
  const commonPrefix = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function locate(anchor: Anchor, all: HTMLElement[]): Omit<Located, 'order'> | null {
    const re = new RegExp(escapeRe(anchor.exact.trim()).replace(/\s+/g, '\\s+'), 'g');
    const order = all
      .map((_, i) => i)
      .sort((a, b) => Math.abs(a - anchor.blockIndex) - Math.abs(b - anchor.blockIndex));
    let best: (Omit<Located, 'order'> & { score: number }) | null = null;
    for (const i of order) {
      const block = all[i];
      const { text } = textIndex(block);
      for (const m of text.matchAll(re)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        const score =
          commonSuffix(anchor.prefix, text.slice(0, start)) +
          commonPrefix(anchor.suffix, text.slice(end)) +
          (i === anchor.blockIndex ? 24 : 0) -
          Math.min(20, Math.abs(i - anchor.blockIndex));
        if (!best || score > best.score) best = { anchor, block, start, end, score };
      }
      // A confident match in (or right next to) the original block is good enough.
      if (best && best.score >= 24 && Math.abs(i - anchor.blockIndex) > 1) break;
    }
    return best;
  }

  /* ---------------------------------------------------------- highlights */

  function clearHighlights() {
    prose.querySelectorAll('.anno-badge').forEach((b) => b.remove());
    prose.querySelectorAll('mark.anno').forEach((m) => {
      const parent = m.parentNode!;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      m.remove();
      parent.normalize();
    });
  }

  function wrap(loc: Located, number: number, replies: number) {
    const { segments } = textIndex(loc.block);
    const marks: HTMLElement[] = [];
    for (const seg of segments) {
      const s = Math.max(loc.start, seg.start);
      const e = Math.min(loc.end, seg.end);
      if (s >= e) continue;
      let node = seg.node;
      if (e - seg.start < node.data.length) node.splitText(e - seg.start);
      if (s - seg.start > 0) node = node.splitText(s - seg.start);
      const mark = document.createElement('mark');
      mark.className = 'anno';
      mark.dataset.anchor = loc.anchor.id;
      node.parentNode!.insertBefore(mark, node);
      mark.appendChild(node);
      marks.push(mark);
    }
    const last = marks.at(-1);
    if (!last) return;
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'anno-badge';
    badge.dataset.anchor = loc.anchor.id;
    badge.textContent = `[${pad(number)}]`;
    badge.setAttribute('aria-label', `Quote thread ${number}: ${replies} ${replies === 1 ? 'reply' : 'replies'}`);
    last.after(badge);
  }

  function renderHighlights() {
    if (!annotationsOn) return;
    clearHighlights();
    const all = blocks();
    const anchors = new Map<string, Anchor>();
    for (const c of comments) if (c.anchor && !anchors.has(c.anchor.id)) anchors.set(c.anchor.id, c.anchor);
    const found: Located[] = [];
    for (const a of anchors.values()) {
      const loc = locate(a, all);
      if (loc) found.push({ ...loc, order: all.indexOf(loc.block) * 1e6 + loc.start });
    }
    found.sort((a, b) => a.order - b.order);
    located = new Map(found.map((l) => [l.anchor.id, l]));
    found.forEach((loc, i) => wrap(loc, i + 1, comments.filter((c) => c.anchor?.id === loc.anchor.id).length));
  }

  const numberOf = (anchorId: string) => [...located.keys()].indexOf(anchorId) + 1;

  function pulse(anchorId: string) {
    const marks = prose.querySelectorAll<HTMLElement>(`mark.anno[data-anchor="${CSS.escape(anchorId)}"]`);
    if (!marks.length) return false;
    const flash = () =>
      marks.forEach((m) => {
        m.classList.remove('is-pulse');
        void m.offsetWidth;
        m.classList.add('is-pulse');
        window.setTimeout(() => m.classList.remove('is-pulse'), 1600);
      });
    const r = marks[0].getBoundingClientRect();
    const onScreen = r.top > 60 && r.bottom < window.innerHeight - 60;
    if (reduceMotion() || onScreen) {
      if (!onScreen) marks[0].scrollIntoView({ block: 'center' });
      flash();
      return true;
    }
    // Pulse once the smooth scroll has arrived, so the reader actually sees it.
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      window.removeEventListener('scrollend', go);
      flash();
    };
    window.addEventListener('scrollend', go, { once: true });
    window.setTimeout(go, 1200);
    marks[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  }

  /* ---------------------------------------------------------------- feed */

  function commentItem(c: Comment, opts: { jump: boolean }) {
    const li = document.createElement('li');
    li.className = 'cm-item';
    li.id = `c-${c.id}`;
    const head = document.createElement('div');
    head.className = 'cm-head';
    const name = document.createElement('span');
    name.className = 'cm-name';
    name.textContent = c.name || 'anon';
    const time = document.createElement('time');
    time.dateTime = c.createdAt;
    time.textContent = formatTime(c.createdAt);
    head.append(name, time);
    if (owner) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cm-del';
      del.dataset.del = c.id;
      del.textContent = '[ delete ]';
      del.setAttribute('aria-label', `Delete comment by ${c.name || 'anon'}`);
      head.append(del);
    }
    li.append(head);
    if (c.anchor && opts.jump) {
      const n = numberOf(c.anchor.id);
      const q = document.createElement('button');
      q.type = 'button';
      q.className = 'cm-quote';
      q.dataset.jump = c.anchor.id;
      q.textContent = `> "${truncate(c.anchor.exact, 160)}"`;
      if (n) {
        const tag = document.createElement('span');
        tag.className = 'cm-quote-no';
        tag.textContent = ` [${pad(n)}]`;
        q.append(tag);
        q.setAttribute('aria-label', `Jump to quoted passage ${n} in the post`);
      } else {
        q.disabled = true;
        q.title = 'This passage is no longer in the post';
      }
      li.append(q);
    }
    const body = document.createElement('p');
    body.className = 'cm-body';
    body.textContent = c.body;
    li.append(body);
    return li;
  }

  function renderFeed() {
    if (!feed) return;
    const items = native ? comments : comments.filter((c) => c.anchor);
    feed.replaceChildren(...items.map((c) => commentItem(c, { jump: true })));
    if (feedCount) feedCount.textContent = `${pad(items.length)} ${items.length === 1 ? 'reply' : 'replies'}`;
    if (feedEmpty) feedEmpty.hidden = items.length > 0;
  }

  /* -------------------------------------------------------------- drawer */

  function renderThread() {
    if (!drawer || !qtQuote || !qtList || !qtCount) return;
    const anchor = openAnchorId ? located.get(openAnchorId)?.anchor ?? comments.find((c) => c.anchor?.id === openAnchorId)?.anchor : pending;
    if (!anchor) return;
    qtQuote.textContent = `> "${anchor.exact}"`;
    const replies = openAnchorId ? comments.filter((c) => c.anchor?.id === openAnchorId) : [];
    qtList.replaceChildren(...replies.map((c) => commentItem(c, { jump: false })));
    qtCount.textContent = replies.length ? `${pad(replies.length)} ${replies.length === 1 ? 'reply' : 'replies'}` : 'new thread // be the first to reply';
    prose.querySelectorAll('mark.anno.is-active').forEach((m) => m.classList.remove('is-active'));
    if (openAnchorId) prose.querySelectorAll(`mark.anno[data-anchor="${CSS.escape(openAnchorId)}"]`).forEach((m) => m.classList.add('is-active'));
  }

  function openDrawer(anchorId: string | null, newAnchor: Anchor | null = null) {
    if (!drawer || !qtForm) return;
    lastFocus = document.activeElement as HTMLElement | null;
    openAnchorId = anchorId;
    pending = newAnchor;
    renderThread();
    // On phones the sheet covers the lower half: lift the quoted passage above it.
    if (window.matchMedia('(max-width: 1059px)').matches) {
      const target = anchorId
        ? prose.querySelector<HTMLElement>(`mark.anno[data-anchor="${CSS.escape(anchorId)}"]`)?.getBoundingClientRect()
        : window.getSelection()?.rangeCount
          ? window.getSelection()!.getRangeAt(0).getBoundingClientRect()
          : null;
      if (target && target.top > window.innerHeight * 0.3) {
        window.scrollBy({ top: target.top - 72, behavior: reduceMotion() ? 'auto' : 'smooth' });
      }
    }
    drawer.hidden = false;
    void drawer.offsetWidth; // commit the hidden state so the fade-in still transitions
    drawer.classList.add('is-open');
    shownAt.set(qtForm, Date.now());
    qtForm.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    hideTip();
  }

  function closeDrawer() {
    if (!drawer || drawer.hidden) return;
    drawer.classList.remove('is-open');
    prose.querySelectorAll('mark.anno.is-active').forEach((m) => m.classList.remove('is-active'));
    const done = () => {
      drawer.hidden = true;
    };
    reduceMotion() ? done() : window.setTimeout(done, 130);
    openAnchorId = null;
    pending = null;
    lastFocus?.focus?.({ preventScroll: true });
  }

  /* -------------------------------------------------------- selection tip */

  let tipAnchor: Anchor | null = null;
  function hideTip() {
    if (!tip) return;
    tip.classList.remove('is-visible');
    tip.hidden = true;
    tipAnchor = null;
  }

  function showTip() {
    if (!tip) return;
    const found = selectionAnchor();
    if (!found) return hideTip();
    tipAnchor = found.anchor;
    tip.hidden = false;
    const { rect } = found;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let top = coarse ? rect.bottom + 10 : rect.top - h - 8;
    if (top < 8) top = rect.bottom + 10;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2));
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
    void tip.offsetWidth;
    tip.classList.add('is-visible');
  }

  /* ----------------------------------------------------------------- api */

  async function load() {
    const res = await fetch(`/api/comments?post=${encodeURIComponent(post)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    comments = (await res.json()).comments ?? [];
  }

  async function submit(form: HTMLFormElement, anchor: Anchor | null) {
    const status = form.querySelector<HTMLElement>('[data-status]');
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const fd = new FormData(form);
    const name = String(fd.get('name') ?? '').trim();
    const body = String(fd.get('body') ?? '').trim();
    if (body.length < 2) {
      if (status) status.textContent = '> write something first';
      return;
    }
    try {
      localStorage.setItem('comment-name', name);
    } catch {}
    if (button) button.disabled = true;
    if (status) status.textContent = '> posting…';
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post,
          name,
          body,
          anchor,
          website: fd.get('website') ?? '',
          elapsed: Date.now() - (shownAt.get(form) ?? 0),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      const comment: Comment = data.comment;
      comments.push(comment);
      form.querySelector<HTMLTextAreaElement>('textarea')!.value = '';
      if (status) status.textContent = '> posted ✓';
      if (comment.anchor) {
        openAnchorId = comment.anchor.id;
        pending = null;
        window.getSelection()?.removeAllRanges();
        renderHighlights();
        renderThread();
      }
      renderFeed();
    } catch (err) {
      if (status) status.textContent = `> ${err instanceof Error ? err.message : 'could not post'}`;
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function onDelete(e: Event) {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-del]');
    const c = btn && comments.find((x) => x.id === btn.dataset.del);
    if (!btn || !c || !owner) return;
    if (!window.confirm(`Delete this comment by ${c.name || 'anon'}?\n\n"${truncate(c.body, 140)}"\n\nThis can't be undone.`)) return;
    btn.disabled = true;
    btn.textContent = '[ deleting… ]';
    try {
      await deleteComment(c.id, owner);
      comments = comments.filter((x) => x.id !== c.id);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) comments = comments.filter((x) => x.id !== c.id); // already gone
      else window.alert(err instanceof Error ? err.message : 'Could not delete the comment.');
      owner = ownerKey(); // a wrong or changed passphrase signs you out
    }
    const threadGone = openAnchorId !== null && !comments.some((x) => x.anchor?.id === openAnchorId);
    renderHighlights();
    renderFeed();
    if (threadGone) closeDrawer();
    else if (drawer && !drawer.hidden) renderThread();
  }

  /* --------------------------------------------------------------- wire */

  const savedName = (() => {
    try {
      return localStorage.getItem('comment-name') ?? '';
    } catch {
      return '';
    }
  })();
  for (const f of [mainForm, qtForm]) {
    const input = f?.querySelector<HTMLInputElement>('input[name="name"]');
    if (input && savedName) input.value = savedName;
  }

  if (mainForm) {
    shownAt.set(mainForm, Date.now());
    mainForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submit(mainForm, null);
    });
  }

  qtForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const anchor = openAnchorId
      ? (located.get(openAnchorId)?.anchor ?? comments.find((c) => c.anchor?.id === openAnchorId)?.anchor ?? null)
      : pending;
    if (anchor) submit(qtForm, anchor);
  });

  drawer?.querySelector('[data-qt-close]')?.addEventListener('click', closeDrawer);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        if (drawer && !drawer.hidden) closeDrawer();
        else hideTip();
      }
    },
    { signal },
  );

  // Click a highlight or its [01] badge → open that thread.
  prose.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('mark.anno, .anno-badge');
    if (!t?.dataset.anchor) return;
    if (t.matches('mark.anno') && !window.getSelection()?.isCollapsed) return;
    openDrawer(t.dataset.anchor);
  });

  // Quote buttons in the bottom feed → scroll to and pulse the passage.
  feed?.addEventListener('click', (e) => {
    const q = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-jump]');
    if (q?.dataset.jump) pulse(q.dataset.jump);
  });

  // Owner mode: [ delete ] buttons in the feed and in quote threads.
  feed?.addEventListener('click', onDelete);
  qtList?.addEventListener('click', onDelete);

  if (tip && annotationsOn) {
    tip.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection alive
    tip.querySelector('button')?.addEventListener('click', () => {
      if (tipAnchor) openDrawer(null, tipAnchor);
    });
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(showTip, 120);
    };
    document.addEventListener('selectionchange', schedule, { signal });
    window.addEventListener('scroll', () => tip.hidden || showTip(), { passive: true, signal });
    signal.addEventListener('abort', () => window.clearTimeout(timer));
  }

  if (signal.aborted) return;
  load()
    .then(() => {
      renderHighlights();
      renderFeed();
      root.dataset.state = 'ready';
    })
    .catch(() => {
      // Static host without the API: hide the forms and the highlight tool.
      root.dataset.state = 'offline';
      if (offline) offline.hidden = false;
      if (mainForm) mainForm.hidden = true;
      if (feedEmpty) feedEmpty.hidden = true;
      tip?.remove();
    });
}
