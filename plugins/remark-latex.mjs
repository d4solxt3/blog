// arXiv-tier Remark plugin:
// - Micromark extensions for \(...\), \[...\], bare math environments
//   (equation, align, gather, multline, flalign, alignat + starred variants),
//   and standalone \newcommand / \renewcommand / \providecommand / \DeclareMathOperator
// - Global + per-post + inline LaTeX macro merging
// - Sequential equation numbering & \label / \tag / \nonumber handling
// - Theorem-like environments & Algorithm blocks (\begin{...} and :::... fences)
// - Cross-references (\eqref, \ref, \cref, \Cref) with deferred figure resolution
// - BibTeX (frontmatter + ```bibtex fences), \cite/\citep/\citet/[@key], and References section
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { markdownLineEnding, markdownSpace } from 'micromark-util-character';
import { visit, SKIP } from 'unist-util-visit';
import {
  DEFAULT_LATEX_MACROS,
  formatAuthorsFull,
  formatAuthorsShort,
  formatCitationLabel,
  parseBibTeX,
  parseLatexPreamble,
  safeAnchorId,
} from './latex-core.mjs';

const MATH_ENVS = new Set([
  'equation', 'equation*',
  'align', 'align*',
  'gather', 'gather*',
  'multline', 'multline*',
  'flalign', 'flalign*',
  'alignat', 'alignat*',
]);

const ROW_ENVS = new Set([
  'align', 'align*',
  'gather', 'gather*',
  'flalign', 'flalign*',
  'alignat', 'alignat*',
]);

const NUMBERED_THEOREM_ENVS = new Map([
  ['finding', 'Finding'],
  ['hypothesis', 'Hypothesis'],
  ['experiment', 'Experiment'],
  ['theorem', 'Theorem'],
  ['lemma', 'Lemma'],
  ['proposition', 'Proposition'],
  ['corollary', 'Corollary'],
  ['definition', 'Definition'],
  ['assumption', 'Assumption'],
  ['example', 'Example'],
  ['remark', 'Remark'],
  ['algorithm', 'Algorithm'],
]);

const ALL_PROSE_ENVS = new Set([...NUMBERED_THEOREM_ENVS.keys(), 'proof', 'takeaway']);

// ---------------------------------------------------- Global Config (Node fs)

/** Load global LaTeX macros & default citationStyle from site.config.json + optional runtime override. */
function loadGlobalLatexConfig() {
  const macros = { ...DEFAULT_LATEX_MACROS };
  let citationStyle = 'numeric';

  try {
    const cfgPath = resolve(process.cwd(), 'site.config.json');
    if (existsSync(cfgPath)) {
      const site = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (site?.latex?.macros && typeof site.latex.macros === 'object') {
        for (const [k, v] of Object.entries(site.latex.macros)) {
          if (typeof k === 'string' && k.startsWith('\\') && typeof v === 'string') {
            macros[k] = v;
          }
        }
      }
      if (site?.latex?.citationStyle === 'author-year' || site?.latex?.citationStyle === 'numeric') {
        citationStyle = site.latex.citationStyle;
      }
    }
  } catch {
    // Fall back silently to DEFAULT_LATEX_MACROS
  }

  try {
    const dataDir = resolve(process.env.DATA_DIR || dirname(process.env.COMMENTS_JSON_PATH || 'data/comments.json'));
    const overridePath = resolve(dataDir, 'latex-macros.json');
    if (existsSync(overridePath)) {
      const ov = JSON.parse(readFileSync(overridePath, 'utf8'));
      if (ov?.macros && typeof ov.macros === 'object') {
        // Override replaces the site.config macro set completely when present
        for (const key of Object.keys(macros)) delete macros[key];
        for (const [k, v] of Object.entries(ov.macros)) {
          if (typeof k === 'string' && k.startsWith('\\') && typeof v === 'string') {
            macros[k] = v;
          }
        }
      }
      if (ov?.citationStyle === 'author-year' || ov?.citationStyle === 'numeric') {
        citationStyle = ov.citationStyle;
      }
    }
  } catch {
    // Ignore malformed override file
  }

  return { macros, citationStyle };
}

// --------------------------------------------------- Micromark Syntax Helpers

function makeStringMatcher(str) {
  return [...str].map((ch) => ch.charCodeAt(0));
}

const PREAMBLE_PREFIXES = [
  '\\newcommand',
  '\\renewcommand',
  '\\providecommand',
  '\\DeclareMathOperator',
].map(makeStringMatcher);

const BEGIN_PREFIX = makeStringMatcher('\\begin{');

/** Flow construct: `\[ ... \]` (single-line or multi-line display math). */
const latexBracketFlow = {
  name: 'latexBracketFlow',
  concrete: true,
  tokenize(effects, ok, nok) {
    let bsCount = 0;
    return start;

    function start(code) {
      if (code !== 92) return nok(code);
      effects.enter('latexBracketFlow');
      effects.consume(code);
      return afterSlash;
    }
    function afterSlash(code) {
      if (code !== 91) return nok(code); // '['
      effects.consume(code);
      return body;
    }
    function body(code) {
      if (code === null) return nok(code);
      if (markdownLineEnding(code)) {
        bsCount = 0;
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return body;
      }
      if (code === 92) {
        bsCount++;
        effects.consume(code);
        return body;
      }
      if (code === 93 && bsCount % 2 === 1) {
        // Closing `\]`
        bsCount = 0;
        effects.consume(code);
        return trailing;
      }
      bsCount = 0;
      effects.consume(code);
      return body;
    }
    function trailing(code) {
      if (markdownSpace(code)) {
        effects.consume(code);
        return trailing;
      }
      if (code === null || markdownLineEnding(code)) {
        effects.exit('latexBracketFlow');
        return ok(code);
      }
      // Text follows `\]` on the same line → let inline construct handle it
      return nok(code);
    }
  },
};

/** Flow construct: bare `\begin{align}...\end{align}` etc. for math environments. */
const latexEnvFlow = {
  name: 'latexEnvFlow',
  concrete: true,
  tokenize(effects, ok, nok) {
    let idx = 0;
    let envName = '';
    let depth = 1;
    let closeBuf = '';
    let targetEnd = '';
    let targetBegin = '';

    return matchBegin;

    function matchBegin(code) {
      if (idx === 0) {
        if (code !== 92) return nok(code);
        effects.enter('latexEnvFlow');
      }
      if (code !== BEGIN_PREFIX[idx]) return nok(code);
      effects.consume(code);
      idx++;
      if (idx === BEGIN_PREFIX.length) return readEnvName;
      return matchBegin;
    }
    function readEnvName(code) {
      if (code === 125) {
        // '}'
        if (!MATH_ENVS.has(envName)) return nok(code);
        effects.consume(code);
        targetEnd = `\\end{${envName}}`;
        targetBegin = `\\begin{${envName}}`;
        return scanBody;
      }
      if (code === null || markdownLineEnding(code) || envName.length > 24) return nok(code);
      if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 42) {
        envName += String.fromCharCode(code);
        effects.consume(code);
        return readEnvName;
      }
      return nok(code);
    }
    function scanBody(code) {
      if (code === null) return nok(code);
      if (markdownLineEnding(code)) {
        closeBuf = '';
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return scanBody;
      }
      const ch = String.fromCharCode(code);
      effects.consume(code);
      closeBuf += ch;
      if (closeBuf.length > Math.max(targetEnd.length, targetBegin.length) + 4) {
        closeBuf = closeBuf.slice(-Math.max(targetEnd.length, targetBegin.length) - 4);
      }
      if (closeBuf.endsWith(targetBegin)) {
        depth++;
        closeBuf = '';
      } else if (closeBuf.endsWith(targetEnd)) {
        depth--;
        closeBuf = '';
        if (depth === 0) return trailing;
      }
      return scanBody;
    }
    function trailing(code) {
      if (markdownSpace(code)) {
        effects.consume(code);
        return trailing;
      }
      if (code === null || markdownLineEnding(code)) {
        effects.exit('latexEnvFlow');
        return ok(code);
      }
      return nok(code);
    }
  },
};

/** Flow construct: standalone `\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareMathOperator`. */
const latexPreambleFlow = {
  name: 'latexPreambleFlow',
  concrete: true,
  tokenize(effects, ok, nok) {
    let matched = [];
    let pos = 0;
    let braceDepth = 0;
    let sawFinalGroup = false;
    let escaped = false;
    let isOperator = false;
    let groupCount = 0;

    return start;

    function start(code) {
      if (code !== 92) return nok(code);
      effects.enter('latexPreambleFlow');
      effects.consume(code);
      matched = PREAMBLE_PREFIXES.slice();
      pos = 1;
      return matchCmd;
    }
    function matchCmd(code) {
      if (code === null || markdownLineEnding(code)) return nok(code);
      const next = matched.filter((p) => pos < p.length && p[pos] === code);
      if (next.length > 0) {
        matched = next;
        effects.consume(code);
        pos++;
        const exact = matched.find((p) => p.length === pos);
        if (exact) {
          isOperator = exact.length === '\\DeclareMathOperator'.length;
          return afterCmd;
        }
        return matchCmd;
      }
      return nok(code);
    }
    function afterCmd(code) {
      // Must be followed by '*', '{', '\', or space (not another letter)
      if (code === null || markdownLineEnding(code)) return nok(code);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return nok(code);
      return scanDirective(code);
    }
    function scanDirective(code) {
      if (code === null) {
        if (sawFinalGroup && braceDepth === 0) {
          effects.exit('latexPreambleFlow');
          return ok(code);
        }
        return nok(code);
      }
      if (markdownLineEnding(code)) {
        if (sawFinalGroup && braceDepth === 0) {
          effects.exit('latexPreambleFlow');
          return ok(code);
        }
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        escaped = false;
        return scanDirective;
      }
      if (sawFinalGroup && braceDepth === 0) {
        if (markdownSpace(code)) {
          effects.consume(code);
          return scanDirective;
        }
        if (code === 37) {
          // Trailing `% comment`
          effects.consume(code);
          return skipComment;
        }
        // Only consume if this is a standalone preamble line
        return nok(code);
      }
      if (escaped) {
        escaped = false;
        effects.consume(code);
        return scanDirective;
      }
      if (code === 92) {
        escaped = true;
        effects.consume(code);
        // If bare command name `\foo` before first `{`, count it as the name slot
        if (braceDepth === 0 && groupCount === 0) groupCount = 1;
        return scanDirective;
      }
      if (code === 123) {
        // '{'
        braceDepth++;
        effects.consume(code);
        return scanDirective;
      }
      if (code === 125) {
        // '}'
        if (braceDepth <= 0) return nok(code);
        braceDepth--;
        effects.consume(code);
        if (braceDepth === 0) {
          groupCount++;
          // Need name + body (2 groups, or bare \name + body = groupCount >= 2)
          if (groupCount >= 2) sawFinalGroup = true;
          else if (isOperator && groupCount >= 2) sawFinalGroup = true;
        }
        return scanDirective;
      }
      effects.consume(code);
      return scanDirective;
    }
    function skipComment(code) {
      if (code === null || markdownLineEnding(code)) {
        effects.exit('latexPreambleFlow');
        return ok(code);
      }
      effects.consume(code);
      return skipComment;
    }
  },
};

/** Text construct: `\(...\)` inline math. */
const latexInlineParen = {
  name: 'latexInlineParen',
  tokenize(effects, ok, nok) {
    let bsCount = 0;
    let consecutiveEols = 0;
    return start;

    function start(code) {
      if (code !== 92) return nok(code);
      effects.enter('latexInlineParen');
      effects.consume(code);
      return afterSlash;
    }
    function afterSlash(code) {
      if (code !== 40) return nok(code); // '('
      effects.consume(code);
      return body;
    }
    function body(code) {
      if (code === null) return nok(code);
      if (markdownLineEnding(code)) {
        consecutiveEols++;
        if (consecutiveEols > 1) return nok(code); // Don't cross blank lines
        bsCount = 0;
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return body;
      }
      consecutiveEols = 0;
      if (code === 92) {
        bsCount++;
        effects.consume(code);
        return body;
      }
      if (code === 41 && bsCount % 2 === 1) {
        // Closing `\)`
        effects.consume(code);
        effects.exit('latexInlineParen');
        return ok;
      }
      bsCount = 0;
      effects.consume(code);
      return body;
    }
  },
};

/** Text construct: inline `\[...\]` display math inside a paragraph. */
const latexInlineBracket = {
  name: 'latexInlineBracket',
  tokenize(effects, ok, nok) {
    let bsCount = 0;
    let consecutiveEols = 0;
    return start;

    function start(code) {
      if (code !== 92) return nok(code);
      effects.enter('latexInlineBracket');
      effects.consume(code);
      return afterSlash;
    }
    function afterSlash(code) {
      if (code !== 91) return nok(code); // '['
      effects.consume(code);
      return body;
    }
    function body(code) {
      if (code === null) return nok(code);
      if (markdownLineEnding(code)) {
        consecutiveEols++;
        if (consecutiveEols > 1) return nok(code);
        bsCount = 0;
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return body;
      }
      consecutiveEols = 0;
      if (code === 92) {
        bsCount++;
        effects.consume(code);
        return body;
      }
      if (code === 93 && bsCount % 2 === 1) {
        // Closing `\]`
        effects.consume(code);
        effects.exit('latexInlineBracket');
        return ok;
      }
      bsCount = 0;
      effects.consume(code);
      return body;
    }
  },
};

function makeDisplayMathNode(tex, extraData = {}) {
  const code = {
    type: 'element',
    tagName: 'code',
    properties: { className: ['language-math', 'math-display'] },
    children: [{ type: 'text', value: tex }],
  };
  return {
    type: 'math',
    meta: null,
    value: tex,
    data: {
      hName: 'pre',
      hChildren: [code],
      ...extraData,
    },
  };
}

function makeInlineMathNode(tex, isDisplay = false) {
  return {
    type: 'inlineMath',
    value: tex,
    data: {
      hName: 'code',
      hProperties: { className: ['language-math', isDisplay ? 'math-display' : 'math-inline'] },
      hChildren: [{ type: 'text', value: tex }],
      ...(isDisplay ? { isDisplayBracket: true } : {}),
    },
  };
}

function latexMicromarkExtension() {
  return {
    flow: {
      92: [latexBracketFlow, latexEnvFlow, latexPreambleFlow],
    },
    text: {
      92: [latexInlineParen, latexInlineBracket],
    },
  };
}

function latexFromMarkdownExtension() {
  return {
    enter: {
      latexBracketFlow(token) {
        this.enter(makeDisplayMathNode('', { latexSource: 'bracket' }), token);
      },
      latexEnvFlow(token) {
        this.enter(makeDisplayMathNode('', { latexSource: 'env' }), token);
      },
      latexPreambleFlow(token) {
        this.enter({ type: 'latexPreamble', value: '' }, token);
      },
      latexInlineParen(token) {
        this.enter(makeInlineMathNode('', false), token);
      },
      latexInlineBracket(token) {
        this.enter(makeInlineMathNode('', true), token);
      },
    },
    exit: {
      latexBracketFlow(token) {
        const raw = this.sliceSerialize(token).trim();
        const inner = raw.slice(2, raw.length - 2).trim();
        const node = this.stack[this.stack.length - 1];
        node.value = inner;
        node.data.hChildren[0].children[0].value = inner;
        this.exit(token);
      },
      latexEnvFlow(token) {
        const raw = this.sliceSerialize(token).trim();
        const node = this.stack[this.stack.length - 1];
        node.value = raw;
        node.data.hChildren[0].children[0].value = raw;
        this.exit(token);
      },
      latexPreambleFlow(token) {
        const raw = this.sliceSerialize(token).trim();
        const node = this.stack[this.stack.length - 1];
        node.value = raw;
        this.exit(token);
      },
      latexInlineParen(token) {
        const raw = this.sliceSerialize(token);
        const inner = raw.slice(2, raw.length - 2).trim();
        const node = this.stack[this.stack.length - 1];
        node.value = inner;
        node.data.hChildren[0].value = inner;
        this.exit(token);
      },
      latexInlineBracket(token) {
        const raw = this.sliceSerialize(token);
        const inner = raw.slice(2, raw.length - 2).trim();
        const node = this.stack[this.stack.length - 1];
        node.value = inner;
        node.data.hChildren[0].value = inner;
        this.exit(token);
      },
    },
  };
}

// -------------------------------------------------- Equation Processing Utils

/** Split an `align`/`gather` body on top-level `\\` (ignoring `\\` inside nested `\begin{...}...\end{...}`). */
function splitAlignRows(body) {
  const rows = [];
  let start = 0;
  let depth = 0;
  const n = body.length;

  for (let i = 0; i < n; i++) {
    if (body[i] !== '\\') continue;
    if (body.startsWith('\\begin{', i)) {
      depth++;
      i += 6;
      continue;
    }
    if (body.startsWith('\\end{', i)) {
      depth = Math.max(0, depth - 1);
      i += 4;
      continue;
    }
    if (depth === 0 && body[i + 1] === '\\') {
      // Optional line spacing argument `\\[6pt]` or `\\*`
      let end = i + 2;
      if (body[end] === '*') end++;
      if (body[end] === '[') {
        const close = body.indexOf(']', end + 1);
        if (close >= 0) end = close + 1;
      }
      rows.push({
        text: body.slice(start, i),
        sep: body.slice(i, end),
      });
      start = end;
      i = end - 1;
    }
  }
  rows.push({ text: body.slice(start), sep: '' });
  return rows;
}

/** Extract & strip `\label{...}`, `\tag{...}`, `\tag*{...}`, `\nonumber`, `\notag` from a TeX snippet. */
function extractRowMeta(tex) {
  const labels = [];
  let tag = null;
  let tagStarred = false;
  let suppressed = false;

  let clean = tex.replace(/\\label\{([^{}]+)\}/g, (_, l) => {
    const trimmed = l.trim();
    if (trimmed) labels.push(trimmed);
    return '';
  });

  clean = clean.replace(/\\tag(\*?)\{([^{}]+)\}/g, (_, star, val) => {
    tag = val.trim();
    tagStarred = star === '*';
    return '';
  });

  clean = clean.replace(/\\(?:nonumber|notag)\b/g, () => {
    suppressed = true;
    return '';
  });

  return { clean, labels, tag, tagStarred, suppressed };
}

/** Process a display `math` node: number it, register labels, and sanitize TeX for KaTeX. */
function processDisplayMathNode(node, state) {
  const rawTex = String(node.value ?? '').trim();
  if (!rawTex) return;

  // Detect outer `\begin{<env>}` ... `\end{<env>}`
  const envMatch = /^\\begin\{([a-zA-Z]+\*?)\}(?:\{([^{}]*)\})?([\s\S]*)\\end\{([a-zA-Z]+\*?)\}$/.exec(rawTex);
  const outerEnv = envMatch && envMatch[1] === envMatch[4] && MATH_ENVS.has(envMatch[1]) ? envMatch[1] : null;
  const envArg = envMatch?.[2] ?? null; // e.g. `{2}` for `alignat{2}`
  const envBody = envMatch?.[3] ?? rawTex;

  let katexTex = rawTex;
  let eqNum = null;
  let eqTagDisplay = null;
  let primaryLabel = null;
  let primaryId = null;
  let isMultiNumbered = false;
  /** @type {string[]} */
  const extraIds = [];

  if (outerEnv && ROW_ENVS.has(outerEnv)) {
    const isStarred = outerEnv.endsWith('*');
    const baseEnv = isStarred ? outerEnv.slice(0, -1) : outerEnv;
    // Map KaTeX-unsupported `flalign` → `align*`; keep `align*`, `gather*`, `alignat*`
    const katexEnv = baseEnv === 'flalign' ? 'align*' : `${baseEnv}*`;
    const envHeader = envArg !== null && baseEnv === 'alignat' ? `\\begin{${katexEnv}}{${envArg}}` : `\\begin{${katexEnv}}`;
    const envFooter = `\\end{${katexEnv}}`;

    const rows = splitAlignRows(envBody);
    const parsedRows = rows.map((r) => {
      const meta = extractRowMeta(r.text);
      const hasContent = meta.clean.trim().length > 0;
      let shouldNumber = false;
      if (meta.tag !== null) shouldNumber = true;
      else if (!meta.suppressed && hasContent) {
        shouldNumber = !isStarred || meta.labels.length > 0;
      }
      return { ...meta, sep: r.sep, hasContent, shouldNumber, assignedNum: null, assignedDisplay: null };
    });

    const numberedRows = parsedRows.filter((r) => r.shouldNumber);

    for (const r of numberedRows) {
      if (r.tag !== null) {
        r.assignedNum = r.tag;
        r.assignedDisplay = r.tagStarred ? r.tag : `(${r.tag})`;
      } else {
        state.eqCounter += 1;
        r.assignedNum = String(state.eqCounter);
        r.assignedDisplay = `(${state.eqCounter})`;
      }
      for (const lbl of r.labels) {
        const anchorId = safeAnchorId('eq', lbl);
        state.labelMap.set(lbl, {
          id: anchorId,
          kind: 'eq',
          num: r.assignedNum,
          display: r.assignedDisplay,
          label: lbl,
        });
        if (!primaryLabel) {
          primaryLabel = lbl;
          primaryId = anchorId;
        } else {
          extraIds.push(anchorId);
        }
      }
    }

    if (numberedRows.length === 0) {
      katexTex = `${envHeader}${parsedRows.map((r) => `${r.clean}${r.sep}`).join('')}${envFooter}`;
    } else if (numberedRows.length === 1) {
      const only = numberedRows[0];
      eqNum = only.assignedNum;
      eqTagDisplay = only.assignedDisplay;
      if (!primaryId) primaryId = `eq-${eqNum.replace(/[^a-zA-Z0-9-]/g, '-')}`;
      katexTex = `${envHeader}${parsedRows.map((r) => `${r.clean}${r.sep}`).join('')}${envFooter}`;
    } else {
      // Multiple numbered rows: let KaTeX align each row's \tag{...} directly
      isMultiNumbered = true;
      const firstNum = numberedRows[0].assignedNum;
      const lastNum = numberedRows[numberedRows.length - 1].assignedNum;
      eqNum = `${firstNum}-${lastNum}`;
      if (!primaryId) primaryId = `eq-${firstNum.replace(/[^a-zA-Z0-9-]/g, '-')}`;
      const bodyWithTags = parsedRows
        .map((r) => {
          if (!r.shouldNumber) return `${r.clean}${r.sep}`;
          const tagCmd = r.tagStarred ? `\\tag*{${r.assignedNum}}` : `\\tag{${r.assignedNum}}`;
          return `${r.clean} ${tagCmd}${r.sep}`;
        })
        .join('');
      katexTex = `${envHeader}${bodyWithTags}${envFooter}`;
    }
  } else {
    // Single-equation block: `equation`, `equation*`, `multline`, `multline*`, `$$...$$`, or `\[...\]`
    let inner = envBody;
    let isDefaultNumbered = false;
    if (outerEnv === 'equation' || outerEnv === 'equation*') {
      isDefaultNumbered = outerEnv === 'equation';
      inner = envBody.trim();
    } else if (outerEnv === 'multline' || outerEnv === 'multline*') {
      isDefaultNumbered = outerEnv === 'multline';
      inner = `\\begin{gathered}${envBody}\\end{gathered}`;
    }

    const meta = extractRowMeta(inner);
    katexTex = meta.clean.trim();

    let shouldNumber = false;
    if (meta.tag !== null) shouldNumber = true;
    else if (!meta.suppressed && (isDefaultNumbered || meta.labels.length > 0)) {
      shouldNumber = true;
    }

    if (shouldNumber) {
      if (meta.tag !== null) {
        eqNum = meta.tag;
        eqTagDisplay = meta.tagStarred ? meta.tag : `(${meta.tag})`;
      } else {
        state.eqCounter += 1;
        eqNum = String(state.eqCounter);
        eqTagDisplay = `(${state.eqCounter})`;
      }
      for (const lbl of meta.labels) {
        const anchorId = safeAnchorId('eq', lbl);
        state.labelMap.set(lbl, {
          id: anchorId,
          kind: 'eq',
          num: eqNum,
          display: eqTagDisplay,
          label: lbl,
        });
        if (!primaryLabel) {
          primaryLabel = lbl;
          primaryId = anchorId;
        } else {
          extraIds.push(anchorId);
        }
      }
      if (!primaryId) primaryId = `eq-${eqNum.replace(/[^a-zA-Z0-9-]/g, '-')}`;
    }
  }

  // Update node text + hast properties for rehype-latex
  node.value = katexTex;
  if (!node.data) node.data = {};
  if (!Array.isArray(node.data.hChildren) || !node.data.hChildren[0]) {
    node.data.hName = 'pre';
    node.data.hChildren = [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-math', 'math-display'] },
        children: [{ type: 'text', value: katexTex }],
      },
    ];
  } else {
    node.data.hChildren[0].children = [{ type: 'text', value: katexTex }];
  }

  const mathProps = {
    'data-raw-tex': rawTex,
    ...(primaryId ? { id: primaryId } : {}),
    ...(eqNum ? { 'data-eq-num': eqNum } : {}),
    ...(eqTagDisplay ? { 'data-eq-display': eqTagDisplay } : {}),
    ...(primaryLabel ? { 'data-eq-label': primaryLabel } : {}),
    ...(isMultiNumbered ? { 'data-eq-multi': 'true' } : {}),
    ...(extraIds.length ? { 'data-eq-extra-ids': extraIds.join(',') } : {}),
  };

  node.data.hProperties = { ...(node.data.hProperties || {}), ...mathProps };
  const codeEl = node.data.hChildren[0];
  if (codeEl && codeEl.properties) {
    codeEl.properties = { ...codeEl.properties, ...mathProps };
  }
}

// ----------------------------------------- Theorem & Algorithm Environments

const LATEX_ENV_OPEN_RE = /^\\begin\{([a-zA-Z]+)\}(?:\s*\[([^\]]*)\])?(?:\s*\\label\{([^{}]+)\})?\s*(?:\r?\n|$)/;
const FENCE_ENV_OPEN_RE = /^:::([a-zA-Z]+)(?:\[([^\]]*)\])?(?:\s*\{#([^{}\s]+)\})?(?:[ \t]+([^\r\n{#]+?))?(?:\s*\{#([^{}\s]+)\})?\s*(?:\r?\n|$)/;

/** Check if a paragraph node starts with a theorem/proof/algorithm opening directive. */
function matchEnvOpen(node) {
  if (!node || node.type !== 'paragraph' || !node.children?.length) return null;
  const first = node.children[0];
  if (!first || first.type !== 'text') return null;

  let m = LATEX_ENV_OPEN_RE.exec(first.value);
  if (m) {
    const kind = m[1].toLowerCase();
    if (!ALL_PROSE_ENVS.has(kind)) return null;
    return {
      syntax: 'latex',
      kind,
      title: (m[2] ?? '').trim(),
      label: (m[3] ?? '').trim(),
      matchLen: m[0].length,
    };
  }

  m = FENCE_ENV_OPEN_RE.exec(first.value);
  if (m) {
    const kind = m[1].toLowerCase();
    if (!ALL_PROSE_ENVS.has(kind)) return null;
    return {
      syntax: 'fence',
      kind,
      title: (m[2] ?? m[4] ?? '').trim(),
      label: (m[3] ?? m[5] ?? '').trim(),
      matchLen: m[0].length,
    };
  }

  return null;
}

/** Check if a paragraph (or a list whose last listItem ends with a paragraph) ends with the matching close marker. */
function matchEnvCloseAtEnd(node, syntax, kind) {
  if (!node || !node.children?.length) return null;
  const closeRe =
    syntax === 'latex'
      ? new RegExp(`(?:^|\\r?\\n)[ \\t]*\\\\end\\{${kind}\\}[ \\t]*$`, 'i')
      : /(?:^|\r?\n)[ \t]*:::[ \t]*$/;

  if (node.type === 'paragraph') {
    const last = node.children[node.children.length - 1];
    if (!last || last.type !== 'text') return null;
    const m = closeRe.exec(last.value);
    if (!m) return null;
    return { matchIndex: m.index, matchLen: m[0].length, inList: false };
  }

  // CommonMark lazy continuation puts `\end{env}` on the last line of a preceding bullet list's final item!
  if (node.type === 'list') {
    const lastItem = node.children[node.children.length - 1];
    const lastChild = lastItem?.children?.[lastItem.children.length - 1];
    if (lastChild?.type === 'paragraph' && lastChild.children?.length) {
      const last = lastChild.children[lastChild.children.length - 1];
      if (last?.type === 'text') {
        const m = closeRe.exec(last.value);
        if (m) return { matchIndex: m.index, matchLen: m[0].length, inList: true };
      }
    }
  }

  return null;
}

/** Parse a single pseudocode line inside an Algorithm block into mdast inline nodes (with math + keywords). */
function parseAlgorithmLineChildren(lineText) {
  const nodes = [];
  // Tokenize inline math ($...$, \(...\)), inline code (`...`), bold (**...**), italic (*...*)
  const TOKEN_RE = /(\\\((?:\\.|[^\\])*?\\\)|\$(?:\\.|[^$\n])+?\$|`[^`\n]+`|\*\*[^*\n]+?\*\*|\*[^*\n]+?\*)/g;
  let last = 0;

  const pushPlainWithKeywords = (segment) => {
    if (!segment) return;
    // Highlight leading labels like "Input:", "Output:", "Require:", "Ensure:" and control keywords
    const KW_RE = /\b(Input:|Output:|Require:|Ensure:|for|while|if|else if|elif|else|then|do|return|repeat|until|end|to|in|and|or|not)\b|(Input:|Output:|Require:|Ensure:)/g;
    let kLast = 0;
    for (const km of segment.matchAll(KW_RE)) {
      if (km.index > kLast) nodes.push({ type: 'text', value: segment.slice(kLast, km.index) });
      nodes.push({
        type: 'strong',
        data: { hName: 'span', hProperties: { className: ['algorithm-kw'] } },
        children: [{ type: 'text', value: km[0] }],
      });
      kLast = km.index + km[0].length;
    }
    if (kLast < segment.length) nodes.push({ type: 'text', value: segment.slice(kLast) });
  };

  for (const m of lineText.matchAll(TOKEN_RE)) {
    if (m.index > last) pushPlainWithKeywords(lineText.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('\\(') && tok.endsWith('\\)')) {
      nodes.push(makeInlineMathNode(tok.slice(2, -2).trim(), false));
    } else if (tok.startsWith('$') && tok.endsWith('$')) {
      nodes.push(makeInlineMathNode(tok.slice(1, -1).trim(), false));
    } else if (tok.startsWith('`') && tok.endsWith('`')) {
      nodes.push({ type: 'inlineCode', value: tok.slice(1, -1) });
    } else if (tok.startsWith('**') && tok.endsWith('**')) {
      nodes.push({ type: 'strong', children: [{ type: 'text', value: tok.slice(2, -2) }] });
    } else if (tok.startsWith('*') && tok.endsWith('*')) {
      nodes.push({ type: 'emphasis', children: [{ type: 'text', value: tok.slice(1, -1) }] });
    }
    last = m.index + tok.length;
  }
  if (last < lineText.length) pushPlainWithKeywords(lineText.slice(last));
  return nodes.length ? nodes : [{ type: 'text', value: '\u00A0' }];
}

/** Extract raw algorithm lines (preserving indentation) from source offsets or fallback AST text. */
function extractAlgorithmLines(bodyNodes, openNode, closeNode, rawSource, syntax, kind) {
  let rawBlock = null;
  if (
    typeof rawSource === 'string' &&
    openNode.position?.start?.offset !== undefined &&
    closeNode.position?.end?.offset !== undefined
  ) {
    let slice = rawSource.slice(openNode.position.start.offset, closeNode.position.end.offset);
    // Strip opening line
    const nl = slice.indexOf('\n');
    slice = nl >= 0 ? slice.slice(nl + 1) : '';
    // Strip closing marker line
    const closeRe =
      syntax === 'latex'
        ? new RegExp(`(?:^|\\r?\\n)[ \\t]*\\\\end\\{${kind}\\}[ \\t]*$`, 'i')
        : /(?:^|\r?\n)[ \t]*:::[ \t]*$/;
    slice = slice.replace(closeRe, '');
    rawBlock = slice;
  }

  if (rawBlock === null) {
    // Fallback: flatten body nodes to plain text
    const collect = (n) => {
      if (n.type === 'inlineMath') return `$${n.value}$`;
      if (n.type === 'text' || n.type === 'inlineCode') return n.value;
      if (n.children) return n.children.map(collect).join('');
      return '';
    };
    rawBlock = bodyNodes.map(collect).join('\n');
  }

  let extractedLabel = '';
  const lines = rawBlock
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => {
      const lm = /^\s*\\label\{([^{}]+)\}\s*$/.exec(line);
      if (lm) {
        if (!extractedLabel) extractedLabel = lm[1].trim();
        return false;
      }
      return true;
    });

  // Trim leading/trailing completely blank lines
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  return { lines, extractedLabel };
}

/** Build a `<figure class="algorithm-block">` mdast container node. */
function buildAlgorithmNode({ num, title, label, id, lines, position }) {
  const headChildren = [
    {
      type: 'latexSpan',
      data: { hName: 'span', hProperties: { className: ['algorithm-num'] } },
      children: [{ type: 'text', value: `Algorithm ${num}` }],
    },
  ];
  if (title) {
    headChildren.push({ type: 'text', value: ' ' });
    headChildren.push({
      type: 'latexSpan',
      data: { hName: 'span', hProperties: { className: ['algorithm-title'] } },
      children: [{ type: 'text', value: title }],
    });
  }

  const lineNodes = lines.map((rawLine, idx) => {
    const leadingSpaces = (rawLine.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '  ').length;
    const indent = Math.min(8, Math.floor(leadingSpaces / 2));
    const trimmed = rawLine.trim();
    return {
      type: 'algorithmLine',
      data: {
        hName: 'li',
        hProperties: {
          className: ['algorithm-line'],
          'data-indent': String(indent),
          ...(indent > 0 ? { style: `--alg-indent:${indent}` } : {}),
        },
      },
      children: [
        {
          type: 'latexSpan',
          data: { hName: 'span', hProperties: { className: ['algorithm-lineno'], ariaHidden: 'true' } },
          children: [{ type: 'text', value: String(idx + 1) }],
        },
        {
          type: 'latexSpan',
          data: { hName: 'span', hProperties: { className: ['algorithm-code'] } },
          children: parseAlgorithmLineChildren(trimmed),
        },
      ],
    };
  });

  return {
    type: 'algorithmBlock',
    position,
    data: {
      hName: 'figure',
      hProperties: {
        className: ['algorithm-block'],
        id,
        'data-env-kind': 'algorithm',
        'data-env-num': String(num),
        ...(label ? { 'data-env-label': label } : {}),
      },
    },
    children: [
      {
        type: 'algorithmHead',
        data: { hName: 'figcaption', hProperties: { className: ['algorithm-head'] } },
        children: headChildren,
      },
      {
        type: 'algorithmBody',
        data: { hName: 'div', hProperties: { className: ['algorithm-body'] } },
        children: [
          {
            type: 'algorithmLines',
            data: { hName: 'ol', hProperties: { className: ['algorithm-lines'] } },
            children: lineNodes,
          },
        ],
      },
    ],
  };
}

/** Build a `<div class="math-env math-env--<kind>">` mdast container node. */
function buildTheoremNode({ kind, displayKind, num, title, label, id, bodyNodes, position }) {
  const isProof = kind === 'proof';
  const isTakeaway = kind === 'takeaway';
  const headChildren = [];

  if (isProof) {
    headChildren.push({
      type: 'latexSpan',
      data: { hName: 'span', hProperties: { className: ['math-env-kind'] } },
      children: [{ type: 'text', value: title ? title : 'Proof.' }],
    });
  } else if (isTakeaway) {
    headChildren.push({
      type: 'latexSpan',
      data: { hName: 'span', hProperties: { className: ['math-env-kind'] } },
      children: [{ type: 'text', value: title ? `Takeaway — ${title}` : 'Takeaway' }],
    });
  } else {
    headChildren.push({
      type: 'latexSpan',
      data: { hName: 'span', hProperties: { className: ['math-env-kind'] } },
      children: [{ type: 'text', value: `${displayKind} ${num}` }],
    });
    if (title) {
      headChildren.push({ type: 'text', value: ' ' });
      headChildren.push({
        type: 'latexSpan',
        data: { hName: 'span', hProperties: { className: ['math-env-title'] } },
        children: [{ type: 'text', value: `(${title})` }],
      });
    }
  }

  // Append QED tombstone to Proof
  if (isProof) {
    const qedNode = {
      type: 'latexSpan',
      data: { hName: 'span', hProperties: { className: ['math-qed'], ariaLabel: 'QED' } },
      children: [{ type: 'text', value: '∎' }],
    };
    const last = bodyNodes[bodyNodes.length - 1];
    if (last && last.type === 'paragraph' && Array.isArray(last.children)) {
      last.children.push({ type: 'text', value: ' ' }, qedNode);
    } else {
      bodyNodes.push({ type: 'paragraph', children: [qedNode] });
    }
  }

  return {
    type: 'mathEnv',
    position,
    data: {
      hName: 'div',
      hProperties: {
        className: ['math-env', `math-env--${kind}`],
        ...(id ? { id } : {}),
        'data-env-kind': kind,
        ...(num ? { 'data-env-num': String(num) } : {}),
        ...(label ? { 'data-env-label': label } : {}),
      },
    },
    children: [
      {
        type: 'mathEnvHead',
        data: { hName: 'div', hProperties: { className: ['math-env-head'] } },
        children: headChildren,
      },
      {
        type: 'mathEnvBody',
        data: { hName: 'div', hProperties: { className: ['math-env-body'] } },
        children: bodyNodes,
      },
    ],
  };
}

/** Extract & strip a leading `\label{...}` from the first paragraph of a theorem body. */
function extractLeadingLabel(bodyNodes) {
  if (!bodyNodes.length) return '';
  const first = bodyNodes[0];
  if (first.type !== 'paragraph' || !first.children?.length) return '';
  const t = first.children[0];
  if (t?.type !== 'text') return '';
  const m = /^\s*\\label\{([^{}]+)\}[ \t]*(?:\r?\n)?/.exec(t.value);
  if (!m) return '';
  t.value = t.value.slice(m[0].length);
  if (!t.value) first.children.shift();
  if (!first.children.length) bodyNodes.shift();
  return m[1].trim();
}

/** Trim empty leading/trailing text nodes on a paragraph; return true if paragraph still has content. */
function cleanParagraph(p) {
  while (p.children.length && p.children[0].type === 'text' && !p.children[0].value.trim()) {
    p.children.shift();
  }
  while (p.children.length && p.children[p.children.length - 1].type === 'text' && !p.children[p.children.length - 1].value.trim()) {
    p.children.pop();
  }
  return p.children.length > 0;
}

/** Transform theorem-like and algorithm environments inside any container's children array. */
function transformEnvironments(container, state, rawSource) {
  if (!Array.isArray(container.children)) return;
  const children = container.children;

  for (let i = 0; i < children.length; i++) {
    const open = matchEnvOpen(children[i]);
    if (!open) {
      // Recurse into child containers (blockquotes, listItems, etc.)
      if (children[i]?.children) transformEnvironments(children[i], state, rawSource);
      continue;
    }

    // Find matching closing marker at index j >= i
    let closeIdx = -1;
    let closeMatch = null;
    for (let j = i; j < children.length; j++) {
      const cm = matchEnvCloseAtEnd(children[j], open.syntax, open.kind);
      if (cm) {
        // If j === i, make sure the close marker is AFTER the open marker
        if (j === i && children[i].children.length === 1 && cm.matchIndex < open.matchLen) {
          continue;
        }
        closeIdx = j;
        closeMatch = cm;
        break;
      }
    }
    if (closeIdx < 0) continue;

    const openNode = children[i];
    const closeNode = children[closeIdx];
    const position =
      openNode.position && closeNode.position
        ? { start: openNode.position.start, end: closeNode.position.end }
        : openNode.position;

    // Slice body nodes cleanly
    const bodyNodes = [];
    if (closeIdx === i) {
      // Single paragraph contains both open and close
      const clone = { ...openNode, children: openNode.children.map((c) => ({ ...c })) };
      // Strip close from last text first (so indices stay valid if first === last)
      const lastTxt = clone.children[clone.children.length - 1];
      lastTxt.value = lastTxt.value.slice(0, closeMatch.matchIndex);
      const firstTxt = clone.children[0];
      firstTxt.value = firstTxt.value.slice(open.matchLen);
      if (cleanParagraph(clone)) bodyNodes.push(clone);
    } else {
      const firstClone = { ...openNode, children: openNode.children.map((c) => ({ ...c })) };
      firstClone.children[0].value = firstClone.children[0].value.slice(open.matchLen);
      if (cleanParagraph(firstClone)) bodyNodes.push(firstClone);

      for (let k = i + 1; k < closeIdx; k++) {
        bodyNodes.push(children[k]);
      }

      if (closeMatch.inList) {
        const listClone = { ...closeNode, children: closeNode.children.map((li) => ({ ...li })) };
        const lastLi = listClone.children[listClone.children.length - 1];
        lastLi.children = lastLi.children.map((c) => ({ ...c }));
        const lastP = lastLi.children[lastLi.children.length - 1];
        lastP.children = lastP.children.map((c) => ({ ...c }));
        const lastTxt = lastP.children[lastP.children.length - 1];
        lastTxt.value = lastTxt.value.slice(0, closeMatch.matchIndex);
        if (!cleanParagraph(lastP)) lastLi.children.pop();
        if (!lastLi.children.length) listClone.children.pop();
        if (listClone.children.length) bodyNodes.push(listClone);
      } else {
        const lastClone = { ...closeNode, children: closeNode.children.map((c) => ({ ...c })) };
        const lastTxt = lastClone.children[lastClone.children.length - 1];
        lastTxt.value = lastTxt.value.slice(0, closeMatch.matchIndex);
        if (cleanParagraph(lastClone)) bodyNodes.push(lastClone);
      }
    }

    let label = open.label;
    const isProof = open.kind === 'proof';
    const displayKind = NUMBERED_THEOREM_ENVS.get(open.kind) ?? 'Proof';
    let num = 0;

    if (!isProof) {
      state.envCounters[open.kind] = (state.envCounters[open.kind] || 0) + 1;
      num = state.envCounters[open.kind];
    }

    let replacement;
    if (open.kind === 'algorithm') {
      const { lines, extractedLabel } = extractAlgorithmLines(
        bodyNodes,
        openNode,
        closeNode,
        rawSource,
        open.syntax,
        open.kind,
      );
      if (!label && extractedLabel) label = extractedLabel;
      const id = label ? safeAnchorId('env', label) : `env-algorithm-${num}`;
      if (label) {
        state.labelMap.set(label, {
          id,
          kind: 'algorithm',
          num: String(num),
          display: `Algorithm ${num}`,
          label,
        });
      }
      replacement = buildAlgorithmNode({ num, title: open.title, label, id, lines, position });
    } else {
      if (!label) label = extractLeadingLabel(bodyNodes);
      // Recurse inside theorem/proof body in case of nested environments
      transformEnvironments({ children: bodyNodes }, state, rawSource);
      const id = label ? safeAnchorId('env', label) : isProof ? undefined : `env-${open.kind}-${num}`;
      if (label && !isProof) {
        state.labelMap.set(label, {
          id,
          kind: open.kind,
          num: String(num),
          display: `${displayKind} ${num}`,
          label,
        });
      }
      replacement = buildTheoremNode({
        kind: open.kind,
        displayKind,
        num,
        title: open.title,
        label,
        id,
        bodyNodes,
        position,
      });
    }

    children.splice(i, closeIdx - i + 1, replacement);
  }
}

// ----------------------------------------- Cross-References & BibTeX Citations

const REF_CITE_RE =
  /\\(eqref|ref|cref|Cref)\{([^{}]+)\}|\\(cite|citep|citet)(?:\[([^\]]*)\])?\{([^{}]+)\}|\[@([A-Za-z0-9_.:-]+(?:\s*;\s*@[A-Za-z0-9_.:-]+)*)\]/g;

function formatRefText(cmd, info) {
  if (cmd === 'eqref') return info.kind === 'eq' ? info.display : `(${info.num})`;
  if (cmd === 'ref') return info.num;
  if (cmd === 'Cref') {
    if (info.kind === 'eq') return `Equation ${info.display}`;
    return info.display;
  }
  // \cref
  if (info.kind === 'eq') return `Eq. ${info.display}`;
  return info.display;
}

function makeCiteLinkNode(key, text) {
  const id = safeAnchorId('ref', key);
  return {
    type: 'link',
    url: `#${id}`,
    data: {
      hProperties: {
        className: ['latex-cite'],
        'data-cite-key': key,
      },
    },
    children: [{ type: 'text', value: text }],
  };
}

function makeMissingCiteNode(key) {
  return {
    type: 'latexSpan',
    data: {
      hName: 'span',
      hProperties: {
        className: ['latex-cite', 'latex-cite--missing'],
        'data-cite-key': key,
        title: `Undefined citation: ${key}`,
      },
    },
    children: [{ type: 'text', value: `[? ${key}]` }],
  };
}

function buildCitationNodes(cmd, keys, postnote, state) {
  const { bibMap, citedOrder, citedIndex, citationStyle } = state;
  const resolved = keys.map((key) => {
    const entry = bibMap.get(key);
    if (!entry) return { key, entry: null, index: -1 };
    if (!citedIndex.has(key)) {
      citedIndex.set(key, citedOrder.length);
      citedOrder.push(key);
    }
    return { key, entry, index: citedIndex.get(key) };
  });

  const isTextual = cmd === 'citet';
  const noteSuffix = postnote?.trim() ? `, ${postnote.trim()}` : '';

  // Single citation
  if (resolved.length === 1) {
    const { key, entry, index } = resolved[0];
    if (!entry) return [makeMissingCiteNode(key)];

    if (isTextual) {
      const who = formatAuthorsShort(entry.authors) || entry.author || key;
      const text =
        citationStyle === 'author-year'
          ? `${who} (${entry.year || 'n.d.'}${noteSuffix})`
          : `${who} [${index + 1}${noteSuffix}]`;
      return [makeCiteLinkNode(key, text)];
    }

    let label = formatCitationLabel(entry, index, citationStyle);
    if (noteSuffix) {
      label = `${label.slice(0, -1)}${noteSuffix}${label.slice(-1)}`;
    }
    return [makeCiteLinkNode(key, label)];
  }

  // Multiple citations: individual links for hover previews, wrapped in brackets/parens
  const out = [];
  if (isTextual) {
    resolved.forEach(({ key, entry, index }, idx) => {
      if (idx > 0) out.push({ type: 'text', value: idx === resolved.length - 1 ? ' and ' : ', ' });
      if (!entry) {
        out.push(makeMissingCiteNode(key));
      } else {
        const who = formatAuthorsShort(entry.authors) || entry.author || key;
        const text =
          citationStyle === 'author-year'
            ? `${who} (${entry.year || 'n.d.'})`
            : `${who} [${index + 1}]`;
        out.push(makeCiteLinkNode(key, text));
      }
    });
    return out;
  }

  const open = citationStyle === 'author-year' ? '(' : '[';
  const close = citationStyle === 'author-year' ? ')' : ']';
  const sep = citationStyle === 'author-year' ? '; ' : ', ';

  out.push({ type: 'text', value: open });
  resolved.forEach(({ key, entry, index }, idx) => {
    if (idx > 0) out.push({ type: 'text', value: sep });
    if (!entry) {
      out.push(makeMissingCiteNode(key));
    } else {
      const inner =
        citationStyle === 'author-year'
          ? `${formatAuthorsShort(entry.authors) || entry.author || key}, ${entry.year || 'n.d.'}`
          : String(index + 1);
      out.push(makeCiteLinkNode(key, inner));
    }
  });
  if (noteSuffix) out.push({ type: 'text', value: noteSuffix });
  out.push({ type: 'text', value: close });
  return out;
}

/** Build the `<section class="references">` mdast node appended at end of document. */
function buildReferencesSection(state) {
  const { citedOrder, bibMap, citationStyle } = state;
  if (!citedOrder.length) return null;

  const items = citedOrder.map((key, idx) => {
    const entry = bibMap.get(key);
    const id = safeAnchorId('ref', key);
    const children = [];

    if (citationStyle === 'numeric') {
      children.push({
        type: 'latexSpan',
        data: { hName: 'span', hProperties: { className: ['ref-num'] } },
        children: [{ type: 'text', value: `[${idx + 1}]` }],
      });
      children.push({ type: 'text', value: ' ' });
    }

    const authorsStr = formatAuthorsFull(entry.authors) || entry.author;
    if (authorsStr) {
      children.push({
        type: 'latexSpan',
        data: { hName: 'span', hProperties: { className: ['ref-authors'] } },
        children: [{ type: 'text', value: authorsStr }],
      });
    }

    if (entry.year) {
      children.push({ type: 'text', value: authorsStr ? ' ' : '' });
      children.push({
        type: 'latexSpan',
        data: { hName: 'span', hProperties: { className: ['ref-year'] } },
        children: [{ type: 'text', value: `(${entry.year}).` }],
      });
    } else if (authorsStr) {
      children.push({ type: 'text', value: '.' });
    }

    if (entry.title) {
      children.push({ type: 'text', value: ' ' });
      children.push({
        type: 'latexSpan',
        data: { hName: 'span', hProperties: { className: ['ref-title'] } },
        children: [{ type: 'text', value: entry.title.endsWith('.') ? entry.title : `${entry.title}.` }],
      });
    }

    if (entry.venue) {
      children.push({ type: 'text', value: ' ' });
      const venueParts = [entry.venue];
      if (entry.volume) venueParts.push(entry.volume);
      if (entry.pages) venueParts.push(`pp. ${entry.pages}`);
      children.push({
        type: 'emphasis',
        data: { hName: 'em', hProperties: { className: ['ref-venue'] } },
        children: [{ type: 'text', value: venueParts.join(', ') }],
      });
      children.push({ type: 'text', value: '.' });
    }

    const linkUrl =
      entry.url ||
      (entry.doi ? (entry.doi.startsWith('http') ? entry.doi : `https://doi.org/${entry.doi}`) : '') ||
      (entry.eprint ? `https://arxiv.org/abs/${entry.eprint}` : '');
    const linkLabel = entry.doi ? `doi:${entry.doi}` : entry.eprint ? `arXiv:${entry.eprint}` : entry.url ? 'link' : '';

    if (linkUrl) {
      children.push({ type: 'text', value: ' ' });
      children.push({
        type: 'link',
        url: linkUrl,
        data: {
          hProperties: {
            className: ['ref-link'],
            target: '_blank',
            rel: ['noopener', 'noreferrer'],
          },
        },
        children: [{ type: 'text', value: linkLabel }],
      });
    }

    return {
      type: 'refItem',
      data: {
        hName: 'li',
        hProperties: {
          id,
          'data-cite-key': key,
        },
      },
      children,
    };
  });

  return {
    type: 'referencesSection',
    data: {
      hName: 'section',
      hProperties: {
        className: ['references'],
        id: 'references',
        ariaLabelledby: 'references-heading',
      },
    },
    children: [
      {
        type: 'referencesHeading',
        data: {
          hName: 'h2',
          hProperties: {
            id: 'references-heading',
            className: ['references-title'],
          },
        },
        children: [{ type: 'text', value: 'References' }],
      },
      {
        type: 'referencesList',
        data: {
          hName: 'ol',
          hProperties: { className: ['ref-list'] },
        },
        children: items,
      },
    ],
  };
}

// ------------------------------------------------------------- Main Plugin

export default function remarkLatex(options = {}) {
  const self = this;
  const data = self.data();

  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);

  micromarkExtensions.push(latexMicromarkExtension());
  fromMarkdownExtensions.push(latexFromMarkdownExtension());

  return (tree, file) => {
    const rawSource = typeof file?.value === 'string' ? file.value : String(file?.value ?? '');
    const fm = file?.data?.astro?.frontmatter ?? {};

    // 1. Resolve macros & citationStyle
    const globalCfg = loadGlobalLatexConfig();
    const macros = { ...globalCfg.macros };
    let citationStyle = globalCfg.citationStyle;

    // Optional explicit globalMacros override passed from preview.mjs / caller
    const explicitGlobal = fm.__globalMacros ?? options.globalMacros;
    if (explicitGlobal && typeof explicitGlobal === 'object') {
      for (const key of Object.keys(macros)) delete macros[key];
      for (const [k, v] of Object.entries(explicitGlobal)) {
        if (typeof k === 'string' && k.startsWith('\\') && typeof v === 'string') {
          macros[k] = v;
        }
      }
    }

    // Per-post frontmatter or explicit plugin macros
    const postMacrosSrc = fm.macros ?? options.macros;
    if (typeof postMacrosSrc === 'string' && postMacrosSrc.trim()) {
      Object.assign(macros, parseLatexPreamble(postMacrosSrc).macros);
    } else if (postMacrosSrc && typeof postMacrosSrc === 'object') {
      for (const [k, v] of Object.entries(postMacrosSrc)) {
        if (typeof k === 'string' && k.startsWith('\\') && typeof v === 'string') {
          macros[k] = v;
        }
      }
    }

    const reqStyle = fm.citationStyle || options.citationStyle;
    if (reqStyle === 'numeric' || reqStyle === 'author-year') {
      citationStyle = reqStyle;
    }

    // 2. Collect inline preamble directives & strip them from tree
    visit(tree, 'latexPreamble', (node, index, parent) => {
      if (!parent || index === undefined) return;
      Object.assign(macros, parseLatexPreamble(node.value).macros);
      parent.children.splice(index, 1);
      return [SKIP, index];
    });

    // Fallback: strip standalone preamble paragraphs (e.g. inside containers)
    visit(tree, 'paragraph', (node, index, parent) => {
      if (!parent || index === undefined || node.children.length !== 1 || node.children[0].type !== 'text') return;
      const text = node.children[0].value.trim();
      if (!/^\\(?:newcommand|renewcommand|providecommand|DeclareMathOperator)\b/.test(text)) return;
      const parsed = parseLatexPreamble(text);
      if (parsed.entries.length > 0) {
        Object.assign(macros, parsed.macros);
        parent.children.splice(index, 1);
        return [SKIP, index];
      }
    });

    // 3. Collect BibTeX from frontmatter + ```bibtex code blocks (removing raw fences)
    const bibMap = new Map();
    const addBib = (bibSrc) => {
      if (typeof bibSrc !== 'string' || !bibSrc.trim()) return;
      for (const entry of parseBibTeX(bibSrc)) {
        bibMap.set(entry.key, entry);
      }
    };
    addBib(fm.bibliography ?? options.bibliography);

    visit(tree, 'code', (node, index, parent) => {
      if (!parent || index === undefined) return;
      const lang = String(node.lang ?? '').trim().toLowerCase();
      if (lang !== 'bibtex' && lang !== 'bib') return;
      addBib(node.value);
      parent.children.splice(index, 1);
      return [SKIP, index];
    });

    const state = {
      eqCounter: 0,
      envCounters: Object.create(null),
      labelMap: new Map(),
      bibMap,
      citedOrder: [],
      citedIndex: new Map(),
      citationStyle,
    };

    // 4. Transform theorem-like environments & algorithm blocks
    transformEnvironments(tree, state, rawSource);

    // 5. Promote standalone single-line `$$...$$` or `\[...\]` paragraphs to display `math` nodes
    visit(tree, 'paragraph', (node, index, parent) => {
      if (!parent || index === undefined) return;
      const kids = node.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
      if (kids.length !== 1 || kids[0].type !== 'inlineMath') return;
      const im = kids[0];
      let promote = Boolean(im.data?.isDisplayBracket);
      if (!promote && im.position?.start?.offset !== undefined) {
        const prefix = rawSource.slice(im.position.start.offset, im.position.start.offset + 2);
        if (prefix === '$$' || prefix === '\\[') promote = true;
      }
      if (!promote) return;
      const promoted = makeDisplayMathNode(im.value, { latexSource: 'promoted' });
      promoted.position = node.position ?? im.position;
      parent.children[index] = promoted;
    });

    // 6. Process all display `math` nodes (equation numbering, \label, KaTeX env mapping)
    visit(tree, 'math', (node) => {
      processDisplayMathNode(node, state);
    });

    // 7. Resolve cross-references (\eqref, \ref, \cref, \Cref) & citations (\cite, \citep, \citet, [@key])
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return;
      if (['link', 'code', 'inlineCode', 'math', 'inlineMath'].includes(parent.type)) return;
      if (!REF_CITE_RE.test(node.value)) return;
      REF_CITE_RE.lastIndex = 0;

      const out = [];
      let last = 0;

      for (const m of node.value.matchAll(REF_CITE_RE)) {
        const [whole, refCmd, refKey, citeCmd, citeNote, citeKeysRaw, pandocKeysRaw] = m;
        if (m.index > last) {
          out.push({ type: 'text', value: node.value.slice(last, m.index) });
        }

        if (refCmd) {
          const key = refKey.trim();
          const target = state.labelMap.get(key);
          if (target) {
            out.push({
              type: 'link',
              url: `#${target.id}`,
              data: {
                hProperties: {
                  className: ['latex-ref'],
                  'data-ref-target': target.id,
                  'data-ref-label': key,
                  'data-ref-kind': target.kind,
                },
              },
              children: [{ type: 'text', value: formatRefText(refCmd, target) }],
            });
          } else {
            // Leave metadata so rehype-latex can resolve deferred figure/heading labels after rehypeFigureNumbers
            out.push({
              type: 'latexSpan',
              data: {
                hName: 'span',
                hProperties: {
                  className: ['latex-ref', 'latex-ref--missing'],
                  'data-ref-label': key,
                  'data-ref-cmd': refCmd,
                  title: `Undefined label: ${key}`,
                },
              },
              children: [{ type: 'text', value: `[?? ${key}]` }],
            });
          }
        } else if (citeCmd) {
          const keys = citeKeysRaw.split(',').map((k) => k.trim()).filter(Boolean);
          out.push(...buildCitationNodes(citeCmd, keys, citeNote, state));
        } else if (pandocKeysRaw) {
          const keys = pandocKeysRaw
            .split(';')
            .map((k) => k.trim().replace(/^@/, ''))
            .filter(Boolean);
          out.push(...buildCitationNodes('cite', keys, '', state));
        }

        last = m.index + whole.length;
      }

      if (last < node.value.length) {
        out.push({ type: 'text', value: node.value.slice(last) });
      }
      parent.children.splice(index, 1, ...out);
      return [SKIP, index + out.length];
    });

    // 8. Append References section if any citations were resolved
    const refSection = buildReferencesSection(state);
    if (refSection) {
      tree.children.push(refSection);
    }

    // 9. Expose merged macros & metadata to rehype-latex via vfile.data.latex
    if (file) {
      file.data = file.data || {};
      file.data.latex = {
        macros,
        citationStyle,
        labels: Object.fromEntries(state.labelMap),
        citations: state.citedOrder,
      };
    }
  };
}
