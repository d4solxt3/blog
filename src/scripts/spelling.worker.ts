import Typo from 'typo-js';
import aff from 'dictionary-en-gb/index.aff?raw';
import dic from 'dictionary-en-gb/index.dic?raw';
import { preferredSpelling, spellingWords, type SpellingWord } from './spelling-words';

export type SpellRequest =
  | { field: number; revision: number; source: string; markdown: boolean }
  | { request: number; word: string };
export type SpellReply =
  | { field: number; revision: number; issues: SpellingWord[] }
  | { request: number; suggestions: string[] };

const dictionary = new Typo('en_GB', aff, dic);
const checked = new Map<string, boolean>();

function suggestions(word: string) {
  // Typo can rank unrelated one-letter edits above centre, colour or organise.
  // Promote a regional spelling only when it exists in the British dictionary.
  const variants = [
    word.replace(/er(s|'s)?$/, 're$1'),
    word.replace(/or(s|'s)?$/, 'our$1'),
    word.replace(/iz(e|es|ed|ing|ation|ations)$/, 'is$1'),
  ].filter((variant) => variant !== word && dictionary.check(variant));
  return [...new Set([...variants, ...dictionary.suggest(word, 5)])].slice(0, 5);
}

self.onmessage = ({ data }: MessageEvent<SpellRequest>) => {
  let reply: SpellReply;
  if ('word' in data) {
    reply = { request: data.request, suggestions: suggestions(data.word.replaceAll('’', "'")) };
  } else {
    const issues: SpellingWord[] = [];
    for (const item of spellingWords(data.source, data.markdown)) {
      const word = item.word.replaceAll('’', "'");
      let correct = checked.get(word);
      if (correct === undefined) {
        correct = !preferredSpelling(word) && dictionary.check(word);
        checked.set(word, correct);
      }
      if (!correct) issues.push(item);
    }
    reply = { field: data.field, revision: data.revision, issues };
  }
  self.postMessage(reply);
};
