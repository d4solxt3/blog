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

export function studioSpellingLanguage(language: string) {
  return /^en(?:-|$)/i.test(language) ? 'en-GB' : language;
}

export function preferredSpelling(word: string) {
  const fixed = corrections.get(word.toLowerCase());
  return fixed && (/^[A-Z]/.test(word) ? fixed[0].toUpperCase() + fixed.slice(1) : fixed);
}

export interface SpellingWord { start: number; word: string }

const wordPattern = /[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*/gu;

// Find Markdown syntax before checking individual words, so code and destinations
// stay intact. A missing closer is normal while an author is mid-keystroke.
function protectedText() {
  return /^(?:[ \t]*>[ \t]*)*(?: {0,3}(?:[-*+]|\d+[.)])\s+)?[ \t]*(`{3,}|~{3,})[^\n]*|^(?: {4}|\t)[^\n]*|^ {0,3}(?:\[(?!\^)[^\]\n]+\]:|import\s|export\s)[^\n]*|<!--|`+|\${1,2}|\[\[|\]\(|\]\[|\{|<\/?[A-Za-z][\w.:_-]*(?=[\s/>])|(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\/|\.{1,2}\/)[\w./%#?=&-]+/gim;
}

function afterSyntax(source: string, match: RegExpExecArray) {
  const token = match[0];
  const from = match.index + token.length;
  if (match[1]) {
    const fence = match[1];
    const closer = new RegExp('^(?:[ \\t]*>[ \\t]*)*[ \\t]*' + fence[0] + '{' + fence.length + ',}[ \\t]*\\r?$', 'gm');
    closer.lastIndex = from;
    return closer.exec(source) ? closer.lastIndex : source.length;
  }
  if (token === '{' || token === '](') {
    const open = token.slice(-1);
    const close = open === '{' ? '}' : ')';
    let depth = 1;
    for (let pos = from; pos < source.length; pos++) {
      if (source[pos] === '\\') pos++;
      else if (source[pos] === open) depth++;
      else if (source[pos] === close && --depth === 0) return pos + 1;
    }
    return source.length;
  }
  const end = token === '<!--' ? '-->' : token[0] === '<' ? '>' : token === '[[' ? ']]' :
    token === '][' ? ']' : /^[`$]/.test(token) ? token : '';
  if (!end) return from;
  const at = source.indexOf(end, from);
  if (at >= 0) return at + end.length;
  // A single currency sign or an unfinished inline token shouldn't swallow later paragraphs.
  if (token === '$' && /\d/.test(source.charAt(from))) return from;
  if (token === '$' || token[0] === '`') {
    const next = source.indexOf('\n\n', from);
    if (next >= 0) return next;
  }
  return source.length;
}

export function* spellingWords(source: string, markdown: boolean): Generator<SpellingWord> {
  const syntax = protectedText();
  let pos = 0;
  if (markdown && /^---\r?\n/.test(source)) {
    const end = /\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source);
    pos = end ? end.index + end[0].length : source.length;
  }
  while (pos < source.length) {
    syntax.lastIndex = pos;
    const protectedSpan = markdown ? syntax.exec(source) : null;
    const limit = protectedSpan?.index ?? source.length;
    for (const m of source.slice(pos, limit).matchAll(wordPattern)) {
      const word = m[0];
      if (word.length < 2 || word.length > 40 || !/^[A-Z]?[a-z]+(?:['’][a-z]+)*$/.test(word)) continue;
      yield { start: pos + m.index!, word };
    }
    if (!protectedSpan) break;
    pos = afterSyntax(source, protectedSpan);
  }
}
