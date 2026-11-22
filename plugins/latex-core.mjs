// Pure ESM LaTeX & BibTeX utilities — ZERO Node-only imports so this module
// can be shared by the Remark/Rehype pipeline AND browser studio scripts.

/** Built-in academic ML/math macro defaults (KaTeX macro dictionary format). */
export const DEFAULT_LATEX_MACROS = Object.freeze({
  '\\R': '\\mathbb{R}',
  '\\N': '\\mathbb{N}',
  '\\Z': '\\mathbb{Z}',
  '\\C': '\\mathbb{C}',
  '\\E': '\\mathbb{E}',
  '\\Prob': '\\mathbb{P}',
  '\\Var': '\\operatorname{Var}',
  '\\Cov': '\\operatorname{Cov}',
  '\\KL': '\\operatorname{D}_{\\mathrm{KL}}',
  '\\argmax': '\\operatorname*{arg\\,max}',
  '\\argmin': '\\operatorname*{arg\\,min}',
  '\\norm': '\\left\\lVert #1 \\right\\rVert',
  '\\abs': '\\left\\lvert #1 \\right\\rvert',
  '\\inner': '\\left\\langle #1, #2 \\right\\rangle',
  '\\dd': '\\mathrm{d}',
  '\\eps': '\\varepsilon',
  '\\T': '^{\\mathsf{T}}',
  '\\ind': '\\mathbf{1}',
});

/** Skip spaces, tabs, newlines, and LaTeX `% ...` comments. */
function skipSpaceAndComments(src, i) {
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
    } else if (ch === '%') {
      while (i < n && src[i] !== '\n') i++;
    } else {
      break;
    }
  }
  return i;
}

/**
 * Read a balanced delimiter group starting at `src[start] === open`, respecting
 * backslash escapes (`\{`, `\}`). Returns `{ content, end }` where `end` is the
 * index immediately after the matching `close`, or `null` if unbalanced.
 */
function readBalanced(src, start, open = '{', close = '}') {
  if (src[start] !== open) return null;
  let depth = 0;
  let i = start;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < n) {
      i += 2;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return { content: src.slice(start + 1, i), end: i + 1 };
      }
    }
    i++;
  }
  return null;
}

/** Read a LaTeX control sequence (`\foo` or single non-letter `\,`). */
function readCommandName(src, i) {
  if (src[i] !== '\\') return null;
  const start = i;
  i++;
  if (i >= src.length) return null;
  if (/[A-Za-z@]/.test(src[i])) {
    while (i < src.length && /[A-Za-z@]/.test(src[i])) i++;
  } else {
    i++;
  }
  return { name: src.slice(start, i), end: i };
}

/**
 * Parse `\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareMathOperator`,
 * and `\DeclareMathOperator*` definitions from a LaTeX preamble string.
 *
 * Handles balanced nested braces, optional `*`, bare `\name` or `{\name}`,
 * optional `[n]` arg count, optional `[default]` arg, and `%` comments.
 *
 * @param {string} src
 * @returns {{ macros: Record<string, string>, entries: Array<{ name: string, args: number, body: string, kind: 'command' | 'operator' | 'operator*' }> }}
 */
export function parseLatexPreamble(src) {
  /** @type {Record<string, string>} */
  const macros = {};
  /** @type {Array<{ name: string, args: number, body: string, kind: 'command' | 'operator' | 'operator*' }>} */
  const entries = [];
  if (typeof src !== 'string' || !src.trim()) return { macros, entries };

  const n = src.length;
  let i = 0;

  while (i < n) {
    if (src[i] === '%') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (src[i] !== '\\') {
      i++;
      continue;
    }
    // Check if preceded by an unescaped backslash (e.g. \\newcommand)
    let bsCount = 0;
    for (let k = i - 1; k >= 0 && src[k] === '\\'; k--) bsCount++;
    if (bsCount % 2 === 1) {
      i++;
      continue;
    }

    const cmdMatch = /^\\(newcommand|renewcommand|providecommand|DeclareMathOperator)\b/.exec(src.slice(i));
    if (!cmdMatch) {
      i++;
      continue;
    }

    const directive = cmdMatch[1];
    let pos = i + cmdMatch[0].length;
    let starred = false;
    pos = skipSpaceAndComments(src, pos);
    if (src[pos] === '*') {
      starred = true;
      pos++;
    }
    pos = skipSpaceAndComments(src, pos);

    // Target command name: either {\foo} or bare \foo
    let name = '';
    if (src[pos] === '{') {
      const grp = readBalanced(src, pos, '{', '}');
      if (!grp) {
        i = pos + 1;
        continue;
      }
      const trimmed = grp.content.trim();
      if (!/^\\(?:[A-Za-z@]+|[^A-Za-z\s])$/.test(trimmed)) {
        i = grp.end;
        continue;
      }
      name = trimmed;
      pos = grp.end;
    } else if (src[pos] === '\\') {
      const cmd = readCommandName(src, pos);
      if (!cmd) {
        i = pos + 1;
        continue;
      }
      name = cmd.name;
      pos = cmd.end;
    } else {
      i = pos + 1;
      continue;
    }

    pos = skipSpaceAndComments(src, pos);

    if (directive === 'DeclareMathOperator') {
      const bodyGrp = readBalanced(src, pos, '{', '}');
      if (!bodyGrp) {
        i = pos + 1;
        continue;
      }
      const text = bodyGrp.content.trim();
      const body = starred ? `\\operatorname*{${text}}` : `\\operatorname{${text}}`;
      const kind = starred ? 'operator*' : 'operator';
      macros[name] = body;
      entries.push({ name, args: 0, body, kind });
      i = bodyGrp.end;
      continue;
    }

    // \newcommand / \renewcommand / \providecommand
    let args = 0;
    if (src[pos] === '[') {
      const argGrp = readBalanced(src, pos, '[', ']');
      if (argGrp && /^\s*\d+\s*$/.test(argGrp.content)) {
        args = Math.min(9, Math.max(0, Number(argGrp.content.trim())));
        pos = skipSpaceAndComments(src, argGrp.end);
        // Optional default value for arg #1: \newcommand{\foo}[2][default]{...}
        if (src[pos] === '[') {
          const defGrp = readBalanced(src, pos, '[', ']');
          if (defGrp) pos = skipSpaceAndComments(src, defGrp.end);
        }
      }
    }

    const bodyGrp = readBalanced(src, pos, '{', '}');
    if (!bodyGrp) {
      i = pos + 1;
      continue;
    }

    const body = bodyGrp.content;
    if (args === 0) {
      // Infer arity from #1..#9 placeholders if [n] was omitted
      for (const m of body.matchAll(/(?<!\\)#([1-9])/g)) {
        const k = Number(m[1]);
        if (k > args) args = k;
      }
    }
    macros[name] = body;
    entries.push({ name, args, body, kind: 'command' });
    i = bodyGrp.end;
  }

  return { macros, entries };
}

// --------------------------------------------------------------------- BibTeX

const LATEX_ACCENTS = {
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý', C: 'Ć', N: 'Ń', S: 'Ś', Z: 'Ź' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', c: 'ĉ', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü', Y: 'Ÿ' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  '=': { a: 'ā', e: 'ē', i: 'ī', o: 'ō', u: 'ū', A: 'Ā', E: 'Ē', I: 'Ī', O: 'Ō', U: 'Ū' },
  '.': { z: 'ż', Z: 'Ż', c: 'ċ', e: 'ė', g: 'ġ', I: 'İ' },
  u: { a: 'ă', g: 'ğ', A: 'Ă', G: 'Ğ' },
  v: { c: 'č', s: 'š', z: 'ž', r: 'ř', n: 'ň', e: 'ě', C: 'Č', S: 'Š', Z: 'Ž', R: 'Ř' },
  H: { o: 'ő', u: 'ű', O: 'Ő', U: 'Ű' },
  c: { c: 'ç', s: 'ş', t: 'ţ', C: 'Ç', S: 'Ş', T: 'Ţ' },
  r: { a: 'å', u: 'ů', A: 'Å', U: 'Ů' },
  k: { a: 'ą', e: 'ę', A: 'Ą', E: 'Ę' },
};

const LATEX_SPECIAL_LETTERS = {
  '\\aa': 'å',
  '\\AA': 'Å',
  '\\ae': 'æ',
  '\\AE': 'Æ',
  '\\oe': 'œ',
  '\\OE': 'Œ',
  '\\o': 'ø',
  '\\O': 'Ø',
  '\\l': 'ł',
  '\\L': 'Ł',
  '\\ss': 'ß',
  '\\i': 'ı',
  '\\j': 'ȷ',
};

/** Decode common LaTeX diacritics, typography, and protective braces in BibTeX text. */
function decodeLatexText(raw) {
  if (!raw) return '';
  let s = String(raw);

  // Normalize whitespace/newlines inside BibTeX field values
  s = s.replace(/\s+/g, ' ').trim();

  // Handle {\'e}, {\"o}, {\c{c}}, {\'{\i}}, etc. and unbraced \'e, \"o, \c{c}
  // 1. Symbolic accents: \' \` \^ \" \~ \= \.
  s = s.replace(/\\(['`^"~=.])\{\\?([A-Za-z])\}/g, (m, acc, ch) => LATEX_ACCENTS[acc]?.[ch] ?? m);
  s = s.replace(/\\(['`^"~=.])([A-Za-z])/g, (m, acc, ch) => LATEX_ACCENTS[acc]?.[ch] ?? m);
  // 2. Letter accents: \c{c}, \v{s}, \u{a}, \H{o}, \r{a}, \k{a}
  s = s.replace(/\\([uvHcrk])\{\\?([A-Za-z])\}/g, (m, acc, ch) => LATEX_ACCENTS[acc]?.[ch] ?? m);
  s = s.replace(/\\([uvHcrk])\s+([A-Za-z])/g, (m, acc, ch) => LATEX_ACCENTS[acc]?.[ch] ?? m);

  // Special letters like \o, \l, \aa, \ss (terminated by non-letter or {})
  s = s.replace(/\\(aa|AA|ae|AE|oe|OE|ss|[oOlL])(?:\{\}|\b)/g, (m, cmd) => LATEX_SPECIAL_LETTERS[`\\${cmd}`] ?? m);

  // Common LaTeX text escapes and punctuation
  s = s
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\\_/g, '_')
    .replace(/\\\$/g, '$')
    .replace(/\\#/g, '#')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '“')
    .replace(/''/g, '”')
    .replace(/~/g, ' ')
    .replace(/\\(?:emph|textit|textbf|texttt|textrm|textsc)\{([^{}]*)\}/g, '$1');

  // Strip protective BibTeX braces `{Attention}` → `Attention` (outside $...$ math)
  let out = '';
  let inMath = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '$' && s[i - 1] !== '\\') {
      inMath = !inMath;
      out += ch;
      continue;
    }
    if (!inMath && (ch === '{' || ch === '}')) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Split BibTeX author list on top-level ` and ` (case-insensitive, brace depth 0). */
function splitBibAuthors(raw) {
  if (!raw || !raw.trim()) return [];
  const parts = [];
  let depth = 0;
  let start = 0;
  const s = raw.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /\s/.test(ch)) {
      const m = /^\s+and\s+/i.exec(s.slice(i));
      if (m) {
        parts.push(s.slice(start, i).trim());
        i += m[0].length - 1;
        start = i + 1;
      }
    }
  }
  const tail = s.slice(start).trim();
  if (tail) parts.push(tail);

  return parts
    .map((p) => {
      // Corporate / protected single-token author like "{OpenAI}"
      if (/^\{[^{}]+\}$/.test(p)) {
        return { first: '', last: decodeLatexText(p) };
      }
      const decoded = decodeLatexText(p);
      if (!decoded) return null;
      if (decoded.includes(',')) {
        // "Last, First" or "Last, Jr., First"
        const segs = decoded.split(',').map((x) => x.trim()).filter(Boolean);
        if (segs.length >= 2) {
          const last = segs[0];
          const first = segs.slice(1).join(' ');
          return { first, last };
        }
      }
      const tokens = decoded.split(/\s+/).filter(Boolean);
      if (tokens.length === 1) return { first: '', last: tokens[0] };
      // Handle lowercase noble particles like "van der Waals", "de la Cruz"
      let lastStart = tokens.length - 1;
      while (lastStart > 1 && /^[a-z]/.test(tokens[lastStart - 1])) lastStart--;
      return {
        first: tokens.slice(0, lastStart).join(' '),
        last: tokens.slice(lastStart).join(' '),
      };
    })
    .filter(Boolean);
}

/** Read a BibTeX value expression (supporting `{...}`, `"..."`, bare tokens, and `#` concatenation). */
function readBibValue(src, i, stringDefs) {
  const n = src.length;
  const pieces = [];
  while (i < n) {
    i = skipSpaceAndComments(src, i);
    if (i >= n) break;
    const ch = src[i];
    if (ch === '{') {
      const grp = readBalanced(src, i, '{', '}');
      if (!grp) {
        pieces.push(src.slice(i + 1));
        i = n;
        break;
      }
      pieces.push(grp.content);
      i = grp.end;
    } else if (ch === '"') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\' && j + 1 < n) {
          j += 2;
          continue;
        }
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth = Math.max(0, depth - 1);
        else if (src[j] === '"' && depth === 0) break;
        j++;
      }
      pieces.push(src.slice(i + 1, j));
      i = j < n ? j + 1 : n;
    } else {
      let j = i;
      while (j < n && !/[,})\s#]/.test(src[j])) j++;
      const tok = src.slice(i, j);
      const lower = tok.toLowerCase();
      pieces.push(stringDefs.has(lower) ? stringDefs.get(lower) : tok);
      i = j;
    }
    i = skipSpaceAndComments(src, i);
    if (src[i] === '#') {
      i++;
      continue;
    }
    break;
  }
  return { value: pieces.join(''), end: i };
}

/**
 * Resilient BibTeX parser supporting `@article`, `@inproceedings`, `@book`,
 * `@misc`, `@phdthesis`, `@techreport`, `@preprint`, `@string`, nested braces,
 * quoted values, `#` concatenation, LaTeX diacritics, and author parsing.
 *
 * @param {string} src
 */
export function parseBibTeX(src) {
  if (typeof src !== 'string' || !src.trim()) return [];
  const entries = [];
  const stringDefs = new Map([
    ['jan', 'January'], ['feb', 'February'], ['mar', 'March'], ['apr', 'April'],
    ['may', 'May'], ['jun', 'June'], ['jul', 'July'], ['aug', 'August'],
    ['sep', 'September'], ['oct', 'October'], ['nov', 'November'], ['dec', 'December'],
  ]);

  const n = src.length;
  let i = 0;

  while (i < n) {
    const at = src.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;

    // Read entry type
    const typeMatch = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(src.slice(i));
    if (!typeMatch) continue;
    const type = typeMatch[1].toLowerCase();
    i += typeMatch[0].length;
    i = skipSpaceAndComments(src, i);

    const openCh = src[i];
    if (openCh !== '{' && openCh !== '(') continue;
    const closeCh = openCh === '{' ? '}' : ')';
    const bodyGrp = readBalanced(src, i, openCh, closeCh);
    if (!bodyGrp) break;

    const raw = src.slice(at, bodyGrp.end);
    const inner = bodyGrp.content;
    i = bodyGrp.end;

    if (type === 'comment' || type === 'preamble') continue;

    if (type === 'string') {
      const eq = inner.indexOf('=');
      if (eq > 0) {
        const k = inner.slice(0, eq).trim().toLowerCase();
        const { value } = readBibValue(inner, eq + 1, stringDefs);
        if (k) stringDefs.set(k, value);
      }
      continue;
    }

    // Citation key is before first comma
    const comma = inner.indexOf(',');
    if (comma < 0) continue;
    const key = inner.slice(0, comma).trim();
    if (!key) continue;

    /** @type {Record<string, string>} */
    const fields = {};
    let p = comma + 1;
    const len = inner.length;
    while (p < len) {
      p = skipSpaceAndComments(inner, p);
      if (p >= len) break;
      if (inner[p] === ',') {
        p++;
        continue;
      }
      const fieldMatch = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(inner.slice(p));
      if (!fieldMatch) {
        // Skip to next comma to recover gracefully from malformed lines
        const nextComma = inner.indexOf(',', p);
        if (nextComma < 0) break;
        p = nextComma + 1;
        continue;
      }
      const fieldName = fieldMatch[1].toLowerCase();
      p += fieldMatch[0].length;
      p = skipSpaceAndComments(inner, p);
      if (inner[p] !== '=') {
        const nextComma = inner.indexOf(',', p);
        if (nextComma < 0) break;
        p = nextComma + 1;
        continue;
      }
      p++; // skip '='
      const { value, end } = readBibValue(inner, p, stringDefs);
      fields[fieldName] = value;
      p = end;
      p = skipSpaceAndComments(inner, p);
      if (inner[p] === ',') p++;
    }

    const rawAuthor = fields.author || fields.editor || '';
    const authors = splitBibAuthors(rawAuthor);
    const eprint = decodeLatexText(fields.eprint || '');
    const archivePrefix = decodeLatexText(fields.archiveprefix || '');
    const venueRaw =
      fields.booktitle ||
      fields.journal ||
      fields.school ||
      fields.institution ||
      fields.publisher ||
      fields.howpublished ||
      (eprint ? `${archivePrefix || 'arXiv'}:${eprint}` : '');

    entries.push({
      key,
      type,
      title: decodeLatexText(fields.title || ''),
      author: decodeLatexText(rawAuthor),
      authors,
      year: decodeLatexText(fields.year || '').replace(/[^0-9a-zA-Z-]/g, ''),
      venue: decodeLatexText(venueRaw),
      volume: decodeLatexText(fields.volume || ''),
      pages: decodeLatexText(fields.pages || ''),
      url: (fields.url || '').trim(),
      doi: (fields.doi || '').trim(),
      eprint,
      note: decodeLatexText(fields.note || ''),
      raw,
    });
  }

  return entries;
}

/** Short citation form: "Vaswani", "Vaswani & Shazeer", "Vaswani et al.". */
export function formatAuthorsShort(authors) {
  if (!Array.isArray(authors) || authors.length === 0) return '';
  const last = (a) => (a?.last || a?.first || '').trim();
  if (authors.length === 1) return last(authors[0]);
  if (authors.length === 2) return `${last(authors[0])} & ${last(authors[1])}`;
  return `${last(authors[0])} et al.`;
}

/** Full bibliography author string: "Ashish Vaswani, Noam Shazeer, & Niki Parmar". */
export function formatAuthorsFull(authors) {
  if (!Array.isArray(authors) || authors.length === 0) return '';
  const names = authors
    .map((a) => [a?.first, a?.last].filter(Boolean).join(' ').trim())
    .filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
}

/**
 * Format an inline citation label.
 * @param {any} entry Parsed BibTeX entry
 * @param {number} index 0-based citation order index
 * @param {'numeric' | 'author-year'} [style='numeric']
 */
export function formatCitationLabel(entry, index, style = 'numeric') {
  if (style === 'author-year') {
    const who = formatAuthorsShort(entry?.authors) || entry?.author || entry?.key || '?';
    const year = entry?.year || 'n.d.';
    return `(${who}, ${year})`;
  }
  const num = Number.isFinite(index) ? index + 1 : 1;
  return `[${num}]`;
}

/**
 * Turn a prefix + LaTeX label/key into a clean HTML id (e.g. `safeAnchorId('eq', 'eq:loss')` → `'eq-loss'`).
 */
export function safeAnchorId(prefix, label) {
  const pre = String(prefix ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '');
  let body = String(label ?? '').trim().toLowerCase();
  if (pre && (body.startsWith(`${pre}:`) || body.startsWith(`${pre}-`))) {
    const stripped = body.slice(pre.length + 1);
    if (stripped) body = stripped;
  }
  const slug = body
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
  return pre ? `${pre}-${slug}` : slug;
}

/**
 * Turn a raw KaTeX error message into a concise, actionable fix hint.
 * @param {string} errorMessage
 * @param {string} [tex='']
 */
export function friendlyKatexHint(errorMessage, tex = '') {
  const msg = String(errorMessage ?? '').replace(/^KaTeX parse error:\s*/i, '').trim();

  const undef = /Undefined control sequence:\s*(\\[A-Za-z@]+|\\.)/.exec(msg);
  if (undef) {
    return `Unknown command "${undef[1]}" — check spelling or define it via \\newcommand in Preamble Macros.`;
  }

  const noEnv = /No such environment:\s*([^\s]+)/.exec(msg);
  if (noEnv) {
    return `Unsupported environment "${noEnv[1]}" — use a KaTeX environment such as aligned, gathered, cases, pmatrix, or bmatrix.`;
  }

  const mismatch = /Mismatched\s+\\begin\{([^}]+)\}.*\\end\{([^}]+)\}/i.exec(msg);
  if (mismatch) {
    return `Environment mismatch: \\begin{${mismatch[1]}} was closed by \\end{${mismatch[2]}}.`;
  }

  if (/Expected '\\end\{([^}]+)\}'/i.test(msg) || /Missing \\end/i.test(msg)) {
    const m = /\\end\{([^}]+)\}/.exec(msg);
    return m ? `Missing \\end{${m[1]}} to close the environment.` : 'Missing matching \\end{...} for an opened \\begin{...} environment.';
  }

  if (/Expected 'EOF', got '\}'/i.test(msg) || /Extra \}/i.test(msg)) {
    return 'Extra closing brace "}" — check for an unmatched "{" or remove the stray "}".';
  }

  if (/Expected '\}', got 'EOF'/i.test(msg) || /Unexpected end of input/i.test(msg) || /Expected group/i.test(msg)) {
    const opens = (tex.match(/(?<!\\)\{/g) || []).length;
    const closes = (tex.match(/(?<!\\)\}/g) || []).length;
    if (opens > closes) {
      return `Unclosed "{" — add ${opens - closes} missing closing "}" brace${opens - closes > 1 ? 's' : ''}.`;
    }
    return 'Incomplete command or missing "{...}" argument (e.g. \\frac{a}{b}).';
  }

  if (/Misplaced &/i.test(msg) || /Expected 'EOF', got '&'/i.test(msg)) {
    return 'Alignment tab "&" can only be used inside align, aligned, cases, or matrix environments.';
  }

  if (/Double subscript/i.test(msg)) {
    return 'Double subscript — wrap nested subscripts in braces, e.g. x_{i_1}.';
  }

  if (/Double superscript/i.test(msg)) {
    return 'Double superscript — wrap nested superscripts in braces, e.g. x^{a^2}.';
  }

  if (/Missing \\right/i.test(msg) || /Extra \\right/i.test(msg) || /Invalid delimiter/i.test(msg)) {
    return 'Unmatched \\left / \\right delimiter — pair every \\left with a matching \\right (use \\right. for an invisible side).';
  }

  if (/can be used only in text mode/i.test(msg)) {
    return 'This command only works in text mode — wrap it inside \\text{...}.';
  }

  if (/can be used only in math mode/i.test(msg)) {
    return 'This command only works in math mode — move it outside \\text{...}.';
  }

  if (/Too many math in a row/i.test(msg) || /Only one column/i.test(msg)) {
    return 'Too many "&" alignment columns in this environment row.';
  }

  return msg || 'Check LaTeX syntax for unmatched braces or unsupported commands.';
}
