// Only substitute familiar misspellings. The browser dictionary supplies the wider
// set of underlines and right-click suggestions for the user's writing language.
const corrections = new Map(Object.entries({
  abotu: 'about', accomodate: 'accommodate', acheive: 'achieve', adn: 'and',
  adress: 'address', agian: 'again', almsot: 'almost', alwasy: 'always',
  aparently: 'apparently', argumetn: 'argument', becasue: 'because',
  becuase: 'because', beleive: 'believe', bteween: 'between', chnage: 'change',
  comming: 'coming', commited: 'committed', concious: 'conscious',
  definately: 'definitely', definetely: 'definitely', definitley: 'definitely',
  diffrent: 'different', enviroment: 'environment', esle: 'else',
  excercise: 'exercise', exmaple: 'example', experiance: 'experience',
  firts: 'first', freind: 'friend', fucntion: 'function', goverment: 'government',
  grammer: 'grammar', hte: 'the', jsut: 'just', knwo: 'know', langauge: 'language',
  lenght: 'length', liek: 'like', lnik: 'link', mispelled: 'misspelled',
  neccessary: 'necessary', necesary: 'necessary', occassion: 'occasion',
  occured: 'occurred', ocurred: 'occurred', peice: 'piece', poeple: 'people',
  probaly: 'probably', publsih: 'publish', reciept: 'receipt', recieve: 'receive',
  recieved: 'received', recieving: 'receiving', refered: 'referred',
  remeber: 'remember', responsiblity: 'responsibility', rythym: 'rhythm',
  seperate: 'separate', similiar: 'similar', somethign: 'something', taht: 'that',
  teh: 'the', thier: 'their', thign: 'thing', thoguht: 'thought', tiem: 'time',
  tommorow: 'tomorrow', tomorow: 'tomorrow', tounge: 'tongue', truely: 'truly',
  untill: 'until', ususally: 'usually', wierd: 'weird', wiht: 'with',
  woudl: 'would', writting: 'writing', wrold: 'world', yuo: 'you',
}));

type WritingField = HTMLInputElement | HTMLTextAreaElement;
const preference = 'studio:autocorrect';

// Run this check only when the word matches the small correction dictionary.
// In ambiguous markup, keeping exactly what the author typed is the safe default.
function inProse(text: string, start: number) {
  const before = text.slice(0, start);
  const line = before.slice(before.lastIndexOf('\n') + 1);
  if (/^(?: {4}|\t|\s*\[[^\]]*\]:|\s*(?:import|export)\s)/.test(line)) return false;
  if (/^---\r?\n/.test(before) && !/\n(?:---|\.\.\.)\r?\n/.test(before)) return false;
  let openFence = '';
  const fences = /^(?:(?: {0,3}>[ \t]?)*)(?: {0,3}(?:[-+*]|\d+[.)])\s+)?[ \t]*(`{3,}|~{3,})([^\n]*)/gm;
  for (const fence of before.matchAll(fences)) {
    if (!openFence) openFence = fence[1];
    else if (fence[1].startsWith(openFence) && !fence[2].trim()) openFence = '';
  }
  if (openFence || before.lastIndexOf('<!--') > before.lastIndexOf('-->')) return false;
  if ((before.match(/(?<!\\)\$\$/g)?.length ?? 0) % 2) return false;
  // Check the current paragraph for multiline inline code, wiki-links, MDX,
  // math and link destinations. Ignore completed spans so prose after them works.
  const paragraph = before.slice(before.lastIndexOf('\n\n') + 1);
  const openers = /(?<!\\)(`+|\$+|\[\[|\]\(|\{|<(?=[A-Za-z/]))/g;
  const closing: Record<string, string> = { '[[': ']]', '](': ')', '{': '}', '<': '>' };
  for (let m; (m = openers.exec(paragraph));) {
    const delimiter = closing[m[0]] ?? m[0];
    const end = paragraph.indexOf(delimiter, openers.lastIndex);
    if (end < 0) return false;
    openers.lastIndex = end + delimiter.length;
  }
  return true;
}

function suggestion(field: WritingField) {
  const end = field.selectionStart;
  if (end === null || end !== field.selectionEnd) return;
  const value = field.value;
  // Match a whole prose word, including when the caret is in the middle of a document.
  const match = value.slice(Math.max(0, end - 50), end).match(/(?:^|[\s("'“‘*>])([a-zA-Z]{3,24})$/);
  if (!match || /[\p{L}\p{N}_/@#'’\-]/u.test(value.charAt(end))) return;
  const word = match[1];
  if (!/^[A-Z]?[a-z]+$/.test(word)) return;
  const next = corrections.get(word.toLowerCase());
  const start = end - word.length;
  if (!next || (field.hasAttribute('data-body') && !inProse(value, start))) return;
  return { start, end, word, replacement: /^[A-Z]/.test(word) ? next[0].toUpperCase() + next.slice(1) : next };
}

export function initSpelling(root: HTMLElement, signal: AbortSignal) {
  const toggle = root.querySelector<HTMLInputElement>('[data-autocorrect]')!;
  const hint = root.querySelector<HTMLButtonElement>('[data-spelling-hint]')!;
  const label = root.querySelector<HTMLElement>('[data-source-label]')!;
  // Native underlines follow the browser's dictionary for all languages.
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
      return document.execCommand('insertText', false, item.replacement + ending);
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
}
