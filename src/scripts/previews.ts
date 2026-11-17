/**
 * LessWrong-style hover previews:
 *  - footnote refs [1] → the footnote's text, without leaving your place
 *  - [[wiki-links]]    → the linked post's title, date and summary
 * Mouse: hover. Touch: first tap shows the card, the card links onward.
 */

let card: HTMLElement | null = null;
let hideTimer = 0;
let owner: HTMLElement | null = null;
let previews: Promise<Record<string, { title: string; date: string; summary: string }>> | null = null;

function getCard() {
  // The router swaps <body> on navigation, so a card from a previous page is gone.
  if (card?.isConnected) return card;
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

function show(target: HTMLElement, title: string, body: Node[]) {
  window.clearTimeout(hideTimer);
  const c = getCard();
  const bar = document.createElement('div');
  bar.className = 'peek-bar';
  bar.textContent = title;
  const content = document.createElement('div');
  content.className = 'peek-body';
  content.append(...body);
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

function footnoteContent(ref: HTMLAnchorElement) {
  const id = decodeURIComponent(ref.hash.slice(1));
  const li = document.getElementById(id);
  if (!li) return null;
  const clone = li.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-footnote-backref]').forEach((a) => a.remove());
  const nodes = Array.from(clone.childNodes);
  const jump = document.createElement('a');
  jump.className = 'peek-jump';
  jump.href = ref.hash;
  jump.textContent = '↓ jump to note';
  const p = document.createElement('p');
  p.append(jump);
  return { title: `footnote ${ref.textContent?.trim() ?? ''}`, body: [...nodes, p] };
}

async function wikiContent(link: HTMLAnchorElement) {
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
  return { title: 'wiki // linked post', body: [t, m, s, gp] };
}

async function open(target: HTMLAnchorElement) {
  const content = target.matches('[data-footnote-ref]') ? footnoteContent(target) : await wikiContent(target);
  if (content) show(target, content.title, content.body);
}

export function initPreviews(root: HTMLElement, signal: AbortSignal) {
  card = null;
  owner = null;
  const targets = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[data-footnote-ref], a.wikilink'));
  for (const t of targets) {
    let enterTimer = 0;
    t.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse') return;
      enterTimer = window.setTimeout(() => open(t), 90);
    });
    t.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      window.clearTimeout(enterTimer);
      scheduleHide();
    });
    t.addEventListener('focus', () => open(t));
    t.addEventListener('blur', () => scheduleHide(200));
    // Touch: first tap previews, a second tap (or the card link) navigates.
    t.addEventListener('click', (e) => {
      const touch = window.matchMedia('(hover: none)').matches;
      if (touch && owner !== t) {
        e.preventDefault();
        open(t);
      }
    });
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
}
