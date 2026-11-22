/**
 * Overleaf+ / arXiv-tier LaTeX Studio core for /write/[slug].
 *
 * Provides:
 *  - Accurate math context detector ($...$, $$...$$, \(...\), \[...\], \begin{env})
 *  - Smart autocomplete (\commands + user macros with live KaTeX glyphs, \begin{env},
 *    \eqref/\ref/\cref document labels, and \cite/[@ BibTeX keys)
 *  - Dynamic Tab-stop snippet engine ($1, $2, ... with Tab / Shift+Tab / Esc)
 *  - Smart auto-closing & math typing ergonomics ({}, $, (), \left(, \begin Enter, align \\ Enter, pair Backspace)
 *  - Zero-latency instant floating KaTeX popover (<5ms local render + friendly error hints)
 *  - Context-aware math selection bubble actions
 *  - Searchable [ Σ math ] drawer with 300+ symbols, recent history, and active macros
 *  - Visual matrix.exe / structure builder dialog (with CSV / TSV / NumPy paste)
 *  - Collapsible [ outline ] navigator (sections, numbered equations w/ KaTeX, theorems, figures + \eqref/\cref insert)
 *  - Collapsible [ bib & macros ] drawer (live BibTeX + preamble macros editor & preview)
 *  - Preview diagnostics badge & clickable error log
 *  - One-click [ export .tex ] arXiv-ready LaTeX + .bib export dialog
 */
import katex from 'katex';
import { friendlyKatexHint, parseBibTeX, parseLatexPreamble } from '../../plugins/latex-core.mjs';
import {
  LATEX_CATALOG,
  LATEX_CATEGORIES,
  LATEX_ENVIRONMENTS,
  searchCatalog,
  type LatexCatalogItem,
  type LatexCategory,
} from './latex-catalog';
import { exportArxivLatex } from './latex-export';

export type LatexDiagnostic = { line: number; message: string; hint: string; tex: string; display: boolean };

export type LatexStudioHost = {
  root: HTMLElement;
  ta: HTMLTextAreaElement;
  wrap: HTMLElement;
  preview: HTMLElement;
  signal: AbortSignal;
  globalMacros: Record<string, string>;
  defaultCitationStyle: 'numeric' | 'author-year';
  replace: (start: number, end: number, text: string, selStart?: number, selEnd?: number) => void;
  insertTemplate: (start: number, end: number, tpl: string) => void;
  blockInsert: (tpl: string, via: 'slash' | 'ribbon' | 'key' | 'bubble') => void;
  caret: (pos: number) => { x: number; y: number; h: number };
  place: (el: HTMLElement, x: number, y: number) => void;
  getMeta: () => {
    title: string;
    subtitle: string;
    description: string;
    date: string;
    author: string;
    slug: string;
    macros: string;
    bibliography: string;
    citationStyle: '' | 'numeric' | 'author-year';
  };
  setPostMacros: (v: string) => void;
  setPostBib: (v: string) => void;
  jumpToLine: (line: number) => void;
  onEdited: () => void;
};

export type LatexStudioAPI = {
  handleKeydown: (e: KeyboardEvent) => boolean;
  handleInput: () => void;
  handleSelection: () => void;
  handleBlur: () => void;
  isInMath: (pos?: number) => boolean;
  getMathBubbleActions: () => Array<{ id: string; icon: string; label: string; run: () => void }>;
  setDiagnostics: (diags: LatexDiagnostic[]) => void;
  togglePalette: (force?: boolean) => void;
  toggleOutline: (force?: boolean) => void;
  toggleBibMacros: (tab?: 'bib' | 'macros', force?: boolean) => void;
  openMatrixBuilder: (via?: 'slash' | 'ribbon' | 'key' | 'bubble') => void;
  openTexExport: () => void;
  closePopups: () => void;
};

type BibEntry = {
  key: string;
  type: string;
  title: string;
  author: string;
  authors: Array<{ first: string; last: string }>;
  year: string;
  venue: string;
  url?: string;
  doi?: string;
};

type PreambleResult = {
  macros: Record<string, string>;
  entries: Array<{ name: string; args: number; body: string; kind: 'command' | 'operator' | 'operator*' }>;
};

type MathContext = {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  tex: string;
  display: boolean;
  delim: '$' | '$$' | '\\(' | '\\[' | 'env';
  envName?: string;
  closed: boolean;
};

const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'aligned', 'gather', 'gather*', 'gathered',
  'multline', 'multline*', 'flalign', 'flalign*', 'alignat', 'alignat*', 'split',
  'subequations', 'cases', 'dcases', 'rcases', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix',
  'vmatrix', 'Vmatrix', 'smallmatrix', 'array', 'eqnarray', 'eqnarray*',
]);

const ROW_BREAK_ENVS = new Set([
  'align', 'align*', 'aligned', 'gather', 'gather*', 'gathered', 'cases', 'dcases', 'rcases',
  'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix', 'array',
  'multline', 'multline*', 'flalign', 'flalign*', 'alignat', 'alignat*', 'split',
]);

const THEOREM_ENVS = new Set([
  'theorem', 'lemma', 'proposition', 'corollary', 'definition',
  'assumption', 'example', 'remark', 'proof', 'algorithm',
]);

const GLOBAL_CMD_TRIGGERS = new Set([
  'begin', 'end', 'cite', 'citep', 'citet', 'eqref', 'ref', 'cref', 'Cref',
  'label', 'newcommand', 'renewcommand', 'providecommand', 'DeclareMathOperator',
]);

const RECENT_KEY = 'write:latex:recent';
const PEEK_SPLIT_KEY = 'write:latex:peek-split';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const safeStore = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

function countMacroArgs(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/#([1-9])/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

function lineStartOf(src: string, pos: number): number {
  return src.lastIndexOf('\n', pos - 1) + 1;
}

function lineEndOf(src: string, pos: number): number {
  const i = src.indexOf('\n', pos);
  return i < 0 ? src.length : i;
}

/** Skip fenced code blocks & inline code and find the active math span containing `pos`. */
function findMathContext(src: string, pos: number): MathContext | null {
  const len = src.length;
  let i = 0;

  while (i < len && i <= pos) {
    // Line-start fenced code blocks (``` or ~~~)
    if (i === 0 || src[i - 1] === '\n') {
      const fm = src.slice(i, i + 40).match(/^[ \t]*(`{3,}|~{3,})/);
      if (fm) {
        const fChar = fm[1][0];
        const fLen = fm[1].length;
        const nl = src.indexOf('\n', i);
        if (nl < 0) return null;
        const closer = new RegExp(`^[ \\t]*${fChar}{${fLen},}[ \\t]*$`, 'gm');
        closer.lastIndex = nl + 1;
        const cm = closer.exec(src);
        const end = cm ? closer.lastIndex : len;
        if (pos >= i && pos <= end) return null;
        i = end;
        continue;
      }
    }

    const ch = src[i];

    // Escaped char
    if (ch === '\\') {
      const next = src[i + 1];
      // \( ... \)
      if (next === '(') {
        const contentStart = i + 2;
        let close = -1;
        for (let j = contentStart; j < len - 1; j++) {
          if (src[j] === '\n' && src[j + 1] === '\n') break;
          if (src[j] === '\\' && src[j + 1] === ')') {
            close = j;
            break;
          }
          if (src[j] === '\\') j++;
        }
        const closed = close >= 0;
        const contentEnd = closed ? close : Math.min(len, src.indexOf('\n\n', contentStart) >= 0 ? src.indexOf('\n\n', contentStart) : len);
        const end = closed ? close + 2 : contentEnd;
        if (pos >= contentStart && pos <= contentEnd) {
          const tex = src.slice(contentStart, contentEnd);
          return { start: i, end, contentStart, contentEnd, tex, display: false, delim: '\\(', envName: innerEnvAt(src, contentStart, pos), closed };
        }
        i = end;
        continue;
      }
      // \[ ... \]
      if (next === '[') {
        const contentStart = i + 2;
        let close = -1;
        for (let j = contentStart; j < len - 1; j++) {
          if (src[j] === '\\' && src[j + 1] === ']') {
            close = j;
            break;
          }
          if (src[j] === '\\') j++;
        }
        const closed = close >= 0;
        const contentEnd = closed ? close : len;
        const end = closed ? close + 2 : len;
        if (pos >= contentStart && pos <= contentEnd) {
          const tex = src.slice(contentStart, contentEnd);
          return { start: i, end, contentStart, contentEnd, tex, display: true, delim: '\\[', envName: innerEnvAt(src, contentStart, pos), closed };
        }
        i = end;
        continue;
      }
      // Bare \begin{env}...\end{env}
      if (src.startsWith('\\begin{', i)) {
        const bm = src.slice(i, i + 64).match(/^\\begin\{([a-zA-Z*]+)\}/);
        if (bm && MATH_ENVS.has(bm[1])) {
          const env = bm[1];
          const escaped = env.replace(/\*/g, '\\*');
          const re = new RegExp(`\\\\(begin|end)\\{${escaped}\\}`, 'g');
          re.lastIndex = i + bm[0].length;
          let depth = 1;
          let m: RegExpExecArray | null;
          let end = len;
          let closed = false;
          while ((m = re.exec(src))) {
            depth += m[1] === 'begin' ? 1 : -1;
            if (depth === 0) {
              end = re.lastIndex;
              closed = true;
              break;
            }
          }
          if (pos >= i + bm[0].length && pos <= (closed ? end - (`\\end{${env}}`).length : end)) {
            const tex = src.slice(i, end);
            return {
              start: i,
              end,
              contentStart: i,
              contentEnd: end,
              tex,
              display: true,
              delim: 'env',
              envName: innerEnvAt(src, i, pos) || env,
              closed,
            };
          }
          i = end;
          continue;
        }
      }
      i += 2;
      continue;
    }

    // Inline code `...`
    if (ch === '`') {
      let ticks = 1;
      while (src[i + ticks] === '`') ticks++;
      const needle = '`'.repeat(ticks);
      const close = src.indexOf(needle, i + ticks);
      const end = close >= 0 ? close + ticks : Math.min(len, src.indexOf('\n\n', i) >= 0 ? src.indexOf('\n\n', i) : len);
      if (pos >= i && pos < end) return null;
      i = end;
      continue;
    }

    // $$ ... $$
    if (ch === '$' && src[i + 1] === '$') {
      const contentStart = i + 2;
      let close = -1;
      for (let j = contentStart; j < len - 1; j++) {
        if (src[j] === '\\') {
          j++;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '$') {
          close = j;
          break;
        }
      }
      const closed = close >= 0;
      const contentEnd = closed ? close : len;
      const end = closed ? close + 2 : len;
      if (pos >= contentStart && pos <= contentEnd) {
        const tex = src.slice(contentStart, contentEnd);
        return { start: i, end, contentStart, contentEnd, tex, display: true, delim: '$$', envName: innerEnvAt(src, contentStart, pos), closed };
      }
      i = end;
      continue;
    }

    // $ ... $
    if (ch === '$') {
      const contentStart = i + 1;
      let close = -1;
      for (let j = contentStart; j < len; j++) {
        if (src[j] === '\n' && src[j + 1] === '\n') break;
        if (src[j] === '\\') {
          j++;
          continue;
        }
        if (src[j] === '$') {
          close = j;
          break;
        }
      }
      // Unclosed currency like "$50" shouldn't eat the paragraph
      if (close < 0 && /\d/.test(src.charAt(contentStart))) {
        i++;
        continue;
      }
      const closed = close >= 0;
      const paraEnd = src.indexOf('\n\n', contentStart);
      const contentEnd = closed ? close : paraEnd >= 0 ? paraEnd : len;
      const end = closed ? close + 1 : contentEnd;
      if (pos >= contentStart && pos <= contentEnd) {
        const tex = src.slice(contentStart, contentEnd);
        return { start: i, end, contentStart, contentEnd, tex, display: false, delim: '$', envName: innerEnvAt(src, contentStart, pos), closed };
      }
      i = end;
      continue;
    }

    i++;
  }
  return null;
}

/** Find the innermost unclosed `\begin{env}` active at `pos`, scanning from `from`. */
function innerEnvAt(src: string, from: number, pos: number): string | undefined {
  const stack: string[] = [];
  const re = /\\(begin|end)\{([a-zA-Z*]+)\}/g;
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) && m.index < pos) {
    if (m[1] === 'begin') stack.push(m[2]);
    else if (stack.length && stack[stack.length - 1] === m[2]) stack.pop();
  }
  return stack.at(-1);
}

/** Check if offset `pos` is inside a fenced code block (``` or ~~~). */
function isInCodeFence(src: string, pos: number): boolean {
  let fence: string | null = null;
  let idx = 0;
  for (const line of src.slice(0, pos).split('\n')) {
    const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1][0].repeat(m[1].length);
      else if (line.trim().startsWith(fence[0].repeat(fence.length))) fence = null;
    }
    idx += line.length + 1;
    if (idx > pos) break;
  }
  return fence !== null;
}

/** Prepare raw TeX for KaTeX preview (strips \label, normalizes equation/multline). */
function normalizeTexForKatex(raw: string): string {
  let s = raw.replace(/\\label\{[^}]*\}/g, '').replace(/\\(?:nonumber|notag)\b/g, '').trim();
  const eqWrap = s.match(/^\\begin\{equation\*?\}([\s\S]*)\\end\{equation\*?\}$/);
  if (eqWrap) s = eqWrap[1].trim();
  s = s.replace(/\\begin\{multline\*?\}/g, '\\begin{gathered}').replace(/\\end\{multline\*?\}/g, '\\end{gathered}');
  s = s.replace(/\\begin\{flalign\*?\}/g, '\\begin{aligned}').replace(/\\end\{flalign\*?\}/g, '\\end{aligned}');
  return s;
}

/** Extract standalone inline `\newcommand` / `\DeclareMathOperator` lines outside code fences. */
function extractInlinePreamble(src: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of src.split('\n')) {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm) {
      if (!fence) fence = fm[1][0].repeat(fm[1].length);
      else if (line.trim().startsWith(fence[0].repeat(fence.length))) fence = null;
      continue;
    }
    if (!fence && /^\s*\\(?:(?:re|provide)?newcommand\*?|DeclareMathOperator\*?)\b/.test(line)) {
      out.push(line.trim());
    }
  }
  return out.join('\n');
}

/** Extract inline ```bibtex blocks from body. */
function extractInlineBib(src: string): string {
  const parts: string[] = [];
  for (const m of src.matchAll(/^([ \t]*)(`{3,}|~{3,})bibtex[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm)) {
    if (m[3].trim()) parts.push(m[3].trim());
  }
  return parts.join('\n\n');
}

type DocLabel = {
  label: string;
  kind: string;
  displayNum: string;
  title: string;
  tex?: string;
  line: number;
};

/** Scan document for labels, headings, equations, theorems, and figures (for outline & \ref autocomplete). */
function scanDocument(src: string): {
  labels: DocLabel[];
  outline: Array<{
    kind: 'section' | 'equation' | 'theorem' | 'figure';
    subkind: string;
    level?: number;
    badge: string;
    title: string;
    label?: string;
    tex?: string;
    line: number;
  }>;
} {
  const labels: DocLabel[] = [];
  const outline: Array<{
    kind: 'section' | 'equation' | 'theorem' | 'figure';
    subkind: string;
    level?: number;
    badge: string;
    title: string;
    label?: string;
    tex?: string;
    line: number;
  }> = [];

  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let eqCount = 0;
  let figCount = 0;
  const envCounts = new Map<string, number>();
  const nextEnvNum = (k: string) => {
    const n = (envCounts.get(k) ?? 0) + 1;
    envCounts.set(k, n);
    return n;
  };
  const capKind = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNo = i + 1;

    // Fenced code blocks (check chart/figure id)
    const fm = line.match(/^\s*(`{3,}|~{3,})([^\s`~]*)(.*)$/);
    if (fm) {
      const fChar = fm[1][0];
      const fLen = fm[1].length;
      const lang = fm[2].toLowerCase();
      const meta = fm[3];
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fChar}{${fLen},}\\s*$`).test(lines[i])) {
        bodyLines.push(lines[i]);
        i++;
      }
      i++;
      if (lang === 'chart' || lang === 'diagram' || lang === 'figure') {
        figCount++;
        const idM = meta.match(/\bid=([a-zA-Z0-9:_-]+)/) || bodyLines.join('\n').match(/^id:\s*([a-zA-Z0-9:_-]+)/m);
        const capM = bodyLines.join('\n').match(/^(?:title|caption):\s*(.+)$/m);
        const title = capM ? capM[1].replace(/^["']|["']$/g, '').trim() : `${lang} ${figCount}`;
        const id = idM ? idM[1] : undefined;
        outline.push({ kind: 'figure', subkind: lang, badge: `Fig. ${String(figCount).padStart(2, '0')}`, title, label: id ? (id.startsWith('fig:') ? id : `fig:${id}`) : undefined, line: lineNo });
        if (id) {
          labels.push({ label: id.startsWith('fig:') ? id : `fig:${id}`, kind: 'Fig.', displayNum: `Fig. ${String(figCount).padStart(2, '0')}`, title, line: lineNo });
        }
      }
      continue;
    }

    // Headings
    const hm = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (hm) {
      const level = hm[1].length;
      const raw = hm[2];
      const idM = raw.match(/\s*\{#([^}]+)\}\s*$/);
      const title = (idM ? raw.slice(0, idM.index) : raw).trim();
      const label = idM?.[1];
      outline.push({ kind: 'section', subkind: `h${level}`, level, badge: `H${level}`, title, label, line: lineNo });
      if (label) labels.push({ label, kind: 'Sec.', displayNum: title, title, line: lineNo });
      i++;
      continue;
    }

    // Display math $$...$$ or \[...\]
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      const open = trimmed.startsWith('$$') ? '$$' : '\\[';
      const close = open === '$$' ? '$$' : '\\]';
      const mathLines: string[] = [];
      if (trimmed.length >= open.length + close.length && trimmed.endsWith(close)) {
        mathLines.push(trimmed.slice(open.length, -close.length));
        i++;
      } else {
        mathLines.push(trimmed.slice(open.length));
        i++;
        while (i < lines.length && !lines[i].trim().endsWith(close)) {
          mathLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) {
          mathLines.push(lines[i].trim().slice(0, -close.length));
          i++;
        }
      }
      const rawTex = mathLines.join('\n').trim();
      const labelM = rawTex.match(/\\label\{([^}]+)\}/);
      const tagM = rawTex.match(/\\tag\{([^}]+)\}/);
      const isNumberedEnv = /^\\begin\{(equation|align|gather)\}/.test(rawTex);
      if (labelM || tagM || isNumberedEnv) {
        eqCount++;
        const badge = tagM ? `(${tagM[1]})` : `(${eqCount})`;
        const label = labelM?.[1];
        const cleanTex = normalizeTexForKatex(rawTex);
        outline.push({ kind: 'equation', subkind: 'eq', badge, title: label || cleanTex.slice(0, 40), label, tex: cleanTex, line: lineNo });
        if (label) labels.push({ label, kind: 'Eq.', displayNum: badge, title: label, tex: cleanTex, line: lineNo });
      }
      continue;
    }

    // Bare \begin{env}...\end{env}
    const bm = trimmed.match(/^\\begin\{([a-zA-Z*]+)\}(?:\[([^\]]*)\])?(.*)$/);
    if (bm && (MATH_ENVS.has(bm[1]) || THEOREM_ENVS.has(bm[1]))) {
      const env = bm[1];
      const optTitle = bm[2] ?? '';
      const escaped = env.replace(/\*/g, '\\*');
      const endRe = new RegExp(`\\\\end\\{${escaped}\\}\\s*$`);
      const innerLines: string[] = [];
      if (endRe.test(trimmed)) {
        innerLines.push(trimmed);
        i++;
      } else {
        innerLines.push(line);
        i++;
        while (i < lines.length) {
          innerLines.push(lines[i]);
          if (endRe.test(lines[i].trim())) {
            i++;
            break;
          }
          i++;
        }
      }
      const block = innerLines.join('\n');
      if (MATH_ENVS.has(env)) {
        const numbered = !env.endsWith('*') && ['equation', 'align', 'gather', 'multline', 'flalign', 'alignat'].includes(env);
        const foundLabels = [...block.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]);
        const tagM = block.match(/\\tag\{([^}]+)\}/);
        if (numbered || foundLabels.length || tagM) {
          eqCount++;
          const badge = tagM ? `(${tagM[1]})` : `(${eqCount})`;
          const cleanTex = normalizeTexForKatex(block);
          outline.push({ kind: 'equation', subkind: env, badge, title: foundLabels[0] || env, label: foundLabels[0], tex: cleanTex, line: lineNo });
          for (const lbl of foundLabels) {
            labels.push({ label: lbl, kind: 'Eq.', displayNum: badge, title: lbl, tex: cleanTex, line: lineNo });
          }
        }
      } else if (env !== 'proof') {
        const n = nextEnvNum(env);
        const badge = `${capKind(env)} ${n}`;
        const labelM = block.match(/\\label\{([^}]+)\}/);
        const label = labelM?.[1];
        const title = optTitle || label || badge;
        outline.push({ kind: 'theorem', subkind: env, badge, title, label, line: lineNo });
        if (label) labels.push({ label, kind: capKind(env), displayNum: badge, title: optTitle || badge, line: lineNo });
      }
      continue;
    }

    // Fenced :::theorem[Title]{#thm:foo} ... :::
    const dm = trimmed.match(/^:::([a-zA-Z]+)(?:\[([^\]]*)\])?(?:\{#([^}]+)\})?\s*$/);
    if (dm && THEOREM_ENVS.has(dm[1].toLowerCase())) {
      const env = dm[1].toLowerCase();
      const optTitle = dm[2] ?? '';
      let label = dm[3];
      const innerLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) {
        innerLines.push(lines[i]);
        i++;
      }
      i++;
      if (!label) {
        const lm = innerLines.join('\n').match(/\\label\{([^}]+)\}/);
        if (lm) label = lm[1];
      }
      if (env !== 'proof') {
        const n = nextEnvNum(env);
        const badge = `${capKind(env)} ${n}`;
        outline.push({ kind: 'theorem', subkind: env, badge, title: optTitle || label || badge, label, line: lineNo });
        if (label) labels.push({ label, kind: capKind(env), displayNum: badge, title: optTitle || badge, line: lineNo });
      }
      continue;
    }

    // Standalone image or MDX <Chart id="...">
    const imgM = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)/);
    const mdxChartM = trimmed.match(/^<Chart\b[^>]*\bid="([^"]+)"/);
    if (imgM) {
      figCount++;
      const alt = imgM[1].trim() || imgM[2].split('/').pop() || `Image ${figCount}`;
      outline.push({ kind: 'figure', subkind: 'img', badge: `Fig. ${String(figCount).padStart(2, '0')}`, title: alt, line: lineNo });
    } else if (mdxChartM) {
      figCount++;
      const id = mdxChartM[1];
      const lbl = id.startsWith('fig:') ? id : `fig:${id}`;
      outline.push({ kind: 'figure', subkind: 'chart', badge: `Fig. ${String(figCount).padStart(2, '0')}`, title: id, label: lbl, line: lineNo });
      labels.push({ label: lbl, kind: 'Fig.', displayNum: `Fig. ${String(figCount).padStart(2, '0')}`, title: id, line: lineNo });
    }

    // Loose \label{...} outside blocks
    for (const lm of line.matchAll(/\\label\{([^}]+)\}/g)) {
      if (!labels.some((l) => l.label === lm[1])) {
        labels.push({ label: lm[1], kind: 'Ref', displayNum: lm[1], title: lm[1], line: lineNo });
      }
    }

    i++;
  }

  return { labels, outline };
}

/** Parse CSV, TSV, Python/NumPy `[[1,2],[3,4]]`, or space-separated grid into a 2D array. */
function parseGridInput(raw: string): string[][] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Python / NumPy / JSON-like nested brackets: [[1, 2], [3, 4]]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    const rowMatches = [...inner.matchAll(/\[([^\]]+)\]/g)];
    if (rowMatches.length) {
      return rowMatches.map((m) =>
        m[1]
          .split(/[,;\t]+|\s+/)
          .map((c) => c.trim())
          .filter((c) => c.length > 0),
      );
    }
  }
  const rows = trimmed
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return rows.map((line) => {
    if (line.includes('\t')) return line.split('\t').map((c) => c.trim());
    if (line.includes(',')) return line.split(',').map((c) => c.trim());
    if (line.includes('&')) return line.replace(/\\\\\s*$/, '').split('&').map((c) => c.trim());
    return line.split(/\s+/).map((c) => c.trim());
  });
}

/** Render a small KaTeX preview safely with fallback text. */
function safeKatexHtml(tex: string, displayMode: boolean, macros: Record<string, string>): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      macros: { ...macros },
      throwOnError: false,
      strict: false,
      trust: true,
    });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
}

/**
 * Render an equation preview inline (for `\eqref` autocomplete & outline):
 * maps display-only envs (`align`/`gather`/`alignat`) to their inline-safe
 * counterparts and avoids truncating mid-brace/mid-env.
 */
function safeInlineMathPreview(tex: string, macros: Record<string, string>): string {
  const trimmed = tex.trim();
  if (!trimmed) return '';
  if (trimmed.length > 800) return `<code>${esc(trimmed.slice(0, 120))}…</code>`;
  const inlineSafe = trimmed
    .replace(/\\tag\*?\{[^}]*\}/g, '')
    .replace(/\\(begin|end)\{align\*?\}/g, '\\$1{aligned}')
    .replace(/\\(begin|end)\{gather\*?\}/g, '\\$1{gathered}')
    .replace(/\\(begin|end)\{alignat\*?\}/g, '\\$1{alignedat}');
  return safeKatexHtml(inlineSafe, false, macros);
}

export function initLatexStudio(host: LatexStudioHost): LatexStudioAPI {
  const { root, ta, wrap, signal } = host;
  const on = <K extends string>(el: EventTarget, type: K, fn: (e: any) => void) => el.addEventListener(type, fn, { signal });

  // ---- Recent commands tracking -------------------------------------------------------
  let recent: string[] = [];
  try {
    const saved = JSON.parse(safeStore.get(RECENT_KEY) || '[]');
    if (Array.isArray(saved)) recent = saved.filter((x) => typeof x === 'string').slice(0, 24);
  } catch {}
  function pushRecent(cmd: string) {
    recent = [cmd, ...recent.filter((c) => c !== cmd)].slice(0, 24);
    safeStore.set(RECENT_KEY, JSON.stringify(recent));
    if (!paletteEl.hidden && activePaletteTab === 'recent') renderPaletteGrid();
  }

  // ---- Live merged macros & BibTeX (cached by input key) ------------------------------
  let macroCacheKey = '';
  let cachedMacros: Record<string, string> = { ...host.globalMacros };
  let cachedMacroItems: LatexCatalogItem[] = [];

  function getMergedMacros(): { macros: Record<string, string>; items: LatexCatalogItem[] } {
    const postMacrosSrc = host.getMeta().macros || '';
    const inlineSrc = extractInlinePreamble(ta.value);
    const key = `${postMacrosSrc}\0${inlineSrc}`;
    if (key === macroCacheKey) return { macros: cachedMacros, items: cachedMacroItems };
    macroCacheKey = key;

    const postParsed = parseLatexPreamble(postMacrosSrc) as PreambleResult;
    const inlineParsed = parseLatexPreamble(inlineSrc) as PreambleResult;
    const merged: Record<string, string> = {
      ...host.globalMacros,
      ...(postParsed?.macros ?? {}),
      ...(inlineParsed?.macros ?? {}),
    };
    cachedMacros = merged;

    const items: LatexCatalogItem[] = [];
    for (const [cmd, body] of Object.entries(merged)) {
      const args = countMacroArgs(body);
      const insert = args > 0 ? `${cmd}${Array.from({ length: args }, (_, i) => `{$${i + 1}}`).join('')}` : cmd;
      const sampleArgs = args > 0 ? Array.from({ length: args }, (_, i) => `{${['x', 'y', 'z', 'w'][i] ?? 'a'}}`).join('') : '';
      items.push({
        cmd,
        insert,
        label: `macro → ${body.length > 26 ? `${body.slice(0, 26)}…` : body}`,
        previewTex: `${cmd}${sampleArgs}`,
        category: 'structures',
        keywords: ['macro', 'custom', 'preamble', cmd.slice(1), body],
        args,
      });
    }
    cachedMacroItems = items;
    return { macros: cachedMacros, items: cachedMacroItems };
  }

  function getMergedBib(): BibEntry[] {
    const frontBib = host.getMeta().bibliography || '';
    const inlineBib = extractInlineBib(ta.value);
    const combined = [frontBib.trim(), inlineBib.trim()].filter(Boolean).join('\n\n');
    if (!combined) return [];
    return (parseBibTeX(combined) as BibEntry[]) ?? [];
  }

  // ---- Tab-Stop Snippet Engine ($1, $2, ${1:default}, $0) -----------------------------
  type TabStopSession = {
    stops: Array<{ num: number; start: number; end: number }>;
    index: number;
    lastVal: string;
  };
  let tabSession: TabStopSession | null = null;

  function parseSnippet(tpl: string, baseOffset: number): { text: string; stops: Array<{ num: number; start: number; end: number }> } {
    const rawStops: Array<{ num: number; start: number; end: number }> = [];
    let out = '';
    const re = /\$(?:(\d+)|\{(\d+):([^}]*)\})/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tpl))) {
      out += tpl.slice(last, m.index);
      const num = Number(m[1] ?? m[2]);
      const def = m[3] ?? '';
      const start = baseOffset + out.length;
      out += def;
      const end = baseOffset + out.length;
      rawStops.push({ num, start, end });
      last = m.index + m[0].length;
    }
    out += tpl.slice(last);

    // Order: 1, 2, 3, ..., then 0 at the end (if present)
    rawStops.sort((a, b) => {
      if (a.num === 0 && b.num !== 0) return 1;
      if (b.num === 0 && a.num !== 0) return -1;
      return a.num - b.num || a.start - b.start;
    });
    return { text: out, stops: rawStops };
  }

  function insertSnippet(start: number, end: number, tpl: string) {
    const { text, stops } = parseSnippet(tpl, start);
    if (!stops.length) {
      host.replace(start, end, text);
      syncTabStopsOnInput();
      return;
    }
    const first = stops[0];
    host.replace(start, end, text, first.start, first.end);
    if (stops.length > 1) {
      tabSession = { stops, index: 0, lastVal: ta.value };
    } else {
      syncTabStopsOnInput();
    }
  }

  function syncTabStopsOnInput() {
    if (!tabSession) return;
    const prev = tabSession.lastVal;
    const next = ta.value;
    if (prev === next) return;

    // Diff common prefix & suffix to find the single edit range
    let pre = 0;
    const minLen = Math.min(prev.length, next.length);
    while (pre < minLen && prev[pre] === next[pre]) pre++;
    let suf = 0;
    while (suf < minLen - pre && prev[prev.length - 1 - suf] === next[next.length - 1 - suf]) suf++;

    const editStart = pre;
    const oldEnd = prev.length - suf;
    const delta = next.length - prev.length;

    const cur = tabSession.stops[tabSession.index];
    // If edit happened completely outside the active stop bounds, cancel tab session
    if (editStart < cur.start || oldEnd > cur.end) {
      tabSession = null;
      return;
    }

    for (let i = 0; i < tabSession.stops.length; i++) {
      const s = tabSession.stops[i];
      if (i === tabSession.index) {
        s.end = Math.max(s.start, s.end + delta);
      } else if (s.start >= oldEnd) {
        s.start += delta;
        s.end += delta;
      } else if (s.end >= editStart) {
        s.end = Math.max(s.start, s.end + delta);
      }
    }
    tabSession.lastVal = next;
  }

  function jumpTabStop(dir: 1 | -1): boolean {
    if (!tabSession) return false;
    const nextIdx = tabSession.index + dir;
    if (nextIdx < 0) return false;
    if (nextIdx >= tabSession.stops.length) {
      tabSession = null;
      return false;
    }
    tabSession.index = nextIdx;
    const stop = tabSession.stops[nextIdx];
    ta.setSelectionRange(stop.start, stop.end);
    if (nextIdx === tabSession.stops.length - 1 && stop.num === 0) {
      tabSession = null;
    }
    return true;
  }

  // ---- Smart Autocomplete Popup (.w-pop.w-latex-ac) -----------------------------------
  type AcItem = {
    primary: string;
    desc: string;
    previewHtml: string;
    run: () => void;
  };
  const acEl = document.createElement('div');
  acEl.className = 'w-pop w-latex-ac';
  acEl.hidden = true;
  wrap.append(acEl);

  let acState: { items: AcItem[]; active: number } | null = null;

  function openAc(head: string, items: AcItem[], anchorPos: number) {
    if (!items.length) return closeAc();
    acEl.innerHTML =
      `<div class="w-pop-head">${esc(head)}</div>` +
      `<ul role="listbox" aria-label="${esc(head)}">${items
        .map(
          (it, i) =>
            `<li role="option" data-i="${i}" aria-selected="${i === 0}">` +
            `<span class="w-ac-main"><span class="w-ac-cmd">${esc(it.primary)}</span><span class="w-ac-desc">${esc(it.desc)}</span></span>` +
            `<span class="w-ac-preview" aria-hidden="true">${it.previewHtml}</span>` +
            `</li>`,
        )
        .join('')}</ul>`;
    const c = host.caret(anchorPos);
    host.place(acEl, c.x, c.y + c.h + 2);
    acState = { items, active: 0 };
  }

  function closeAc() {
    acEl.hidden = true;
    acState = null;
  }

  function moveAc(step: number) {
    if (!acState?.items.length) return;
    acState.active = (acState.active + step + acState.items.length) % acState.items.length;
    acEl.querySelectorAll('li').forEach((li, i) => {
      li.setAttribute('aria-selected', String(i === acState!.active));
      if (i === acState!.active) li.scrollIntoView({ block: 'nearest' });
    });
  }

  function pickAc(idx = acState?.active ?? 0) {
    const item = acState?.items[idx];
    closeAc();
    item?.run();
  }

  on(acEl, 'mousedown', (e: MouseEvent) => e.preventDefault());
  on(acEl, 'click', (e: MouseEvent) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
    if (li) pickAc(Number(li.dataset.i));
  });

  function detectAutocomplete() {
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd || document.activeElement !== ta || isInCodeFence(ta.value, pos)) {
      return closeAc();
    }
    const v = ta.value;
    const before = v.slice(Math.max(0, pos - 100), pos);
    const { macros, items: macroItems } = getMergedMacros();

    // 1. \begin{<query>
    const beginM = before.match(/\\begin\{([a-zA-Z*]{0,24})$/);
    if (beginM) {
      const q = beginM[1].toLowerCase();
      const replaceFrom = pos - beginM[0].length;
      const matches = LATEX_ENVIRONMENTS.filter((e) => !q || e.name.toLowerCase().includes(q) || e.label.toLowerCase().includes(q)).slice(0, 12);
      const items: AcItem[] = matches.map((env) => ({
        primary: env.name,
        desc: env.label,
        previewHtml: safeKatexHtml(env.previewTex, false, macros),
        run: () => {
          const alreadyClosed = v.slice(pos, pos + 2).startsWith('}') && v.slice(pos, pos + 400).includes(`\\end{${env.name}}`);
          if (alreadyClosed) {
            host.replace(pos - beginM[1].length, pos + 1, `${env.name}}`);
          } else {
            const closeExtra = v[pos] === '}' ? 1 : 0;
            insertSnippet(replaceFrom, pos + closeExtra, env.insert);
          }
          pushRecent(`\\begin{${env.name}}`);
        },
      }));
      return openAc('environment', items, replaceFrom);
    }

    // 2. \eqref{ / \ref{ / \cref{ / \Cref{
    const refM = before.match(/\\(eqref|ref|cref|Cref)\{([^}\n]{0,60})$/);
    if (refM) {
      const q = refM[2].toLowerCase();
      const { labels } = scanDocument(v);
      const preferEq = refM[1] === 'eqref';
      const matches = labels
        .filter((l) => !q || l.label.toLowerCase().includes(q) || l.title.toLowerCase().includes(q))
        .sort((a, b) => Number(b.kind === 'Eq.') * Number(preferEq) - Number(a.kind === 'Eq.') * Number(preferEq))
        .slice(0, 12);
      const replaceFrom = pos - refM[2].length;
      const closeExtra = v[pos] === '}' ? 1 : 0;
      const items: AcItem[] = matches.map((l) => ({
        primary: l.label,
        desc: `${l.kind} ${l.displayNum}${l.title && l.title !== l.label ? ` · ${l.title}` : ''}`,
        previewHtml: l.tex ? safeInlineMathPreview(l.tex, macros) : `<span class="w-ac-tag">${esc(l.displayNum)}</span>`,
        run: () => {
          host.replace(replaceFrom, pos + closeExtra, `${l.label}}`);
        },
      }));
      return openAc('reference label', items, pos - refM[0].length);
    }

    // 3. \cite{ / \citep{ / \citet{ / [@
    const citeM = before.match(/\\cite[pt]?\{(?:[^}\n]*,\s*)?([^},\n]{0,50})$/);
    const pandocCiteM = !citeM ? before.match(/\[@(?:[^\]\n]*;\s*@?)?([^\]\n;,\s]{0,50})$/) : null;
    if (citeM || pandocCiteM) {
      const q = (citeM ? citeM[1] : pandocCiteM![1]).toLowerCase();
      const entries = getMergedBib();
      const matches = entries
        .filter((e) => !q || e.key.toLowerCase().includes(q) || e.title.toLowerCase().includes(q) || e.author.toLowerCase().includes(q) || e.year.includes(q))
        .slice(0, 12);
      const typed = citeM ? citeM[1] : pandocCiteM![1];
      const replaceFrom = pos - typed.length;
      const closer = citeM ? '}' : ']';
      const hasCloser = v[pos] === closer;
      const items: AcItem[] = matches.map((e) => {
        const lead = e.authors?.[0]?.last || e.author.split(',')[0] || 'Unknown';
        const etAl = (e.authors?.length ?? 0) > 1 ? ' et al.' : '';
        return {
          primary: e.key,
          desc: `${lead}${etAl}${e.year ? ` (${e.year})` : ''} — ${e.title || e.venue || e.type}`,
          previewHtml: `<span class="w-ac-tag">${esc(e.year || e.type)}</span>`,
          run: () => {
            host.replace(replaceFrom, pos + (hasCloser ? 1 : 0), `${e.key}${closer}`);
          },
        };
      });
      return openAc('citation', items, pos - (citeM ? citeM[0].length : pandocCiteM![0].length));
    }

    // 4. \command autocomplete
    const cmdM = before.match(/(^|[^\\])((?:\\\\)*)\\([a-zA-Z]{1,24})$/);
    if (cmdM) {
      const query = cmdM[3];
      const inMath = !!findMathContext(v, pos);
      const qLower = query.toLowerCase();
      const matchesGlobal = [...GLOBAL_CMD_TRIGGERS].some((g) => g.toLowerCase().startsWith(qLower));
      if (!inMath && !matchesGlobal) return closeAc();

      const replaceFrom = pos - query.length - 1; // include '\'
      let results = searchCatalog(query, macroItems, recent, 12);
      if (!inMath) {
        results = results.filter((r) => {
          const bare = r.cmd.replace(/^\\+/, '');
          return GLOBAL_CMD_TRIGGERS.has(bare) || r.isEnv;
        });
      }
      const items: AcItem[] = results.map((item) => ({
        primary: item.cmd,
        desc: item.label,
        previewHtml: safeKatexHtml(item.previewTex, false, macros),
        run: () => {
          insertSnippet(replaceFrom, pos, item.insert);
          pushRecent(item.cmd);
        },
      }));
      return openAc(inMath ? 'LaTeX' : 'LaTeX command', items, replaceFrom);
    }

    closeAc();
  }

  // ---- Zero-Latency Instant Floating KaTeX Popover (.w-math-peek) ---------------------
  const peekEl = document.createElement('div');
  peekEl.className = 'w-math-peek';
  peekEl.hidden = true;
  peekEl.innerHTML =
    `<div class="w-math-peek-bar">` +
    `<span class="w-math-peek-kind" data-peek-kind>math</span>` +
    `<span class="w-math-peek-acts">` +
    `<button type="button" class="w-math-peek-pin" data-peek-pin aria-pressed="false" title="Keep live math popover visible in split mode">pin</button>` +
    `<button type="button" class="w-math-peek-close" data-peek-close aria-label="Hide math popover">×</button>` +
    `</span>` +
    `</div>` +
    `<div class="w-math-peek-body" data-peek-body></div>` +
    `<div class="w-math-peek-err" data-peek-err hidden></div>`;
  wrap.append(peekEl);

  const peekKindEl = peekEl.querySelector<HTMLElement>('[data-peek-kind]')!;
  const peekBodyEl = peekEl.querySelector<HTMLElement>('[data-peek-body]')!;
  const peekErrEl = peekEl.querySelector<HTMLElement>('[data-peek-err]')!;
  const peekPinBtn = peekEl.querySelector<HTMLButtonElement>('[data-peek-pin]')!;
  let peekInSplit = safeStore.get(PEEK_SPLIT_KEY) === 'on';
  let peekDismissedAt = -1;
  let peekTimer = 0;

  const paintPeekPin = () => {
    peekPinBtn.setAttribute('aria-pressed', String(peekInSplit));
    peekPinBtn.textContent = peekInSplit ? 'pinned' : 'pin';
    const cb = paletteEl?.querySelector<HTMLInputElement>('[data-lp-peek-split]');
    if (cb) cb.checked = peekInSplit;
  };

  on(peekEl, 'mousedown', (e: MouseEvent) => e.preventDefault());
  on(peekPinBtn, 'click', () => {
    peekInSplit = !peekInSplit;
    safeStore.set(PEEK_SPLIT_KEY, peekInSplit ? 'on' : 'off');
    paintPeekPin();
    updateMathPeek();
  });
  on(peekEl.querySelector('[data-peek-close]')!, 'click', () => {
    const ctx = findMathContext(ta.value, ta.selectionStart);
    peekDismissedAt = ctx?.start ?? -1;
    peekEl.hidden = true;
  });

  function shouldShowPeek(hasError: boolean): boolean {
    const isFocus = document.documentElement.classList.contains('write-focus');
    const layout = root.dataset.layout || 'write';
    if (layout === 'preview') return false;
    if (isFocus || layout === 'write') return true;
    return peekInSplit || hasError;
  }

  function queueMathPeek() {
    clearTimeout(peekTimer);
    peekTimer = window.setTimeout(updateMathPeek, 24);
  }

  function updateMathPeek() {
    if (document.activeElement !== ta) {
      peekEl.hidden = true;
      return;
    }
    const ctx = findMathContext(ta.value, ta.selectionStart);
    if (!ctx) {
      peekDismissedAt = -1;
      peekEl.hidden = true;
      return;
    }
    if (peekDismissedAt === ctx.start) return;
    const rawTex = normalizeTexForKatex(ctx.tex);
    if (!rawTex) {
      peekEl.hidden = true;
      return;
    }

    const { macros } = getMergedMacros();
    let html = '';
    let errMsg = '';
    let errHint = '';
    try {
      html = katex.renderToString(rawTex, {
        displayMode: ctx.display,
        macros: { ...macros },
        throwOnError: true,
        strict: false,
        trust: true,
      });
    } catch (err) {
      errMsg = err instanceof Error ? err.message.replace(/^KaTeX parse error:\s*/i, '') : String(err);
      errHint = String(friendlyKatexHint(errMsg, rawTex) || '');
      html = safeKatexHtml(rawTex, ctx.display, macros);
    }

    const hasError = !!errMsg;
    if (!shouldShowPeek(hasError)) {
      peekEl.hidden = true;
      return;
    }

    peekKindEl.textContent = ctx.envName ? ctx.envName : ctx.display ? 'display math' : 'inline math';
    peekBodyEl.innerHTML = html;
    peekEl.classList.toggle('is-error', hasError);
    if (hasError) {
      peekErrEl.hidden = false;
      peekErrEl.innerHTML = `<strong>${esc(errMsg)}</strong>${errHint ? `<span class="w-math-peek-hint">${esc(errHint)}</span>` : ''}`;
    } else {
      peekErrEl.hidden = true;
      peekErrEl.textContent = '';
    }

    // Place cleanly below (or above if autocomplete is open below!) the math expression
    const endCaret = host.caret(ctx.end);
    const startCaret = host.caret(ctx.start);
    peekEl.hidden = false;
    const preferAbove = !acEl.hidden;
    const y = preferAbove
      ? Math.max(0, startCaret.y - peekEl.offsetHeight - 8)
      : endCaret.y + endCaret.h + 6;
    host.place(peekEl, startCaret.x, y);
  }

  // ---- Searchable [ Σ math ] Drawer ([data-latex-palette]) ----------------------------
  const paletteEl =
    root.querySelector<HTMLElement>('[data-latex-palette]') ??
    (() => {
      const el = document.createElement('div');
      el.className = 'w-latex-palette';
      el.setAttribute('data-latex-palette', '');
      el.hidden = true;
      (root.querySelector('[data-ribbon-slot]') ?? wrap).after(el);
      return el;
    })();
  paletteEl.classList.add('w-latex-palette');

  const glyphCache = new Map<string, string>();
  let activePaletteTab: LatexCategory | 'recent' | 'macros' = 'greek';
  let paletteBuilt = false;

  function cachedGlyph(tex: string, macros: Record<string, string>, useCache = true): string {
    if (useCache && glyphCache.has(tex)) return glyphCache.get(tex)!;
    const html = safeKatexHtml(tex, false, macros);
    if (useCache) glyphCache.set(tex, html);
    return html;
  }

  function buildPalette() {
    if (paletteBuilt) return;
    paletteBuilt = true;
    paletteEl.innerHTML =
      `<div class="w-lp-head">` +
      `<input type="search" class="w-lp-search" data-lp-search placeholder="search 300+ symbols, environments, macros (e.g. approx, sum, norm, theorem)…" aria-label="Filter LaTeX symbols" autocomplete="off" />` +
      `<label class="w-lp-opt" title="Show instant KaTeX popover below formulas even in split view"><input type="checkbox" data-lp-peek-split /> live popover</label>` +
      `<button type="button" class="bevel w-lp-btn" data-lp-matrix>matrix.exe</button>` +
      `<button type="button" class="bevel w-lp-close" data-lp-close aria-label="Close math drawer">×</button>` +
      `</div>` +
      `<div class="w-lp-tabs" role="tablist" aria-label="LaTeX categories">${LATEX_CATEGORIES.map(
        (c) => `<button type="button" class="bevel w-lp-tab" role="tab" data-lp-tab="${c.id}" aria-selected="${c.id === activePaletteTab}">${esc(c.label)}</button>`,
      ).join('')}</div>` +
      `<div class="w-lp-macros-bar" data-lp-macros-bar hidden>` +
      `<span>active global + post + inline macros</span>` +
      `<button type="button" class="bevel" data-lp-edit-macros>edit post macros</button>` +
      `<a href="/write/settings/" class="w-link-btn">global settings ↗</a>` +
      `</div>` +
      `<div class="w-lp-grid" data-lp-grid></div>`;

    paintPeekPin();

    const searchInput = paletteEl.querySelector<HTMLInputElement>('[data-lp-search]')!;
    const peekSplitCb = paletteEl.querySelector<HTMLInputElement>('[data-lp-peek-split]')!;

    on(paletteEl, 'mousedown', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) e.preventDefault();
    });
    on(searchInput, 'input', () => renderPaletteGrid());
    on(searchInput, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        togglePalette(false);
        ta.focus({ preventScroll: true });
      }
    });
    on(peekSplitCb, 'change', () => {
      peekInSplit = peekSplitCb.checked;
      safeStore.set(PEEK_SPLIT_KEY, peekInSplit ? 'on' : 'off');
      paintPeekPin();
      updateMathPeek();
    });
    on(paletteEl, 'click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const tab = target.closest<HTMLButtonElement>('[data-lp-tab]');
      if (tab) {
        activePaletteTab = tab.dataset.lpTab as typeof activePaletteTab;
        paletteEl.querySelectorAll('[data-lp-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === tab)));
        renderPaletteGrid();
        return;
      }
      if (target.closest('[data-lp-close]')) return togglePalette(false);
      if (target.closest('[data-lp-matrix]')) return openMatrixBuilder('ribbon');
      if (target.closest('[data-lp-edit-macros]')) return toggleBibMacros('macros', true);

      const tile = target.closest<HTMLButtonElement>('[data-lp-insert]');
      if (tile) {
        const insert = tile.dataset.lpInsert!;
        const cmd = tile.dataset.lpCmd!;
        const isBlock = tile.dataset.lpBlock === '1';
        insertFromPalette(cmd, insert, isBlock);
      }
    });
  }

  function insertFromPalette(cmd: string, insert: string, isBlock: boolean) {
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const inMath = !!findMathContext(ta.value, s);

    if (isBlock) {
      const ls = lineStartOf(ta.value, s);
      const le = lineEndOf(ta.value, e);
      if (s === e && !ta.value.slice(ls, le).trim()) {
        insertSnippet(ls, le, insert);
      } else {
        insertSnippet(le, le, `\n\n${insert}`);
      }
    } else if (!inMath && !/^\\(?:begin|eqref|ref|cref|cite|label|newcommand|DeclareMathOperator)/.test(insert)) {
      // Automatically wrap math symbol in $...$ when clicked outside math!
      const sel = ta.value.slice(s, e);
      const tpl = sel && insert.includes('$1') ? `$${insert.replace('$1', sel)}$` : `$${insert}$`;
      insertSnippet(s, e, tpl);
    } else {
      const sel = ta.value.slice(s, e);
      const tpl = sel && insert.includes('$1') ? insert.replace('$1', sel) : insert;
      insertSnippet(s, e, tpl);
    }
    pushRecent(cmd);
    queueMathPeek();
  }

  function renderPaletteGrid() {
    if (!paletteBuilt) buildPalette();
    const grid = paletteEl.querySelector<HTMLElement>('[data-lp-grid]')!;
    const macrosBar = paletteEl.querySelector<HTMLElement>('[data-lp-macros-bar]')!;
    const query = paletteEl.querySelector<HTMLInputElement>('[data-lp-search]')!.value.trim();
    const { macros, items: macroItems } = getMergedMacros();

    macrosBar.hidden = activePaletteTab !== 'macros' || !!query;

    let items: LatexCatalogItem[];
    if (query) {
      items = searchCatalog(query, macroItems, recent, 64);
    } else if (activePaletteTab === 'macros') {
      items = macroItems;
    } else if (activePaletteTab === 'recent') {
      const byCmd = new Map([...macroItems, ...LATEX_CATALOG].map((it) => [it.cmd, it]));
      items = recent.map((c) => byCmd.get(c)).filter((x): x is LatexCatalogItem => !!x);
      if (!items.length) {
        grid.innerHTML = `<p class="w-lp-empty">No recent symbols yet — pick any tab or type to search.</p>`;
        return;
      }
    } else {
      items = LATEX_CATALOG.filter((it) => it.category === activePaletteTab);
    }

    if (!items.length) {
      grid.innerHTML = `<p class="w-lp-empty">No matching LaTeX symbols for “${esc(query)}”.</p>`;
      return;
    }

    const useCache = activePaletteTab !== 'macros';
    grid.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="bevel w-lp-tile${it.isBlock ? ' w-lp-tile--wide' : ''}" ` +
          `data-lp-insert="${esc(it.insert)}" data-lp-cmd="${esc(it.cmd)}" data-lp-block="${it.isBlock ? '1' : '0'}" ` +
          `title="${esc(`${it.cmd} — ${it.label}`)}">` +
          `<span class="w-lp-glyph">${cachedGlyph(it.previewTex, macros, useCache)}</span>` +
          `<span class="w-lp-cmd">${esc(it.isEnv && it.envName ? it.envName : it.cmd)}</span>` +
          `</button>`,
      )
      .join('');
  }

  function syncToolbarExpanded(act: string, expanded: boolean) {
    root.querySelectorAll<HTMLElement>(`[data-act="${act}"]`).forEach((b) => b.setAttribute('aria-expanded', String(expanded)));
  }

  function togglePalette(force?: boolean) {
    const open = force !== undefined ? force : paletteEl.hidden;
    if (open) {
      buildPalette();
      toggleOutline(false);
      toggleBibMacros(undefined, false);
      renderPaletteGrid();
    }
    paletteEl.hidden = !open;
    syncToolbarExpanded('latex-palette', open);
  }

  // ---- Collapsible [ outline ] Panel ([data-latex-outline]) ---------------------------
  const outlineEl =
    root.querySelector<HTMLElement>('[data-latex-outline]') ??
    (() => {
      const el = document.createElement('div');
      el.className = 'w-latex-outline';
      el.setAttribute('data-latex-outline', '');
      el.hidden = true;
      paletteEl.after(el);
      return el;
    })();
  outlineEl.classList.add('w-latex-outline');

  let outlineFilter: 'all' | 'section' | 'equation' | 'theorem' | 'figure' = 'all';
  let outlineTimer = 0;

  function queueOutline() {
    if (outlineEl.hidden) return;
    clearTimeout(outlineTimer);
    outlineTimer = window.setTimeout(renderOutline, 220);
  }

  function renderOutline() {
    const { outline } = scanDocument(ta.value);
    const { macros } = getMergedMacros();
    const filtered = outlineFilter === 'all' ? outline : outline.filter((it) => it.kind === outlineFilter);

    const counts = {
      all: outline.length,
      section: outline.filter((x) => x.kind === 'section').length,
      equation: outline.filter((x) => x.kind === 'equation').length,
      theorem: outline.filter((x) => x.kind === 'theorem').length,
      figure: outline.filter((x) => x.kind === 'figure').length,
    };

    const filters: Array<{ id: typeof outlineFilter; label: string }> = [
      { id: 'all', label: `all (${counts.all})` },
      { id: 'section', label: `sections (${counts.section})` },
      { id: 'equation', label: `eqs (${counts.equation})` },
      { id: 'theorem', label: `theorems (${counts.theorem})` },
      { id: 'figure', label: `figs (${counts.figure})` },
    ];

    outlineEl.innerHTML =
      `<div class="w-lo-head">` +
      `<span class="w-lo-title">outline</span>` +
      `<span class="w-lo-filters" role="group" aria-label="Filter outline">${filters
        .map(
          (f) =>
            `<button type="button" class="bevel w-lo-filter" data-lo-filter="${f.id}" aria-pressed="${f.id === outlineFilter}">${esc(f.label)}</button>`,
        )
        .join('')}</span>` +
      `<button type="button" class="bevel w-lp-close" data-lo-close aria-label="Close outline">×</button>` +
      `</div>` +
      (filtered.length
        ? `<ul class="w-lo-list">${filtered
            .map((it) => {
              const refCmd = it.label ? (it.kind === 'equation' ? `\\eqref{${it.label}}` : `\\cref{${it.label}}`) : '';
              const indent = it.kind === 'section' && it.level ? ` style="--lo-depth:${Math.max(0, it.level - 2)}"` : '';
              return (
                `<li class="w-lo-item w-lo-item--${it.kind}"${indent}>` +
                `<button type="button" class="w-lo-jump" data-lo-line="${it.line}">` +
                `<span class="w-lo-badge">${esc(it.badge)}</span>` +
                `<span class="w-lo-body">${it.tex ? `<span class="w-lo-tex">${safeInlineMathPreview(it.tex, macros)}</span>` : `<span class="w-lo-label">${esc(it.title)}</span>`}</span>` +
                `<span class="w-lo-line">L${it.line}</span>` +
                `</button>` +
                (refCmd
                  ? `<button type="button" class="bevel w-lo-ref" data-lo-ref="${esc(refCmd)}" title="Insert ${esc(refCmd)} at cursor">${it.kind === 'equation' ? '\\eqref' : '\\cref'}</button>`
                  : '') +
                `</li>`
              );
            })
            .join('')}</ul>`
        : `<p class="w-lp-empty">No matching items in this document yet.</p>`);
  }

  on(outlineEl, 'mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });
  on(outlineEl, 'click', (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-lo-close]')) return toggleOutline(false);
    const f = t.closest<HTMLButtonElement>('[data-lo-filter]');
    if (f) {
      outlineFilter = f.dataset.loFilter as typeof outlineFilter;
      renderOutline();
      return;
    }
    const refBtn = t.closest<HTMLButtonElement>('[data-lo-ref]');
    if (refBtn) {
      if (document.activeElement !== ta) ta.focus({ preventScroll: true });
      host.replace(ta.selectionStart, ta.selectionEnd, refBtn.dataset.loRef!);
      return;
    }
    const jump = t.closest<HTMLButtonElement>('[data-lo-line]');
    if (jump) {
      host.jumpToLine(Number(jump.dataset.loLine));
    }
  });

  function toggleOutline(force?: boolean) {
    const open = force !== undefined ? force : outlineEl.hidden;
    if (open) {
      togglePalette(false);
      toggleBibMacros(undefined, false);
      renderOutline();
    }
    outlineEl.hidden = !open;
    syncToolbarExpanded('latex-outline', open);
  }

  // ---- Collapsible [ bib & macros ] Drawer ([data-latex-bibmacros]) -------------------
  const bmEl =
    root.querySelector<HTMLElement>('[data-latex-bibmacros]') ??
    (() => {
      const el = document.createElement('div');
      el.className = 'w-latex-bibmacros';
      el.setAttribute('data-latex-bibmacros', '');
      el.hidden = true;
      outlineEl.after(el);
      return el;
    })();
  bmEl.classList.add('w-latex-bibmacros');

  let bmTab: 'bib' | 'macros' = 'bib';
  let bmBuilt = false;

  const BIB_TEMPLATES: Record<string, string> = {
    article: `@article{author2025key,\n  title={Paper Title},\n  author={Last, First and Second, Author},\n  journal={Journal Name},\n  year={2025}\n}\n`,
    inproceedings: `@inproceedings{author2025conf,\n  title={Conference Paper Title},\n  author={Last, First},\n  booktitle={Proceedings of NeurIPS},\n  year={2025}\n}\n`,
    misc: `@misc{author2025arxiv,\n  title={Preprint Title},\n  author={Last, First},\n  year={2025},\n  eprint={2501.00001},\n  archivePrefix={arXiv}\n}\n`,
  };

  function buildBibMacros() {
    if (bmBuilt) return;
    bmBuilt = true;
    bmEl.innerHTML =
      `<div class="w-bm-head">` +
      `<div class="w-bm-tabs" role="tablist">` +
      `<button type="button" class="bevel w-bm-tab" role="tab" data-bm-tab="bib" aria-selected="true">bibliography (.bib)</button>` +
      `<button type="button" class="bevel w-bm-tab" role="tab" data-bm-tab="macros" aria-selected="false">preamble macros</button>` +
      `</div>` +
      `<button type="button" class="bevel w-lp-close" data-bm-close aria-label="Close bibliography & macros">×</button>` +
      `</div>` +
      `<div class="w-bm-pane" data-bm-pane="bib">` +
      `<div class="w-bm-actions">` +
      `<button type="button" class="bevel" data-bm-add="article">+ @article</button>` +
      `<button type="button" class="bevel" data-bm-add="inproceedings">+ @inproceedings</button>` +
      `<button type="button" class="bevel" data-bm-add="misc">+ @misc (arXiv)</button>` +
      `</div>` +
      `<textarea class="w-bm-ta" data-bm-bib rows="5" spellcheck="false" autocomplete="off" placeholder="@article{vaswani2017attention,\n  title={Attention Is All You Need},\n  author={Vaswani, Ashish and Shazeer, Noam},\n  year={2017}\n}"></textarea>` +
      `<div class="w-bm-list" data-bm-bib-list></div>` +
      `</div>` +
      `<div class="w-bm-pane" data-bm-pane="macros" hidden>` +
      `<div class="w-bm-actions">` +
      `<button type="button" class="bevel" data-bm-madd="cmd">+ \\newcommand</button>` +
      `<button type="button" class="bevel" data-bm-madd="op">+ \\DeclareMathOperator</button>` +
      `<a href="/write/settings/" class="w-link-btn">edit global macros ↗</a>` +
      `</div>` +
      `<textarea class="w-bm-ta" data-bm-macros rows="4" spellcheck="false" autocomplete="off" placeholder="\\newcommand{\\loss}{\\mathcal{L}}\n\\DeclareMathOperator{\\Tr}{Tr}"></textarea>` +
      `<div class="w-bm-pills" data-bm-macro-pills></div>` +
      `<details class="w-bm-global"><summary>inherited global macros (${Object.keys(host.globalMacros).length})</summary><div class="w-bm-pills" data-bm-global-pills></div></details>` +
      `</div>`;

    const bibTa = bmEl.querySelector<HTMLTextAreaElement>('[data-bm-bib]')!;
    const macTa = bmEl.querySelector<HTMLTextAreaElement>('[data-bm-macros]')!;

    on(bibTa, 'input', () => {
      host.setPostBib(bibTa.value);
      host.onEdited();
      renderBibList();
    });
    on(macTa, 'input', () => {
      host.setPostMacros(macTa.value);
      macroCacheKey = '';
      host.onEdited();
      renderMacroPills();
    });
    on(bmEl, 'mousedown', (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (btn && btn.hasAttribute('data-bm-cite')) e.preventDefault();
    });
    on(bmEl, 'click', (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-bm-close]')) return toggleBibMacros(undefined, false);
      const tab = t.closest<HTMLButtonElement>('[data-bm-tab]');
      if (tab) {
        setBmTab(tab.dataset.bmTab as 'bib' | 'macros');
        return;
      }
      const addBib = t.closest<HTMLButtonElement>('[data-bm-add]');
      if (addBib) {
        const tpl = BIB_TEMPLATES[addBib.dataset.bmAdd!] || '';
        const sep = bibTa.value.trim() ? '\n\n' : '';
        bibTa.value = `${bibTa.value.trimEnd()}${sep}${tpl}`;
        host.setPostBib(bibTa.value);
        host.onEdited();
        renderBibList();
        bibTa.focus();
        return;
      }
      const addMac = t.closest<HTMLButtonElement>('[data-bm-madd]');
      if (addMac) {
        const line =
          addMac.dataset.bmMadd === 'op'
            ? '\\DeclareMathOperator{\\Tr}{Tr}'
            : '\\newcommand{\\loss}{\\mathcal{L}}';
        macTa.value = macTa.value.trim() ? `${macTa.value.trimEnd()}\n${line}` : line;
        host.setPostMacros(macTa.value);
        macroCacheKey = '';
        host.onEdited();
        renderMacroPills();
        macTa.focus();
        return;
      }
      const citeBtn = t.closest<HTMLButtonElement>('[data-bm-cite]');
      if (citeBtn) {
        if (document.activeElement !== ta) ta.focus({ preventScroll: true });
        host.replace(ta.selectionStart, ta.selectionEnd, `\\cite{${citeBtn.dataset.bmCite}}`);
      }
    });
  }

  function setBmTab(tab: 'bib' | 'macros') {
    bmTab = tab;
    bmEl.querySelectorAll<HTMLElement>('[data-bm-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.bmTab === tab)));
    bmEl.querySelectorAll<HTMLElement>('[data-bm-pane]').forEach((p) => (p.hidden = p.dataset.bmPane !== tab));
  }

  function renderBibList() {
    const listEl = bmEl.querySelector<HTMLElement>('[data-bm-bib-list]');
    if (!listEl) return;
    const entries = getMergedBib();
    if (!entries.length) {
      listEl.innerHTML = `<p class="w-lp-empty">No BibTeX entries yet. Paste entries above or click + @article.</p>`;
      return;
    }
    listEl.innerHTML = entries
      .map((e) => {
        const lead = e.authors?.[0]?.last || e.author || 'Unknown';
        const etAl = (e.authors?.length ?? 0) > 1 ? ' et al.' : '';
        return (
          `<div class="w-bm-card">` +
          `<div class="w-bm-info">` +
          `<span class="w-bm-key">${esc(e.key)}</span> ` +
          `<span class="w-bm-meta">${esc(lead)}${etAl}${e.year ? ` (${esc(e.year)})` : ''}${e.venue ? ` · ${esc(e.venue)}` : ''}</span>` +
          `<div class="w-bm-title">${esc(e.title || '(untitled)')}</div>` +
          `</div>` +
          `<button type="button" class="bevel w-bm-cite" data-bm-cite="${esc(e.key)}" title="Insert \\cite{${esc(e.key)}}">\\cite</button>` +
          `</div>`
        );
      })
      .join('');
  }

  function renderMacroPills() {
    const pillsEl = bmEl.querySelector<HTMLElement>('[data-bm-macro-pills]');
    const globalEl = bmEl.querySelector<HTMLElement>('[data-bm-global-pills]');
    if (!pillsEl || !globalEl) return;
    const { macros } = getMergedMacros();
    const postParsed = parseLatexPreamble(host.getMeta().macros || '') as PreambleResult;
    const entries = postParsed?.entries ?? [];

    pillsEl.innerHTML = entries.length
      ? entries
          .map((e) => {
            const sample = e.args > 0 ? Array.from({ length: e.args }, (_, i) => `{${['x', 'y', 'z'][i] ?? 'a'}}`).join('') : '';
            return `<span class="w-bm-pill" title="${esc(e.body)}"><code>${esc(e.name)}</code> → <span class="w-bm-katex">${safeKatexHtml(`${e.name}${sample}`, false, macros)}</span></span>`;
          })
          .join('')
      : `<p class="w-lp-empty">No per-post macros defined yet.</p>`;

    globalEl.innerHTML = Object.entries(host.globalMacros)
      .map(([name, body]) => {
        const args = countMacroArgs(body);
        const sample = args > 0 ? Array.from({ length: args }, (_, i) => `{${['x', 'y', 'z'][i] ?? 'a'}}`).join('') : '';
        return `<span class="w-bm-pill" title="${esc(body)}"><code>${esc(name)}</code> → <span class="w-bm-katex">${safeKatexHtml(`${name}${sample}`, false, macros)}</span></span>`;
      })
      .join('');
  }

  function toggleBibMacros(tab?: 'bib' | 'macros', force?: boolean) {
    const wasHidden = bmEl.hidden;
    const open = force !== undefined ? force : wasHidden || (tab !== undefined && tab !== bmTab);
    if (open) {
      buildBibMacros();
      togglePalette(false);
      toggleOutline(false);
      if (tab) setBmTab(tab);
      const meta = host.getMeta();
      const bibTa = bmEl.querySelector<HTMLTextAreaElement>('[data-bm-bib]')!;
      const macTa = bmEl.querySelector<HTMLTextAreaElement>('[data-bm-macros]')!;
      if (bibTa.value !== meta.bibliography) bibTa.value = meta.bibliography;
      if (macTa.value !== meta.macros) macTa.value = meta.macros;
      renderBibList();
      renderMacroPills();
    }
    bmEl.hidden = !open;
    syncToolbarExpanded('latex-bib', open);
  }

  // ---- Preview Diagnostics Badge & Log ([data-latex-diag-btn], [data-latex-diag-panel])
  const diagBtn = root.querySelector<HTMLButtonElement>('[data-latex-diag-btn]');
  const diagPanel = root.querySelector<HTMLElement>('[data-latex-diag-panel]');

  if (diagBtn && diagPanel) {
    on(diagBtn, 'click', () => {
      diagPanel.hidden = !diagPanel.hidden;
      diagBtn.setAttribute('aria-expanded', String(!diagPanel.hidden));
    });
    on(diagPanel, 'click', (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-diag-line]');
      if (btn) host.jumpToLine(Number(btn.dataset.diagLine));
    });
  }

  function setDiagnostics(diags: LatexDiagnostic[]) {
    if (!diagBtn || !diagPanel) return;
    if (!diags.length) {
      diagBtn.hidden = true;
      diagPanel.hidden = true;
      diagBtn.setAttribute('aria-expanded', 'false');
      diagPanel.innerHTML = '';
      return;
    }
    diagBtn.hidden = false;
    diagBtn.textContent = `! ${diags.length} LaTeX ${diags.length === 1 ? 'error' : 'errors'}`;
    diagPanel.innerHTML =
      `<div class="w-diag-head"><span>LaTeX diagnostics (${diags.length})</span><span class="w-diag-sub">click an error to jump to its line</span></div>` +
      `<ul class="w-diag-list">${diags
        .map(
          (d) =>
            `<li class="w-diag-item"><button type="button" class="w-diag-jump" data-diag-line="${d.line}">` +
            `<span class="w-diag-line">L${d.line}</span>` +
            `<span class="w-diag-info">` +
            `<span class="w-diag-msg">${esc(d.message)}</span>` +
            (d.hint ? `<span class="w-diag-hint">${esc(d.hint)}</span>` : '') +
            (d.tex ? `<code class="w-diag-tex">${esc(d.tex.slice(0, 100))}</code>` : '') +
            `</span></button></li>`,
        )
        .join('')}</ul>`;
  }

  // ---- Visual matrix.exe / Structure Builder Dialog ([data-matrix-dialog]) ------------
  const matrixDlg =
    root.querySelector<HTMLDialogElement>('[data-matrix-dialog]') ??
    (() => {
      const d = document.createElement('dialog');
      d.className = 'win w-matrix';
      d.setAttribute('data-matrix-dialog', '');
      d.setAttribute('aria-labelledby', 'w-matrix-title');
      root.append(d);
      return d;
    })();

  let matrixBuilt = false;
  let matrixRows = 2;
  let matrixCols = 2;
  let matrixType = 'pmatrix';
  let matrixCells: string[][] = [
    ['a', 'b'],
    ['c', 'd'],
  ];
  let matrixBack = { s: 0, e: 0, y: 0, via: 'ribbon' as 'slash' | 'ribbon' | 'key' | 'bubble' };

  function buildMatrixDialog() {
    if (matrixBuilt) return;
    matrixBuilt = true;
    matrixDlg.innerHTML =
      `<div class="win-bar">` +
      `<h2 class="win-title" id="w-matrix-title">matrix.exe · visual matrix &amp; structure builder</h2>` +
      `<button type="button" class="w-chart-x bevel" data-mx-close aria-label="Close without inserting">×</button>` +
      `</div>` +
      `<form class="w-matrix-body" data-mx-form novalidate>` +
      `<div class="w-matrix-controls">` +
      `<label>type <select data-mx-type>` +
      `<option value="pmatrix">pmatrix ( )</option>` +
      `<option value="bmatrix">bmatrix [ ]</option>` +
      `<option value="Bmatrix">Bmatrix { }</option>` +
      `<option value="vmatrix">vmatrix | |</option>` +
      `<option value="Vmatrix">Vmatrix ‖ ‖</option>` +
      `<option value="cases">cases { piecewise</option>` +
      `<option value="align">align (numbered)</option>` +
      `<option value="align*">align* (unnumbered)</option>` +
      `</select></label>` +
      `<span class="w-matrix-dim">rows <button type="button" class="bevel" data-mx-r="-1">−</button><strong data-mx-rcount>2</strong><button type="button" class="bevel" data-mx-r="1">+</button></span>` +
      `<span class="w-matrix-dim">cols <button type="button" class="bevel" data-mx-c="-1">−</button><strong data-mx-ccount>2</strong><button type="button" class="bevel" data-mx-c="1">+</button></span>` +
      `<label class="w-matrix-label">\\label <input type="text" data-mx-label placeholder="eq:matrix (optional)" autocomplete="off" spellcheck="false" /></label>` +
      `</div>` +
      `<div class="w-matrix-workspace">` +
      `<div class="w-matrix-left">` +
      `<div class="w-matrix-grid" data-mx-grid></div>` +
      `<div class="w-matrix-paste">` +
      `<label>paste CSV, TSV, or NumPy array <code>[[1,2],[3,4]]</code>` +
      `<textarea rows="2" data-mx-paste spellcheck="false" placeholder="1, 2, 3&#10;4, 5, 6"></textarea></label>` +
      `<div class="w-matrix-paste-acts">` +
      `<button type="button" class="bevel" data-mx-parse>parse into grid</button>` +
      `<button type="button" class="bevel" data-mx-clear>clear cells</button>` +
      `</div>` +
      `</div>` +
      `</div>` +
      `<div class="w-matrix-right">` +
      `<div class="w-matrix-preview well" data-mx-preview></div>` +
      `<details class="w-matrix-src"><summary>LaTeX source</summary><pre data-mx-src></pre></details>` +
      `</div>` +
      `</div>` +
      `<div class="w-matrix-acts">` +
      `<button type="button" class="bevel" data-mx-close><span class="br" aria-hidden="true">[ </span>cancel<span class="br" aria-hidden="true"> ]</span></button>` +
      `<button type="submit" class="bevel w-chart-insert"><span class="br" aria-hidden="true">[ </span>insert<span class="br" aria-hidden="true"> ]</span></button>` +
      `</div>` +
      `</form>`;

    const typeSel = matrixDlg.querySelector<HTMLSelectElement>('[data-mx-type]')!;
    const labelIn = matrixDlg.querySelector<HTMLInputElement>('[data-mx-label]')!;
    const pasteTa = matrixDlg.querySelector<HTMLTextAreaElement>('[data-mx-paste]')!;

    on(typeSel, 'change', () => {
      matrixType = typeSel.value;
      if (matrixType === 'cases' && matrixCols !== 2) {
        matrixCols = 2;
        resizeMatrixCells();
      }
      renderMatrixGrid();
      renderMatrixPreview();
    });
    on(labelIn, 'input', renderMatrixPreview);
    on(pasteTa, 'paste', () => window.setTimeout(() => applyMatrixPaste(pasteTa.value), 0));

    on(matrixDlg, 'click', (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-mx-close]')) return closeMatrixDialog();
      const rb = t.closest<HTMLButtonElement>('[data-mx-r]');
      if (rb) {
        matrixRows = Math.max(1, Math.min(8, matrixRows + Number(rb.dataset.mxR)));
        resizeMatrixCells();
        renderMatrixGrid();
        renderMatrixPreview();
        return;
      }
      const cb = t.closest<HTMLButtonElement>('[data-mx-c]');
      if (cb) {
        matrixCols = Math.max(1, Math.min(8, matrixCols + Number(cb.dataset.mxC)));
        resizeMatrixCells();
        renderMatrixGrid();
        renderMatrixPreview();
        return;
      }
      if (t.closest('[data-mx-parse]')) return applyMatrixPaste(pasteTa.value);
      if (t.closest('[data-mx-clear]')) {
        matrixCells = Array.from({ length: matrixRows }, () => Array.from({ length: matrixCols }, () => ''));
        renderMatrixGrid();
        renderMatrixPreview();
      }
    });

    on(matrixDlg.querySelector('[data-mx-grid]')!, 'input', (e: Event) => {
      const inp = e.target as HTMLInputElement;
      if (!inp.dataset.r) return;
      matrixCells[Number(inp.dataset.r)][Number(inp.dataset.c)] = inp.value;
      renderMatrixPreview();
    });

    on(matrixDlg.querySelector('[data-mx-grid]')!, 'keydown', (e: KeyboardEvent) => {
      const inp = e.target as HTMLInputElement;
      if (!inp.dataset.r) return;
      const r = Number(inp.dataset.r);
      const c = Number(inp.dataset.c);
      let nr = r;
      let nc = c;
      if (e.key === 'ArrowDown') nr = Math.min(matrixRows - 1, r + 1);
      else if (e.key === 'ArrowUp') nr = Math.max(0, r - 1);
      else if (e.key === 'ArrowRight' && inp.selectionStart === inp.value.length) nc = Math.min(matrixCols - 1, c + 1);
      else if (e.key === 'ArrowLeft' && inp.selectionStart === 0) nc = Math.max(0, c - 1);
      else return;
      if (nr !== r || nc !== c) {
        e.preventDefault();
        matrixDlg.querySelector<HTMLInputElement>(`input[data-r="${nr}"][data-c="${nc}"]`)?.focus();
      }
    });

    on(matrixDlg.querySelector('[data-mx-form]')!, 'submit', (e: SubmitEvent) => {
      e.preventDefault();
      closeMatrixDialog(buildMatrixTex());
    });
    on(matrixDlg, 'cancel', (e: Event) => {
      e.preventDefault();
      closeMatrixDialog();
    });
  }

  function resizeMatrixCells() {
    matrixCells = Array.from({ length: matrixRows }, (_, r) =>
      Array.from({ length: matrixCols }, (_, c) => matrixCells[r]?.[c] ?? ''),
    );
  }

  function applyMatrixPaste(raw: string) {
    const parsed = parseGridInput(raw);
    if (!parsed.length) return;
    matrixRows = Math.max(1, Math.min(8, parsed.length));
    matrixCols = Math.max(1, Math.min(8, Math.max(...parsed.map((r) => r.length))));
    matrixCells = Array.from({ length: matrixRows }, (_, r) =>
      Array.from({ length: matrixCols }, (_, c) => parsed[r]?.[c] ?? ''),
    );
    renderMatrixGrid();
    renderMatrixPreview();
  }

  function renderMatrixGrid() {
    matrixDlg.querySelector('[data-mx-rcount]')!.textContent = String(matrixRows);
    matrixDlg.querySelector('[data-mx-ccount]')!.textContent = String(matrixCols);
    const grid = matrixDlg.querySelector<HTMLElement>('[data-mx-grid]')!;
    grid.style.setProperty('--mx-cols', String(matrixCols));
    const html: string[] = [];
    for (let r = 0; r < matrixRows; r++) {
      for (let c = 0; c < matrixCols; c++) {
        const ph =
          matrixType === 'cases'
            ? c === 0
              ? 'value'
              : '\\text{if } x > 0'
            : matrixType.startsWith('align')
              ? c === 0
                ? 'LHS'
                : '= RHS'
              : `${r + 1},${c + 1}`;
        html.push(
          `<input type="text" class="w-matrix-cell" data-r="${r}" data-c="${c}" value="${esc(matrixCells[r]?.[c] ?? '')}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off" aria-label="Row ${r + 1}, Column ${c + 1}" />`,
        );
      }
    }
    grid.innerHTML = html.join('');
  }

  function buildMatrixTex(): string {
    const lbl = matrixDlg.querySelector<HTMLInputElement>('[data-mx-label]')?.value.trim() || '';
    const rowsTex = matrixCells
      .map((row) => row.map((cell) => cell.trim() || '0').join(' & '))
      .join(' \\\\\n  ');

    if (matrixType === 'align' || matrixType === 'align*') {
      const labelLine = lbl ? `\\label{${lbl}}\n  ` : '  ';
      return `\\begin{${matrixType}}\n${labelLine}${rowsTex}\n\\end{${matrixType}}`;
    }

    const inner = `\\begin{${matrixType}}\n  ${rowsTex}\n\\end{${matrixType}}`;
    if (lbl) {
      return `\\begin{equation}\n\\label{${lbl}}\n${inner}\n\\end{equation}`;
    }
    return inner;
  }

  function renderMatrixPreview() {
    const tex = buildMatrixTex();
    const { macros } = getMergedMacros();
    const previewEl = matrixDlg.querySelector<HTMLElement>('[data-mx-preview]')!;
    const srcEl = matrixDlg.querySelector<HTMLElement>('[data-mx-src]')!;
    srcEl.textContent = tex;
    previewEl.innerHTML = safeKatexHtml(normalizeTexForKatex(tex), true, macros);
  }

  function openMatrixBuilder(via: 'slash' | 'ribbon' | 'key' | 'bubble' = 'ribbon') {
    if (matrixDlg.open) return;
    buildMatrixDialog();
    closePopups();
    matrixBack = { s: ta.selectionStart, e: ta.selectionEnd, y: window.scrollY, via };
    renderMatrixGrid();
    renderMatrixPreview();
    matrixDlg.showModal();
    matrixDlg.querySelector<HTMLInputElement>('input[data-r="0"][data-c="0"]')?.focus();
  }

  function closeMatrixDialog(tex?: string) {
    if (matrixDlg.open) matrixDlg.close();
    window.scrollTo({ top: matrixBack.y, behavior: 'instant' });
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(matrixBack.s, matrixBack.e);
    if (!tex) return;

    const inMath = !!findMathContext(ta.value, matrixBack.s);
    const isTopLevelEnv = /^\\begin\{(equation|align\*?)\}/.test(tex);
    if (inMath && !isTopLevelEnv) {
      host.replace(matrixBack.s, matrixBack.e, tex);
    } else if (isTopLevelEnv) {
      host.blockInsert(tex, matrixBack.via);
    } else {
      host.blockInsert(`$$\n${tex}\n$$`, matrixBack.via);
    }
    queueMathPeek();
  }

  // ---- One-Click [ export .tex ] Dialog ([data-tex-dialog]) ---------------------------
  const texDlg =
    root.querySelector<HTMLDialogElement>('[data-tex-dialog]') ??
    (() => {
      const d = document.createElement('dialog');
      d.className = 'win w-tex';
      d.setAttribute('data-tex-dialog', '');
      d.setAttribute('aria-labelledby', 'w-tex-title');
      root.append(d);
      return d;
    })();

  let texBuilt = false;
  let exportResult = { tex: '', bib: '' };
  let texTab: 'tex' | 'bib' = 'tex';

  function buildTexDialog() {
    if (texBuilt) return;
    texBuilt = true;
    texDlg.innerHTML =
      `<div class="win-bar">` +
      `<h2 class="win-title" id="w-tex-title">export.exe · arXiv LaTeX &amp; BibTeX</h2>` +
      `<button type="button" class="w-chart-x bevel" data-tx-close aria-label="Close export dialog">×</button>` +
      `</div>` +
      `<div class="w-tex-body">` +
      `<div class="w-tex-tabs" role="tablist">` +
      `<button type="button" class="bevel w-tex-tab" role="tab" data-tx-tab="tex" aria-selected="true">paper.tex</button>` +
      `<button type="button" class="bevel w-tex-tab" role="tab" data-tx-tab="bib" aria-selected="false">references.bib</button>` +
      `<span class="w-tex-status" data-tx-status role="status"></span>` +
      `</div>` +
      `<pre class="w-tex-code well" data-tx-code tabindex="0"></pre>` +
      `<div class="w-tex-acts">` +
      `<button type="button" class="bevel" data-tx-copy><span class="br" aria-hidden="true">[ </span>copy .tex<span class="br" aria-hidden="true"> ]</span></button>` +
      `<button type="button" class="bevel" data-tx-dl="tex"><span class="br" aria-hidden="true">[ </span>download .tex<span class="br" aria-hidden="true"> ]</span></button>` +
      `<button type="button" class="bevel" data-tx-dl="bib"><span class="br" aria-hidden="true">[ </span>download .bib<span class="br" aria-hidden="true"> ]</span></button>` +
      `<button type="button" class="bevel" data-tx-close><span class="br" aria-hidden="true">[ </span>close<span class="br" aria-hidden="true"> ]</span></button>` +
      `</div>` +
      `</div>`;

    const status = texDlg.querySelector<HTMLElement>('[data-tx-status]')!;
    const setStatus = (msg: string) => {
      status.textContent = msg;
      window.setTimeout(() => {
        if (status.textContent === msg) status.textContent = '';
      }, 2200);
    };

    const downloadFile = (name: string, content: string) => {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    on(texDlg, 'click', async (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-tx-close]')) return texDlg.close();
      const tab = t.closest<HTMLButtonElement>('[data-tx-tab]');
      if (tab) {
        texTab = tab.dataset.txTab as 'tex' | 'bib';
        renderTexTab();
        return;
      }
      if (t.closest('[data-tx-copy]')) {
        const text = texTab === 'bib' ? exportResult.bib : exportResult.tex;
        try {
          await navigator.clipboard.writeText(text);
          setStatus(`copied ${texTab === 'bib' ? 'references.bib' : 'paper.tex'} ✓`);
        } catch {
          setStatus('could not copy to clipboard');
        }
        return;
      }
      const dl = t.closest<HTMLButtonElement>('[data-tx-dl]');
      if (dl) {
        const slug = host.getMeta().slug || 'paper';
        if (dl.dataset.txDl === 'bib') {
          downloadFile('references.bib', exportResult.bib);
          setStatus('downloaded references.bib');
        } else {
          downloadFile(`${slug}.tex`, exportResult.tex);
          setStatus(`downloaded ${slug}.tex`);
        }
      }
    });
  }

  function renderTexTab() {
    texDlg.querySelectorAll<HTMLElement>('[data-tx-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.txTab === texTab)));
    const code = texDlg.querySelector<HTMLElement>('[data-tx-code]')!;
    const copyBtn = texDlg.querySelector<HTMLButtonElement>('[data-tx-copy]')!;
    const bibDlBtn = texDlg.querySelector<HTMLButtonElement>('[data-tx-dl="bib"]')!;
    const hasBib = !!exportResult.bib.trim();
    bibDlBtn.disabled = !hasBib;
    code.textContent = texTab === 'bib' ? exportResult.bib || '% No BibTeX references in this post yet.' : exportResult.tex;
    copyBtn.innerHTML = `<span class="br" aria-hidden="true">[ </span>copy .${texTab}<span class="br" aria-hidden="true"> ]</span>`;
  }

  function openTexExport() {
    buildTexDialog();
    closePopups();
    const meta = host.getMeta();
    exportResult = exportArxivLatex({
      ...meta,
      body: ta.value,
      citationStyle: meta.citationStyle || host.defaultCitationStyle,
      globalMacros: host.globalMacros,
    });
    texTab = 'tex';
    renderTexTab();
    texDlg.showModal();
  }

  // ---- Smart Auto-Closing & Math Typing Ergonomics ------------------------------------
  function handleKeydown(e: KeyboardEvent): boolean {
    // 1. Autocomplete popup takes priority
    if (acState) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveAc(1);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveAc(-1);
        return true;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && acState.items.length) {
        e.preventDefault();
        pickAc();
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAc();
        return true;
      }
    }

    // 2. Tab-stop navigation
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && tabSession) {
      if (jumpTabStop(e.shiftKey ? -1 : 1)) {
        e.preventDefault();
        queueMathPeek();
        return true;
      }
    }
    if (e.key === 'Escape' && tabSession) {
      tabSession = null;
      return false;
    }

    // Skip editing ergonomics when Ctrl/Cmd/Alt is pressed
    if (e.ctrlKey || e.metaKey || e.altKey) return false;

    const s = ta.selectionStart;
    const end = ta.selectionEnd;
    const v = ta.value;
    const hasSel = s !== end;
    const ctx = findMathContext(v, s);
    const inMath = !!ctx;

    // 3. Smart Enter: auto-close \begin{env} OR append ` \\` inside align/cases/matrix
    if (e.key === 'Enter' && !hasSel && !isInCodeFence(v, s)) {
      const ls = lineStartOf(v, s);
      const beforeCursor = v.slice(ls, s);
      const indent = beforeCursor.match(/^[ \t]*/)![0];

      // 3a. Enter right after \begin{env}[optional] with no matching \end{env} nearby
      const beginM = beforeCursor.match(/^[ \t]*\\begin\{([a-zA-Z*]+)\}(?:\[[^\]]*\])?(?:\\label\{[^}]*\})?\s*$/);
      if (beginM && !v.slice(s, lineEndOf(v, s)).trim()) {
        const env = beginM[1];
        const lookahead = v.slice(s, s + 600);
        const endTag = `\\end{${env}}`;
        const nextBlank = lookahead.indexOf('\n\n');
        const endIdx = lookahead.indexOf(endTag);
        if (endIdx < 0 || (nextBlank >= 0 && endIdx > nextBlank)) {
          e.preventDefault();
          const innerIndent = `${indent}  `;
          const inserted = `\n${innerIndent}\n${indent}${endTag}`;
          host.replace(s, s, inserted, s + 1 + innerIndent.length, s + 1 + innerIndent.length);
          queueMathPeek();
          return true;
        }
      }

      // 3b. Plain Enter inside align / gather / cases / matrix appends ` \\`
      if (!e.shiftKey && ctx?.envName && ROW_BREAK_ENVS.has(ctx.envName)) {
        const trimmedBefore = beforeCursor.trim();
        const afterOnLine = v.slice(s, lineEndOf(v, s)).trim();
        if (
          trimmedBefore &&
          !afterOnLine &&
          !/\\\\\s*$/.test(trimmedBefore) &&
          !/^\\(?:begin|end|label)\{/.test(trimmedBefore)
        ) {
          e.preventDefault();
          const inserted = ` \\\\\n${indent}`;
          host.replace(s, s, inserted, s + inserted.length, s + inserted.length);
          queueMathPeek();
          return true;
        }
      }
    }

    // 4. Smart Backspace: delete empty paired delimiters in one undo step
    if (e.key === 'Backspace' && !hasSel && s > 0 && s < v.length) {
      const pair = v.slice(s - 1, s + 1);
      if (pair === '$$' && !isInCodeFence(v, s)) {
        // Delete empty $ | $
        if (v[s - 2] !== '$' && v[s + 1] !== '$') {
          e.preventDefault();
          host.replace(s - 1, s + 1, '', s - 1, s - 1);
          queueMathPeek();
          return true;
        }
      } else if (inMath && (pair === '{}' || pair === '()' || pair === '[]')) {
        e.preventDefault();
        host.replace(s - 1, s + 1, '', s - 1, s - 1);
        queueMathPeek();
        return true;
      }
    }

    // 5. Smart `$`: auto-close, skip closing `$`, or upgrade `$|$` to display math `$$\n|\n$$`
    if (e.key === '$' && !isInCodeFence(v, s)) {
      if (v[s - 1] === '\\') return false;
      if (hasSel && !inMath) {
        e.preventDefault();
        const sel = v.slice(s, end);
        host.replace(s, end, `$${sel}$`, s + 1, s + 1 + sel.length);
        queueMathPeek();
        return true;
      }
      if (!hasSel) {
        // Empty `$|$` → upgrade to display math `$$\n|\n$$` when on an empty/fresh line
        if (v[s - 1] === '$' && v[s] === '$' && v[s - 2] !== '$' && v[s + 1] !== '$') {
          const ls = lineStartOf(v, s - 1);
          const le = lineEndOf(v, s + 1);
          if (!v.slice(ls, s - 1).trim() && !v.slice(s + 1, le).trim()) {
            e.preventDefault();
            host.replace(s - 1, s + 1, '$$\n\n$$', s + 2, s + 2);
            queueMathPeek();
            return true;
          }
          // Inline empty `$|$` → skip over closing `$`
          e.preventDefault();
          ta.setSelectionRange(s + 1, s + 1);
          queueMathPeek();
          return true;
        }
        // Right before closing `$` inside inline math → skip over
        if (inMath && ctx?.delim === '$' && v[s] === '$') {
          e.preventDefault();
          ta.setSelectionRange(s + 1, s + 1);
          queueMathPeek();
          return true;
        }
        // Outside math → auto-pair `$$` with caret inside
        if (!inMath && v[s - 1] !== '$' && v[s] !== '$') {
          const nextCh = v[s] ?? '';
          if (!nextCh || /[\s.,;:!?)}\]"]/.test(nextCh)) {
            e.preventDefault();
            host.replace(s, s, '$$', s + 1, s + 1);
            queueMathPeek();
            return true;
          }
        }
      }
    }

    // 6. Auto-close `{` inside math OR right after LaTeX commands (`\cite`, `\eqref`, `\begin`, etc.)
    if (e.key === '{') {
      const afterCmd = /\\[a-zA-Z@*]+(?:\[[^\]]*\])*$/.test(v.slice(Math.max(0, s - 40), s));
      const afterLeft = /\\left\\$/.test(v.slice(Math.max(0, s - 8), s));
      if (inMath && afterLeft && !hasSel) {
        e.preventDefault();
        host.replace(s, s, '{  \\right\\}', s + 2, s + 2);
        queueMathPeek();
        return true;
      }
      if (inMath || afterCmd) {
        e.preventDefault();
        const sel = v.slice(s, end);
        host.replace(s, end, `{${sel}}`, s + 1, s + 1 + sel.length);
        queueMathPeek();
        return true;
      }
    }

    // 7. Auto-close `(` and `[` inside math (and `\left(` → `\left(  \right)`)
    if (inMath && (e.key === '(' || e.key === '[')) {
      const close = e.key === '(' ? ')' : ']';
      const afterLeft = /\\left$/.test(v.slice(Math.max(0, s - 6), s));
      if (afterLeft && !hasSel) {
        e.preventDefault();
        host.replace(s, s, `${e.key}  \\right${close}`, s + 2, s + 2);
        queueMathPeek();
        return true;
      }
      if (hasSel) {
        e.preventDefault();
        const sel = v.slice(s, end);
        host.replace(s, end, `${e.key}${sel}${close}`, s + 1, s + 1 + sel.length);
        queueMathPeek();
        return true;
      }
      const nextCh = v[s] ?? '';
      if (!nextCh || /[\s)}\]$,.;:]/.test(nextCh)) {
        e.preventDefault();
        host.replace(s, s, `${e.key}${close}`, s + 1, s + 1);
        queueMathPeek();
        return true;
      }
    }

    // 8. Skip over matching closer `}`, `)`, `]` inside math
    if (inMath && !hasSel && (e.key === '}' || e.key === ')' || e.key === ']') && v[s] === e.key) {
      e.preventDefault();
      ta.setSelectionRange(s + 1, s + 1);
      queueMathPeek();
      return true;
    }

    return false;
  }

  // ---- Math-mode selection bubble actions ---------------------------------------------
  function wrapMath(before: string, after: string, cursorAfter?: 'end' | 'tab') {
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    if (cursorAfter === 'tab') {
      insertSnippet(s, e, `${before}${sel}${after}`);
    } else {
      host.replace(s, e, `${before}${sel}${after}`, s + before.length, s + before.length + sel.length);
    }
    queueMathPeek();
  }

  function getMathBubbleActions() {
    return [
      { id: 'math-frac', icon: 'a/b', label: 'Fraction \\frac{sel}{…}', run: () => wrapMath('\\frac{', '}{$1}', 'tab') },
      { id: 'math-sqrt', icon: '√', label: 'Square root \\sqrt{sel}', run: () => wrapMath('\\sqrt{', '}') },
      { id: 'math-parens', icon: '( )', label: 'Auto-sized \\left( sel \\right)', run: () => wrapMath('\\left( ', ' \\right)') },
      { id: 'math-bf', icon: 'bf', label: 'Bold vector \\mathbf{sel}', run: () => wrapMath('\\mathbf{', '}') },
      { id: 'math-cal', icon: '𝒜', label: 'Calligraphic \\mathcal{sel}', run: () => wrapMath('\\mathcal{', '}') },
      { id: 'math-text', icon: 'txt', label: 'Upright prose \\text{sel}', run: () => wrapMath('\\text{', '}') },
      { id: 'math-boxed', icon: '□', label: 'Boxed \\boxed{sel}', run: () => wrapMath('\\boxed{', '}') },
    ];
  }

  // ---- Lifecycle hooks ----------------------------------------------------------------
  function handleInput() {
    syncTabStopsOnInput();
    detectAutocomplete();
    queueMathPeek();
    queueOutline();
  }

  function handleSelection() {
    if (acState) detectAutocomplete();
    queueMathPeek();
  }

  function handleBlur() {
    closeAc();
    peekEl.hidden = true;
  }

  function closePopups() {
    closeAc();
    peekEl.hidden = true;
  }

  signal.addEventListener('abort', () => {
    clearTimeout(peekTimer);
    clearTimeout(outlineTimer);
    acEl.remove();
    peekEl.remove();
  });

  return {
    handleKeydown,
    handleInput,
    handleSelection,
    handleBlur,
    isInMath: (pos = ta.selectionStart) => !!findMathContext(ta.value, pos),
    getMathBubbleActions,
    setDiagnostics,
    togglePalette,
    toggleOutline,
    toggleBibMacros,
    openMatrixBuilder,
    openTexExport,
    closePopups,
  };
}
