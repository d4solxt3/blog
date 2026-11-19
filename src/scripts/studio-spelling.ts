import { preferredSpelling, spellingWords } from './spelling-words';
import { initSpellMarks } from './studio-spell-marks';

type WritingField = HTMLInputElement | HTMLTextAreaElement;
const preference = 'studio:autocorrect';

function suggestion(field: WritingField) {
  const end = field.selectionStart;
  if (end === null || end !== field.selectionEnd) return;
  const value = field.value;
  // Match a whole prose word, including when the caret is in the middle of a document.
  const match = value.slice(Math.max(0, end - 50), end).match(/(?:^|[\s("'“‘*>])([a-zA-Z]{3,24})$/);
  if (!match || /[\p{L}\p{N}_/@#'’\-]/u.test(value.charAt(end))) return;
  const word = match[1];
  if (!/^[A-Z]?[a-z]+$/.test(word)) return;
  const next = preferredSpelling(word);
  const start = end - word.length;
  if (!next) return;
  if (field.hasAttribute('data-body')) {
    let prose = false;
    for (const token of spellingWords(value.slice(0, end), true)) {
      if (token.start === start && token.word === word) { prose = true; break; }
    }
    if (!prose) return;
  }
  return { start, end, word, replacement: next };
}

export function initSpelling(root: HTMLElement, signal: AbortSignal) {
  const toggle = root.querySelector<HTMLInputElement>('[data-autocorrect]')!;
  const hint = root.querySelector<HTMLButtonElement>('[data-spelling-hint]')!;
  const label = root.querySelector<HTMLElement>('[data-source-label]')!;
  // For other languages keep the browser’s own dictionary and context menu.
  if (!/^en(?:-|$)/i.test(document.documentElement.lang || 'en')) {
    toggle.closest('label')!.hidden = true;
    return;
  }
  try { toggle.checked = localStorage.getItem(preference) !== 'off'; } catch {}
  toggle.addEventListener('change', () => {
    try { localStorage.setItem(preference, toggle.checked ? 'on' : 'off'); } catch {}
  }, { signal });

  let composing = false;
  let replacing = false;
  let active: WritingField | null = null;
  function renderHint() {
    const item = active && !composing ? suggestion(active) : undefined;
    hint.hidden = !item;
    label.hidden = !!item;
    if (item) {
      hint.textContent = item.word + ' → ' + item.replacement;
      hint.setAttribute('aria-label', 'Replace ' + item.word + ' with ' + item.replacement);
    }
  }
  function insert(field: WritingField, item: NonNullable<ReturnType<typeof suggestion>>, ending: string) {
    field.focus({ preventScroll: true });
    field.setSelectionRange(item.start, item.end);
    replacing = true;
    try {
      // A native insertion gives this correction an undo step and sends the same
      // input event used by the studio for backup, autosave and live preview.
      const text = item.replacement + ending;
      if (!document.execCommand('insertText', false, text)) {
        field.setRangeText(text, item.start, item.end, 'end');
        field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
      }
      return true;
    } finally {
      replacing = false;
      if (field.selectionStart !== field.selectionEnd) field.setSelectionRange(item.end, item.end);
      renderHint();
    }
  }
  hint.addEventListener('mousedown', (event) => event.preventDefault(), { signal });
  hint.addEventListener('blur', () => { active = null; renderHint(); }, { signal });
  hint.addEventListener('click', () => {
    const item = active && suggestion(active);
    if (active && item) insert(active, item, '');
  }, { signal });

  for (const field of root.querySelectorAll<WritingField>('[data-spelling]')) {
    field.addEventListener('focus', () => { active = field; renderHint(); }, { signal });
    field.addEventListener('blur', (event) => {
      if ((event as FocusEvent).relatedTarget === hint) return;
      active = null;
      renderHint();
    }, { signal });
    field.addEventListener('compositionstart', () => { composing = true; renderHint(); }, { signal });
    field.addEventListener('compositionend', () => { composing = false; renderHint(); }, { signal });
    field.addEventListener('input', renderHint, { signal });
    field.addEventListener('selectionchange', renderHint, { signal });
    field.addEventListener('beforeinput', (event) => {
      const input = event as InputEvent;
      if (!toggle.checked || !input.cancelable || composing || input.isComposing || replacing) return;
      const ending = input.inputType === 'insertLineBreak' ? '\n' : input.data;
      if (!ending || !['insertText', 'insertLineBreak'].includes(input.inputType) || !/^[ .,;:!?\n]$/.test(ending)) return;
      const item = suggestion(field);
      if (item && insert(field, item, ending)) input.preventDefault();
    }, { signal });
  }
  return initSpellMarks(root, signal, (field, item, replacement) => {
    insert(field, { ...item, end: item.start + item.word.length, replacement }, '');
  });
}
