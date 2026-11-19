import Typo from 'typo-js';
import aff from 'typo-js/dictionaries/en_US/en_US.aff?raw';
import dic from 'typo-js/dictionaries/en_US/en_US.dic?raw';
import { preferredSpelling, spellingWords, type SpellingWord } from './spelling-words';

export type SpellRequest =
  | { field: number; revision: number; source: string; markdown: boolean }
  | { request: number; word: string };
export type SpellReply =
  | { field: number; revision: number; issues: SpellingWord[] }
  | { request: number; suggestions: string[] };

const dictionary = new Typo('en_US', aff, dic);
const checked = new Map<string, boolean>();

self.onmessage = ({ data }: MessageEvent<SpellRequest>) => {
  let reply: SpellReply;
  if ('word' in data) {
    reply = { request: data.request, suggestions: dictionary.suggest(data.word.replaceAll('’', "'"), 5) };
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
