/**
 * LessWrong / arXiv-style hover previews:
 *  - footnote refs [1] → the footnote's text, without leaving your place
 *  - [[wiki-links]]    → the linked post's title, date and summary
 *  - \eqref / \ref / \cref (a.latex-ref) → equation, theorem, algorithm or figure
 *  - \cite (a.latex-cite) → bibliography entry from .references
 * Mouse: hover. Touch: first tap shows the card, the card links onward.
 */

let card: HTMLElement | null = null;
let hideTimer = 0;
let owner: HTMLElement | null = null;
let previews: Promise<Record<string, { title: string; date: string; summary: string }>> | null = null;
const pulseTimers = new WeakMap<HTMLElement, number>();

type PeekPayload = {
  title: string;
  body: Node[];
  wide?: boolean;
};

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/([^\w-])/g, '\\$1');
}

export function findTargetById(root: HTMLElement, rawId: string | undefined | null): HTMLElement | null {
  if (!rawId) return null;
  let id = rawId.replace(/^#/, '');
  if (!id) return null;
  try {
    id = decodeURIComponent(id);
  } catch {
    // Keep raw id if malformed percent-encoding.
  }
  const el = root.querySelector<HTMLElement>(`#${cssEscape(id)}`) ?? document.getElementById(id);
  if (!el) return null;
  // Multi-row align equations place secondary \label IDs on hidden .eq-anchor
  // spans inside .math-block; normalize to the enclosing .math-block.
  return el.matches('.eq-anchor') ? el.closest<HTMLElement>('.math-block') ?? el : el;
}

/** Briefly highlight a jumped-to equation, theorem, algorithm, figure or reference. */
export function pulseTarget(el: HTMLElement | null | undefined) {
  if (!el) return;
  const prev = pulseTimers.get(el);
  if (prev) window.clearTimeout(prev);
  el.classList.remove('is-target-pulse');
  void el.offsetWidth;
  el.classList.add('is-target-pulse');
  pulseTimers.set(
    el,
    window.setTimeout(() => {
      el.classList.remove('is-target-pulse');
      pulseTimers.delete(el);
    }, 1150),
  );
}

function getCard() {
  // The router swaps <body> on navigation, so a card from a previous page is gone.
  if (card?.isConnected) return card;
  const existing = document.getElementById('peek-card');
  if (existing && existing.classList.contains('peek')) {
    card = existing;
    return card;
  }
  card = document.createElement('div');
  card.className = 'peek';
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  card.addEventListener('pointerenter', () => window.clearTimeout(hideTimer));
  card.addEventListener('pointerleave', () => scheduleHide());
  document.body.append(card);
  return card;
}

function place(target: HTMLElement) {
  const c = getCard();
  const r = target.getBoundingClientRect();
  const w = c.offsetWidth;
  const h = c.offsetHeight;
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  const left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2));
  c.style.top = `${Math.round(top)}px`;
  c.style.left = `${Math.round(left)}px`;
}

function show(target: HTMLElement, title: string, body: Node[], wide = false) {
  window.clearTimeout(hideTimer);
  const c = getCard();
  const bar = document.createElement('div');
  bar.className = 'peek-bar';
  bar.textContent = title;
  const content = document.createElement('div');
  content.className = 'peek-body';
  content.append(...body);
  c.classList.toggle('peek--wide', wide);
  c.replaceChildren(bar, content);
  c.hidden = false;
  owner = target;
  target.setAttribute('aria-describedby', 'peek-card');
  c.id = 'peek-card';
  place(target);
  void c.offsetWidth;
  c.classList.add('is-visible');
}

function hide() {
  if (!card) return;
  card.classList.remove('is-visible');
  card.hidden = true;
  owner?.removeAttribute('aria-describedby');
  owner = null;
}

function scheduleHide(delay = 140) {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hide, delay);
}

function sanitizeClone<T extends HTMLElement>(el: T): T {
  const clone = el.cloneNode(true) as T;
  clone.removeAttribute('id');
  clone.removeAttribute('data-line');
  clone.classList.remove('is-target-pulse');
  clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  clone.querySelectorAll('[data-line]').forEach((n) => n.removeAttribute('data-line'));
  clone.querySelectorAll('.copy-tex, .copy-code, .heading-anchor, [data-footnote-backref], .ref-backref, .eq-anchor').forEach((n) => n.remove());
  return clone;
}

function jumpToTarget(root: HTMLElement, target: HTMLElement, e?: MouseEvent) {
  const isStudioPreview = !root.matches('[data-post-body]');
  if (isStudioPreview) {
    e?.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  pulseTarget(target);
}

function makeJump(root: HTMLElement, href: string, label: string, target?: HTMLElement | null): HTMLParagraphElement {
  const jump = document.createElement('a');
  jump.className = 'peek-jump';
  jump.href = href;
  jump.textContent = label;
  jump.addEventListener('click', (e) => {
    hide();
    if (target) jumpToTarget(root, target, e);
  });
  const p = document.createElement('p');
  p.append(jump);
  return p;
}

function footnoteContent(ref: HTMLAnchorElement, root: HTMLElement): PeekPayload | null {
  const li = findTargetById(root, ref.hash);
  if (!li) return null;
  const clone = sanitizeClone(li);
  const nodes = Array.from(clone.childNodes);
  return {
    title: `footnote ${ref.textContent?.trim() ?? ''}`.trim(),
    body: [...nodes, makeJump(root, ref.hash || `#${li.id}`, '↓ jump to note', li)],
  };
}

function formatEqNum(raw: string | undefined | null): string {
  const cleaned = raw?.trim() ?? '';
  if (!cleaned) return '';
  return cleaned.startsWith('(') && cleaned.endsWith(')') ? cleaned : `(${cleaned})`;
}

function latexRefContent(ref: HTMLAnchorElement, root: HTMLElement): PeekPayload | null {
  const rawTarget = ref.dataset.refTarget || ref.getAttribute('href') || ref.hash;
  const target = findTargetById(root, rawTarget);
  if (!target) return null;

  const href = ref.getAttribute('href') || `#${target.id}`;
  const refKind = (ref.dataset.refKind || '').toLowerCase();

  // Equation (.math-block / #eq-*)
  if (target.matches('.math-block') || target.id.startsWith('eq-') || refKind === 'equation') {
    const targetId = rawTarget.replace(/^#/, '');
    const isSecondaryAnchor = Boolean(targetId && target.id && target.id !== targetId);
    const refNumMatch = ref.textContent?.match(/\([^)]+\)|\d+/)?.[0];
    const eqNum = formatEqNum(
      isSecondaryAnchor && refNumMatch
        ? refNumMatch
        : target.dataset.eqNum || target.querySelector('.eq-num')?.textContent || refNumMatch,
    );
    const clone = sanitizeClone(target);
    return {
      title: eqNum ? `equation ${eqNum}` : 'equation',
      body: [clone, makeJump(root, href, '↓ jump to equation', target)],
      wide: true,
    };
  }

  // Theorem / Lemma / Proposition / Corollary / Definition / Assumption / Example / Remark / Proof
  if (target.matches('.math-env')) {
    const kind = (target.dataset.envKind || refKind || 'theorem').toLowerCase();
    const num = target.dataset.envNum?.trim() || '';
    const headKind = target.querySelector('.math-env-kind')?.textContent?.trim();
    const title = num ? `${kind} ${num}` : headKind ? headKind.toLowerCase().replace(/\.$/, '') : kind;
    const clone = sanitizeClone(target);
    return {
      title,
      body: [clone, makeJump(root, href, `↓ jump to ${kind}`, target)],
      wide: true,
    };
  }

  // Algorithm block
  if (target.matches('.algorithm-block')) {
    const num = target.dataset.envNum?.trim() || '';
    const algoLabel = target.querySelector('.algorithm-num')?.textContent?.trim();
    const title = num ? `algorithm ${num}` : algoLabel ? algoLabel.toLowerCase() : 'algorithm';
    const clone = sanitizeClone(target);
    return {
      title,
      body: [clone, makeJump(root, href, '↓ jump to algorithm', target)],
      wide: true,
    };
  }

  // Figure / Chart / Diagram
  if (target.matches('figure, .figure, .chart, .diagram') || target.id.startsWith('fig-') || refKind === 'figure') {
    const figNum = target.querySelector('.fig-num')?.textContent?.trim();
    const clone = sanitizeClone(target);
    clone.querySelectorAll('.chart-data').forEach((n) => n.remove());
    return {
      title: figNum ? figNum.toLowerCase() : 'figure',
      body: [clone, makeJump(root, href, '↓ jump to figure', target)],
      wide: true,
    };
  }

  // Heading / Section
  if (target.matches('h1, h2, h3, h4, h5, h6')) {
    const hClone = sanitizeClone(target);
    const heading = document.createElement('p');
    heading.className = 'peek-title';
    heading.textContent = hClone.textContent?.trim() ?? '';
    const nodes: Node[] = [heading];
    const next = target.nextElementSibling;
    if (next && next.matches('p')) {
      const pClone = sanitizeClone(next as HTMLElement);
      nodes.push(pClone);
    }
    return {
      title: 'section',
      body: [...nodes, makeJump(root, href, '↓ jump to section', target)],
    };
  }

  // Generic fallback
  const clone = sanitizeClone(target);
  const label = refKind || 'reference';
  return {
    title: label,
    body: [clone, makeJump(root, href, `↓ jump to ${label}`, target)],
    wide: true,
  };
}

function findCitationTarget(link: HTMLAnchorElement, root: HTMLElement): HTMLElement | null {
  const byHash = findTargetById(root, link.getAttribute('href') || link.hash);
  if (byHash) return byHash;
  const key = link.dataset.citeKey;
  if (!key) return null;
  const sel = `.references li[data-cite-key="${cssEscape(key)}"]`;
  return root.querySelector<HTMLElement>(sel) ?? document.querySelector<HTMLElement>(sel);
}

function latexCiteContent(link: HTMLAnchorElement, root: HTMLElement): PeekPayload | null {
  const li = findCitationTarget(link, root);
  if (!li) return null;

  const rawNum = li.querySelector('.ref-num')?.textContent?.trim();
  const citeKey = link.dataset.citeKey || li.dataset.citeKey || '';
  let badge = '';
  if (rawNum) {
    badge = rawNum.startsWith('[') && rawNum.endsWith(']') ? rawNum : `[${rawNum}]`;
  } else {
    const linkText = link.textContent?.trim() ?? '';
    if (/^\[\d+\]$/.test(linkText)) {
      badge = linkText;
    } else if (citeKey) {
      badge = citeKey;
    } else {
      const siblings = li.parentElement ? Array.from(li.parentElement.children) : [];
      const idx = siblings.indexOf(li);
      if (idx >= 0) badge = `[${idx + 1}]`;
    }
  }

  const clone = sanitizeClone(li);
  if (rawNum) clone.querySelector('.ref-num')?.remove();

  const wrap = document.createElement('div');
  wrap.className = 'peek-ref';
  wrap.append(...Array.from(clone.childNodes));

  const href = link.getAttribute('href') || (li.id ? `#${li.id}` : '#references');
  return {
    title: badge ? `reference ${badge}` : 'reference',
    body: [wrap, makeJump(root, href, '↓ jump to reference', li)],
    wide: true,
  };
}

async function wikiContent(link: HTMLAnchorElement): Promise<PeekPayload | null> {
  previews ??= fetch('/previews.json').then((r) => r.json());
  const data = (await previews)[link.dataset.wikilink ?? ''];
  if (!data) return null;
  const t = document.createElement('p');
  t.className = 'peek-title';
  t.textContent = data.title;
  const m = document.createElement('p');
  m.className = 'peek-meta';
  m.textContent = data.date;
  const s = document.createElement('p');
  s.textContent = data.summary;
  const go = document.createElement('a');
  go.className = 'peek-jump';
  go.href = link.href;
  go.textContent = 'open thread →';
  const gp = document.createElement('p');
  gp.append(go);
  return { title: 'linked post', body: [t, m, s, gp] };
}

async function open(target: HTMLAnchorElement, root: HTMLElement) {
  let content: PeekPayload | null = null;
  if (target.matches('[data-footnote-ref]')) content = footnoteContent(target, root);
  else if (target.matches('a.latex-ref')) content = latexRefContent(target, root);
  else if (target.matches('a.latex-cite')) content = latexCiteContent(target, root);
  else content = await wikiContent(target);
  if (content) show(target, content.title, content.body, !!content.wide);
}

export function initPreviews(root: HTMLElement, signal: AbortSignal) {
  if (owner && root.contains(owner)) hide();
  if (!card?.isConnected) card = null;
  owner = null;

  const targets = Array.from(
    root.querySelectorAll<HTMLAnchorElement>('a[data-footnote-ref], a.wikilink, a.latex-ref, a.latex-cite'),
  );
  for (const t of targets) {
    let enterTimer = 0;
    t.addEventListener(
      'pointerenter',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        enterTimer = window.setTimeout(() => open(t, root), 90);
      },
      { signal },
    );
    t.addEventListener(
      'pointerleave',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        window.clearTimeout(enterTimer);
        scheduleHide();
      },
      { signal },
    );
    t.addEventListener('focus', () => open(t, root), { signal });
    t.addEventListener('blur', () => scheduleHide(200), { signal });
    // Touch: first tap previews, a second tap (or the card link) navigates.
    t.addEventListener(
      'click',
      (e) => {
        const touch = window.matchMedia('(hover: none)').matches;
        if (touch && owner !== t) {
          e.preventDefault();
          open(t, root);
          return;
        }
        if (t.matches('a.latex-ref')) {
          const target = findTargetById(root, t.dataset.refTarget || t.getAttribute('href') || t.hash);
          if (target) {
            hide();
            jumpToTarget(root, target, e);
          }
        } else if (t.matches('a.latex-cite')) {
          const target = findCitationTarget(t, root);
          if (target) {
            hide();
            jumpToTarget(root, target, e);
          }
        }
      },
      { signal },
    );
  }
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide(), { signal });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (card && !card.hidden && !card.contains(e.target as Node) && !targets.includes(e.target as HTMLAnchorElement)) hide();
    },
    { signal },
  );
  window.addEventListener('scroll', () => owner && place(owner), { passive: true, signal });
  signal.addEventListener('abort', () => {
    if (owner && root.contains(owner)) hide();
  });
}
