/**
 * Exports a Markdown + LaTeX blog post to a clean, compilable arXiv-ready
 * LaTeX document (`paper.tex`) and standalone BibTeX (`references.bib`).
 */
import { parseBibTeX, parseLatexPreamble } from '../../plugins/latex-core.mjs';

export type ExportVenue = 'arxiv' | 'neurips' | 'icml' | 'iclr';

export interface LatexExportDoc {
  title: string;
  subtitle?: string;
  description?: string;
  date?: string;
  author?: string;
  affiliation?: string;
  slug?: string;
  body: string;
  macros?: string;
  bibliography?: string;
  citationStyle?: '' | 'numeric' | 'author-year';
  globalMacros?: Record<string, string>;
  venue?: ExportVenue;
  bundleMode?: boolean;
}

export interface LatexExportResult {
  tex: string;
  bib: string;
  assets: string[];
  warnings: string[];
}

type PreambleEntry = { name: string; args: number; body: string; kind: 'command' | 'operator' | 'operator*' };

const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*',
  'multline', 'multline*', 'flalign', 'flalign*', 'alignat', 'alignat*',
  'subequations', 'eqnarray', 'eqnarray*',
]);

const PROSE_ENVS = new Set([
  'finding', 'hypothesis', 'experiment', 'takeaway',
  'theorem', 'lemma', 'proposition', 'corollary', 'definition',
  'assumption', 'example', 'remark', 'proof', 'algorithm',
]);

function escLatexText(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function escProseChars(s: string): string {
  // Escape plain-text LaTeX specials (leave existing backslashes alone because
  // commands & math have already been hoisted into placeholders).
  return s
    .replace(/(^|[^\\])([&%#_])/g, '$1\\$2')
    .replace(/~/g, '\\textasciitilde{}');
}

function escUrl(url: string): string {
  return url.replace(/([%#{}])/g, '\\$1');
}

function countMacroArgs(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/#([1-9])/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

function unwrapOperatorBody(body: string): string {
  const m = body.trim().match(/^\\operatorname\*?\{([\s\S]*)\}$/);
  return m ? m[1] : body;
}

function formatMacroDef(entry: PreambleEntry): string {
  if (entry.kind === 'operator*') return `\\DeclareMathOperator*{${entry.name}}{${unwrapOperatorBody(entry.body)}}`;
  if (entry.kind === 'operator') return `\\DeclareMathOperator{${entry.name}}{${unwrapOperatorBody(entry.body)}}`;
  const args = entry.args > 0 ? `[${entry.args}]` : '';
  return `\\providecommand{${entry.name}}${args}{${entry.body}}`;
}

/** Extract standalone preamble lines outside fenced code blocks. */
function stripInlinePreamble(src: string): { body: string; preamble: string } {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const pre: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm) {
      if (!fence) fence = fm[1][0].repeat(fm[1].length);
      else if (line.trim().startsWith(fence[0].repeat(fence.length))) fence = null;
      out.push(line);
      continue;
    }
    if (!fence && /^\s*\\(?:(?:re|provide)?newcommand\*?|DeclareMathOperator\*?)\b/.test(line)) {
      pre.push(line.trim());
      continue;
    }
    out.push(line);
  }
  return { body: out.join('\n'), preamble: pre.join('\n') };
}

/** Extract inline ```bibtex blocks and return remaining body + combined bib string. */
function extractBibBlocks(body: string, frontmatterBib: string): { body: string; bib: string } {
  const bibParts: string[] = [];
  if (frontmatterBib.trim()) bibParts.push(frontmatterBib.trim());

  const cleaned = body.replace(/^([ \t]*)(`{3,}|~{3,})bibtex[^\n]*\n([\s\S]*?)^\1\2[ \t]*$/gm, (_m, _ind, _f, content) => {
    const trimmed = String(content).trim();
    if (trimmed) bibParts.push(trimmed);
    return '';
  });

  return { body: cleaned, bib: bibParts.join('\n\n') };
}

/** Collect footnote definitions `[^id]: text` (including indented continuations). */
function extractFootnotes(body: string): { body: string; footnotes: Map<string, string> } {
  const footnotes = new Map<string, string>();
  const lines = body.split('\n');
  const out: string[] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm) {
      if (!fence) fence = fm[1][0].repeat(fm[1].length);
      else if (line.trim().startsWith(fence[0].repeat(fence.length))) fence = null;
      out.push(line);
      continue;
    }
    if (!fence) {
      const m = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
      if (m) {
        const parts = [m[2].trim()];
        while (i + 1 < lines.length && /^(?: {2,}|\t)\S/.test(lines[i + 1])) {
          i++;
          parts.push(lines[i].trim());
        }
        footnotes.set(m[1], parts.join(' '));
        continue;
      }
    }
    out.push(line);
  }
  return { body: out.join('\n'), footnotes };
}

/** Convert inline Markdown while preserving math, LaTeX commands, and citations verbatim. */
function convertInline(text: string, footnotes: Map<string, string>, citeCmd: string): string {
  const stash: string[] = [];
  const hold = (val: string) => {
    const id = stash.length;
    stash.push(val);
    return `\uE000${id}\uE001`;
  };

  let s = text;

  // 1. Protect inline math: \(...\), $...$
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (m) => hold(m));
  s = s.replace(/(?<!\\)\$(?!\$)((?:\\.|[^$\\])+?)(?<!\\)\$/g, (m) => hold(m));

  // 2. Protect inline code `...`
  s = s.replace(/(`+)([^`]+?)\1/g, (_m, _t, code) => hold(`\\texttt{${escLatexText(code)}}`));

  // 3. Protect explicit LaTeX commands with args (\cite, \eqref, \ref, \cref, \label, \url, \href, \emph, \textbf, etc.)
  s = s.replace(/\\(?:cite[pt]?|nocite|eqref|ref|cref|Cref|label|pageref|autoref|url|href|text[a-z]+|emph)\*?(?:\[[^\]]*\])*(?:\{[^{}]*\})+/g, (m) => hold(m));
  // Protect remaining single LaTeX commands (e.g. \LaTeX, \TeX, \alpha)
  s = s.replace(/\\[A-Za-z@]+\*?/g, (m) => hold(m));

  // 4. Pandoc citations [@key] or [@k1; @k2]
  s = s.replace(/\[@([^\]]+)\]/g, (_m, inner: string) => {
    const keys = inner
      .split(/[;,]/)
      .map((k) => k.trim().replace(/^@/, ''))
      .filter(Boolean);
    return keys.length ? hold(`${citeCmd}{${keys.join(', ')}}`) : _m;
  });

  // 5. Footnote markers [^id]
  s = s.replace(/\[\^([^\]]+)\]/g, (_m, id: string) => {
    const note = footnotes.get(id);
    if (!note) return '';
    return hold(`\\footnote{${convertInline(note, footnotes, citeCmd)}}`);
  });

  // 6. Inline images ![alt](src)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, _alt: string, src: string) =>
    hold(`\\includegraphics[width=0.8\\linewidth]{${escUrl(src)}}`),
  );

  // 7. Markdown links [label](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) =>
    hold(`\\href{${escUrl(url)}}{${convertInline(label, footnotes, citeCmd)}}`),
  );

  // 8. Wiki links [[slug|label]] or [[slug]]
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, slug: string, label?: string) =>
    hold(`\\textit{${escLatexText((label || slug).trim())}}`),
  );

  // 9. Bold + italic, bold, italic, strikethrough
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, (_m, inner: string) => hold(`\\textbf{\\textit{${escProseChars(inner)}}}`));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => hold(`\\textbf{${escProseChars(inner)}}`));
  s = s.replace(/(^|[^\w\\])\*([^*\n]+)\*(?!\*)/g, (_m, pre: string, inner: string) => `${pre}${hold(`\\textit{${escProseChars(inner)}}`)}`);
  s = s.replace(/~~([^~]+)~~/g, (_m, inner: string) => hold(escProseChars(inner)));

  // 10. Escape remaining plain prose characters
  s = escProseChars(s);

  // 11. Restore placeholders (iterate in case nested)
  for (let pass = 0; pass < 4 && s.includes('\uE000'); pass++) {
    s = s.replace(/\uE000(\d+)\uE001/g, (_m, idx) => stash[Number(idx)] ?? '');
  }
  return s;
}

/** Convert a display math block (`$$...$$` or `\[...\]`) into clean arXiv LaTeX. */
function formatDisplayMath(inner: string): string {
  const trimmed = inner.trim();
  // Already wrapped in a top-level math environment like \begin{align}...\end{align}
  const envMatch = trimmed.match(/^\\begin\{([a-zA-Z*]+)\}[\s\S]*\\end\{\1\}$/);
  if (envMatch && MATH_ENVS.has(envMatch[1])) {
    return trimmed;
  }
  if (/\\label\{[^}]+\}/.test(trimmed)) {
    return `\\begin{equation}\n${trimmed}\n\\end{equation}`;
  }
  return `\\[\n${trimmed}\n\\]`;
}

/** Convert an algorithm environment body into clean algorithmic LaTeX if not already using algorithmic. */
function formatAlgorithmEnv(title: string, body: string, footnotes: Map<string, string>, citeCmd: string): string {
  if (/\\begin\{algorithmic\}/.test(body)) {
    const cap = title ? `\\caption{${convertInline(title, footnotes, citeCmd)}}\n` : '';
    return `\\begin{algorithm}[htbp]\n${cap}${body.trim()}\n\\end{algorithm}`;
  }
  let label = '';
  const cleanedLines: string[] = [];
  for (const raw of body.split('\n')) {
    const lm = raw.match(/^\s*\\label\{([^}]+)\}\s*$/);
    if (lm) {
      label = lm[1];
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    cleanedLines.push(line.replace(/^\d+[.)]\s+/, ''));
  }
  const out = ['\\begin{algorithm}[htbp]'];
  if (title) out.push(`\\caption{${convertInline(title, footnotes, citeCmd)}}`);
  if (label) out.push(`\\label{${label}}`);
  out.push('\\begin{algorithmic}[1]');
  for (const line of cleanedLines) {
    if (/^(?:Input|Require):/i.test(line)) {
      out.push(`\\Require ${convertInline(line.replace(/^(?:Input|Require):\s*/i, ''), footnotes, citeCmd)}`);
    } else if (/^(?:Output|Ensure):/i.test(line)) {
      out.push(`\\Ensure ${convertInline(line.replace(/^(?:Output|Ensure):\s*/i, ''), footnotes, citeCmd)}`);
    } else {
      out.push(`\\State ${convertInline(line, footnotes, citeCmd)}`);
    }
  }
  out.push('\\end{algorithmic}');
  out.push('\\end{algorithm}');
  return out.join('\n');
}

/** Convert a Markdown pipe table to booktabs LaTeX. */
function convertTable(tableLines: string[], footnotes: Map<string, string>, citeCmd: string): string {
  const splitRow = (row: string) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  const header = splitRow(tableLines[0]);
  const alignRow = splitRow(tableLines[1]);
  const colSpec = alignRow
    .map((cell) => {
      const l = cell.startsWith(':');
      const r = cell.endsWith(':');
      if (l && r) return 'c';
      if (r) return 'r';
      return 'l';
    })
    .join('');

  const rows = tableLines.slice(2).map(splitRow);
  const fmtCell = (c: string) => convertInline(c, footnotes, citeCmd).replace(/±/g, '$\\pm$').replace(/↑/g, '$\\uparrow$').replace(/↓/g, '$\\downarrow$');
  const fmt = (cells: string[]) => cells.map(fmtCell).join(' & ') + ' \\\\';

  return [
    '\\begin{table}[t]',
    '\\centering',
    `\\begin{tabular}{${colSpec || 'l'.repeat(header.length)}}`,
    '\\toprule',
    fmt(header),
    '\\midrule',
    ...rows.map(fmt),
    '\\bottomrule',
    '\\end{tabular}',
    '\\end{table}',
  ].join('\n');
}

type ConvertCtx = {
  assets: string[];
  warnings: string[];
  bundleMode: boolean;
  tldrAbstract: string;
};

function rewriteAssetPath(rawPath: string, ctx: ConvertCtx): string {
  const clean = rawPath.trim();
  const isLocal = /^\/(?:images|api\/media)\//i.test(clean);
  if (isLocal) {
    if (!ctx.assets.includes(clean)) ctx.assets.push(clean);
    if (/\.(?:gif|webp|svg)$/i.test(clean)) {
      ctx.warnings.push(`Image "${clean.split('/').pop()}" is ${clean.split('.').pop()?.toUpperCase()}: pdflatex/arXiv prefers PNG or PDF.`);
    }
    if (ctx.bundleMode) {
      const file = clean.split('/').pop() ?? 'figure.png';
      return `figures/${file}`;
    }
  }
  return clean;
}

function convertBody(body: string, footnotes: Map<string, string>, citeCmd: string, ctx: ConvertCtx): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      i++;
      continue;
    }

    // 1. Fenced code blocks (```lang ... ```)
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})([^\s`~]*)(.*)$/);
    if (fenceMatch) {
      const fChar = fenceMatch[1][0];
      const fLen = fenceMatch[1].length;
      const lang = fenceMatch[2].toLowerCase();
      const meta = fenceMatch[3].trim();
      const blockLines: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fChar}{${fLen},}\\s*$`).test(lines[i])) {
        blockLines.push(lines[i]);
        i++;
      }
      i++; // skip closer
      if (lang === 'bibtex') continue;
      if (lang === 'chart' || lang === 'diagram' || lang === 'figure') {
        const capMatch = blockLines.join('\n').match(/^caption:\s*(.+)$/m);
        const idMatch = meta.match(/\bid=([a-z0-9_-]+)/i);
        const cap = capMatch ? capMatch[1].replace(/^["']|["']$/g, '') : `${lang} figure`;
        ctx.warnings.push(`Interactive \`\`\`${lang} block ("${cap}") exported as a placeholder — attach a static PNG/PDF for arXiv.`);
        out.push(
          [
            '\\begin{figure}[t]',
            '\\centering',
            `% TODO: replace with exported vector graphic for ${lang}${idMatch ? ` (${idMatch[1]})` : ''}`,
            `\\fbox{\\parbox{0.85\\linewidth}{\\centering\\vspace{1.5em}\\textit{[${escLatexText(cap)}]}\\vspace{1.5em}}}`,
            `\\caption{${convertInline(cap, footnotes, citeCmd)}}`,
            ...(idMatch ? [`\\label{fig:${idMatch[1]}}`] : []),
            '\\end{figure}',
          ].join('\n'),
        );
      } else if (lang) {
        out.push(`\\begin{lstlisting}[language=${lang}]\n${blockLines.join('\n')}\n\\end{lstlisting}`);
      } else {
        out.push(`\\begin{verbatim}\n${blockLines.join('\n')}\n\\end{verbatim}`);
      }
      continue;
    }

    // 2. Display math $$...$$
    if (trimmed.startsWith('$$')) {
      if (trimmed.length > 4 && trimmed.endsWith('$$')) {
        out.push(formatDisplayMath(trimmed.slice(2, -2)));
        i++;
        continue;
      }
      const mathLines: string[] = [trimmed.slice(2)];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith('$$')) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        mathLines.push(lines[i].trim().slice(0, -2));
        i++;
      }
      out.push(formatDisplayMath(mathLines.join('\n')));
      continue;
    }

    // 3. Display math \[...\]
    if (trimmed.startsWith('\\[')) {
      if (trimmed.endsWith('\\]') && trimmed.length >= 4) {
        out.push(formatDisplayMath(trimmed.slice(2, -2)));
        i++;
        continue;
      }
      const mathLines: string[] = [trimmed.slice(2)];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith('\\]')) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        mathLines.push(lines[i].trim().slice(0, -2));
        i++;
      }
      out.push(formatDisplayMath(mathLines.join('\n')));
      continue;
    }

    // 4. Bare LaTeX environments \begin{env}...\end{env}
    const beginMatch = trimmed.match(/^\\begin\{([a-zA-Z*]+)\}(?:\[([^\]]*)\])?(.*)$/);
    if (beginMatch && (MATH_ENVS.has(beginMatch[1]) || PROSE_ENVS.has(beginMatch[1]))) {
      const env = beginMatch[1];
      const optTitle = beginMatch[2] ?? '';
      const restFirst = beginMatch[3] ?? '';
      const escapedEnv = env.replace(/\*/g, '\\*');
      const endRe = new RegExp(`\\\\end\\{${escapedEnv}\\}\\s*$`);
      if (endRe.test(trimmed)) {
        if (MATH_ENVS.has(env)) {
          out.push(trimmed);
        } else {
          const inner = restFirst.replace(endRe, '').trim();
          if (env === 'algorithm') out.push(formatAlgorithmEnv(optTitle, inner, footnotes, citeCmd));
          else out.push(`\\begin{${env}}${optTitle ? `[${convertInline(optTitle, footnotes, citeCmd)}]` : ''}\n${convertBody(inner, footnotes, citeCmd, ctx)}\n\\end{${env}}`);
        }
        i++;
        continue;
      }
      const innerLines: string[] = restFirst.trim() ? [restFirst] : [];
      i++;
      let depth = 1;
      const beginRe = new RegExp(`\\\\begin\\{${escapedEnv}\\}`);
      while (i < lines.length) {
        if (beginRe.test(lines[i])) depth++;
        if (endRe.test(lines[i].trim())) {
          depth--;
          if (depth === 0) {
            const beforeEnd = lines[i].replace(endRe, '').trim();
            if (beforeEnd) innerLines.push(beforeEnd);
            i++;
            break;
          }
        }
        innerLines.push(lines[i]);
        i++;
      }
      const inner = innerLines.join('\n');
      if (MATH_ENVS.has(env)) {
        out.push(`\\begin{${env}}\n${inner}\n\\end{${env}}`);
      } else if (env === 'algorithm') {
        out.push(formatAlgorithmEnv(optTitle, inner, footnotes, citeCmd));
      } else {
        // Keep \label{...} lines verbatim inside theorem-like environments
        const converted = convertBody(inner, footnotes, citeCmd, ctx);
        const titleOpt = optTitle ? `[${convertInline(optTitle, footnotes, citeCmd)}]` : '';
        out.push(`\\begin{${env}}${titleOpt}\n${converted}\n\\end{${env}}`);
      }
      continue;
    }

    // 5. Fenced theorem/algorithm directives :::theorem[Title]{#thm:foo} ... :::
    const fencedEnv = trimmed.match(/^:::([a-zA-Z]+)(?:\[([^\]]*)\])?(?:\{#([^}]+)\})?\s*$/);
    if (fencedEnv && PROSE_ENVS.has(fencedEnv[1].toLowerCase())) {
      const env = fencedEnv[1].toLowerCase();
      const optTitle = fencedEnv[2] ?? '';
      const label = fencedEnv[3] ?? '';
      const innerLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) {
        innerLines.push(lines[i]);
        i++;
      }
      i++; // skip :::
      const inner = (label ? `\\label{${label}}\n` : '') + innerLines.join('\n');
      if (env === 'algorithm') {
        out.push(formatAlgorithmEnv(optTitle, inner, footnotes, citeCmd));
      } else {
        const titleOpt = optTitle ? `[${convertInline(optTitle, footnotes, citeCmd)}]` : '';
        out.push(`\\begin{${env}}${titleOpt}\n${convertBody(inner, footnotes, citeCmd, ctx)}\n\\end{${env}}`);
      }
      continue;
    }

    // 6. Standalone \label{...} line (inside theorems etc.)
    if (/^\\label\{[^}]+\}$/.test(trimmed)) {
      out.push(trimmed);
      i++;
      continue;
    }

    // 7. Headings (#, ##, ###, ####, #####)
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const rawText = headingMatch[2];
      const idMatch = rawText.match(/\s*\{#([^}]+)\}\s*$/);
      const text = convertInline(idMatch ? rawText.slice(0, idMatch.index) : rawText, footnotes, citeCmd);
      const cmd = level <= 2 ? '\\section' : level === 3 ? '\\subsection' : level === 4 ? '\\subsubsection' : '\\paragraph';
      out.push(`${cmd}{${text}}${idMatch ? `\n\\label{${idMatch[1]}}` : ''}`);
      i++;
      continue;
    }

    // 8. Horizontal rule
    if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
      out.push('\\bigskip\\hrule\\bigskip');
      i++;
      continue;
    }

    // 9. Standalone image paragraph ![alt](src "title")
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
    if (imgMatch) {
      const cap = (imgMatch[3] || imgMatch[1]).replace(/\s*\{w=\d+%\}\s*$/, '').trim();
      const imgPath = rewriteAssetPath(imgMatch[2], ctx);
      out.push(
        [
          '\\begin{figure}[t]',
          '\\centering',
          `\\includegraphics[width=0.85\\linewidth]{${escUrl(imgPath)}}`,
          ...(cap ? [`\\caption{${convertInline(cap, footnotes, citeCmd)}}`] : []),
          '\\end{figure}',
        ].join('\n'),
      );
      i++;
      continue;
    }

    // 10. Markdown pipe table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const tableLines: string[] = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      out.push(convertTable(tableLines, footnotes, citeCmd));
      continue;
    }

    // 11. Blockquotes & callouts (> [!TLDR] ...)
    if (/^\s*>\s?/.test(line)) {
      const qLines: string[] = [];
      let calloutKind = '';
      let calloutTitle = '';
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        const inner = lines[i].replace(/^\s*>\s?/, '');
        const cm = qLines.length === 0 ? inner.match(/^\[!([A-Z]+)\]\s*(.*)$/) : null;
        if (cm) {
          calloutKind = cm[1].toUpperCase();
          calloutTitle = cm[2].trim() || cm[1];
        } else {
          qLines.push(inner);
        }
        i++;
      }
      const qBody = convertBody(qLines.join('\n'), footnotes, citeCmd, ctx);
      if (calloutKind === 'TLDR' && !ctx.tldrAbstract && qBody.trim()) {
        ctx.tldrAbstract = qBody.trim();
        continue;
      }
      out.push(
        calloutTitle
          ? `\\begin{quote}\n\\textbf{${escLatexText(calloutTitle)}.} ${qBody}\n\\end{quote}`
          : `\\begin{quote}\n${qBody}\n\\end{quote}`,
      );
      continue;
    }

    // 12. Unordered lists
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*[-*+]\s+/, '');
        items.push(`  \\item ${convertInline(itemText, footnotes, citeCmd)}`);
        i++;
      }
      out.push(`\\begin{itemize}\n${items.join('\n')}\n\\end{itemize}`);
      continue;
    }

    // 13. Ordered lists
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*\d+[.)]\s+/, '');
        items.push(`  \\item ${convertInline(itemText, footnotes, citeCmd)}`);
        i++;
      }
      out.push(`\\begin{enumerate}\n${items.join('\n')}\n\\end{enumerate}`);
      continue;
    }

    // 14. Standard paragraph (accumulate until blank line or block starter)
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(?:#{1,6}\s|`{3,}|~{3,}|>\s?|\$\$|\\\[|\\begin\{|:::|[-*+]\s+|\d+[.)]\s+)/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(convertInline(paraLines.join('\n'), footnotes, citeCmd));
  }

  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function exportArxivLatex(doc: LatexExportDoc): LatexExportResult {
  const venue: ExportVenue = doc.venue ?? 'arxiv';
  const ctx: ConvertCtx = {
    assets: [],
    warnings: [],
    bundleMode: doc.bundleMode === true,
    tldrAbstract: '',
  };

  const { body: withoutBib, bib } = extractBibBlocks(doc.body || '', doc.bibliography || '');
  const { body: withoutPreamble, preamble: inlinePreamble } = stripInlinePreamble(withoutBib);
  const { body: cleanBody, footnotes } = extractFootnotes(withoutPreamble);

  const bibEntries = bib.trim() ? (parseBibTeX(bib) as Array<{ key: string }>) : [];
  const bibKeySet = new Set(bibEntries.map((b) => b.key));
  const hasBib = bibEntries.length > 0 || bib.trim().length > 0;
  const authorYear = doc.citationStyle === 'author-year' || venue === 'icml' || venue === 'iclr';
  const citeCmd = authorYear ? '\\citep' : '\\cite';

  // Collect macros: post + inline (always emit), plus any global macros referenced
  const postParsed = parseLatexPreamble(doc.macros || '') as { macros: Record<string, string>; entries: PreambleEntry[] };
  const inlineParsed = parseLatexPreamble(inlinePreamble) as { macros: Record<string, string>; entries: PreambleEntry[] };
  const explicitEntries = new Map<string, PreambleEntry>();
  for (const e of [...postParsed.entries, ...inlineParsed.entries]) {
    explicitEntries.set(e.name, e);
  }

  const globalMap = doc.globalMacros ?? {};
  const macroDefs: string[] = [];
  const scanPool = [cleanBody, ...[...explicitEntries.values()].map((e) => e.body)].join('\n');
  const usedGlobals = new Set<string>();
  let changed = true;
  let searchText = scanPool;
  while (changed) {
    changed = false;
    for (const [name, body] of Object.entries(globalMap)) {
      if (usedGlobals.has(name) || explicitEntries.has(name)) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`${escaped}(?![A-Za-z@])`);
      if (re.test(searchText)) {
        usedGlobals.add(name);
        searchText += '\n' + body;
        changed = true;
      }
    }
  }

  for (const name of usedGlobals) {
    const body = globalMap[name];
    macroDefs.push(formatMacroDef({ name, args: countMacroArgs(body), body, kind: 'command' }));
  }
  for (const entry of explicitEntries.values()) {
    macroDefs.push(formatMacroDef(entry));
  }

  const convertedBody = convertBody(cleanBody, footnotes, citeCmd, ctx);
  const descAbstract = doc.description?.trim() ? convertInline(doc.description.trim(), footnotes, citeCmd) : '';
  const convertedAbstract = ctx.tldrAbstract || descAbstract;
  if (!convertedAbstract) {
    ctx.warnings.push('No abstract found — add a description in [ details ] or a > [!TLDR] callout.');
  }

  // Pre-flight checks: undefined \cite keys and \ref/\eqref/\cref labels
  const definedLabels = new Set([...convertedBody.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1].trim()));
  for (const m of convertedBody.matchAll(/\\(?:eq|c|C)?ref\{([^}]+)\}/g)) {
    for (const lbl of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!definedLabels.has(lbl)) ctx.warnings.push(`Undefined reference \\ref{${lbl}}.`);
    }
  }
  for (const m of `${convertedAbstract}\n${convertedBody}`.matchAll(/\\cite[pt]?\{([^}]+)\}/g)) {
    for (const key of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!bibKeySet.has(key)) ctx.warnings.push(`Undefined citation key "${key}" (add it in [ bib ]).`);
    }
  }

  const needsListings = /\\begin\{lstlisting\}/.test(convertedBody);
  const usesNatbibCmds = /\\cite[pt]\b/.test(`${convertedAbstract}\n${convertedBody}`);
  const usesAlgo = /\\begin\{algorithm\}/.test(convertedBody);

  const titleText = escLatexText(doc.title?.trim() || doc.slug || 'Untitled');
  const subtitleText = doc.subtitle?.trim() ? ` \\\\\n  \\large ${escLatexText(doc.subtitle.trim())}` : '';
  const authorLine = doc.author?.trim()
    ? escLatexText(doc.author.trim()) + (doc.affiliation?.trim() ? ` \\\\\n  \\small ${escLatexText(doc.affiliation.trim())}` : '')
    : '';

  const envDefs: string[] = [
    '% ML & research environments',
    '\\newtheorem{finding}{Finding}',
    '\\newtheorem{hypothesis}{Hypothesis}',
    '\\newtheorem{theorem}{Theorem}',
    '\\newtheorem{lemma}{Lemma}',
    '\\newtheorem{proposition}{Proposition}',
    '\\newtheorem{corollary}{Corollary}',
    '\\theoremstyle{definition}',
    '\\newtheorem{experiment}{Experiment}',
    '\\newtheorem{definition}{Definition}',
    '\\newtheorem{assumption}{Assumption}',
    '\\newtheorem{example}{Example}',
    '\\theoremstyle{remark}',
    '\\newtheorem{remark}{Remark}',
    '\\newenvironment{takeaway}[1][Takeaway]{\\begin{quote}\\textbf{#1.} }{\\end{quote}}',
  ];

  const venueHeader: Record<ExportVenue, string[]> = {
    arxiv: [
      '% Exported from heartcache /write — arXiv preprint (pdflatex / Overleaf ready)',
      '\\documentclass[11pt]{article}',
      '',
      '\\usepackage[margin=1in]{geometry}',
      '\\usepackage[T1]{fontenc}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{microtype}',
    ],
    neurips: [
      '% Exported from heartcache /write — NeurIPS preprint template',
      '% Add neurips_2025.sty to your Overleaf / arXiv folder (or swap for geometry for standalone compile)',
      '\\documentclass{article}',
      '\\usepackage[preprint]{neurips_2025}',
      '\\usepackage[T1]{fontenc}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{microtype}',
    ],
    icml: [
      '% Exported from heartcache /write — ICML template',
      '% Add icml2025.sty to your Overleaf / arXiv folder',
      '\\documentclass{article}',
      '\\usepackage{icml2025}',
      '\\usepackage[T1]{fontenc}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{microtype}',
    ],
    iclr: [
      '% Exported from heartcache /write — ICLR template',
      '% Add iclr2025_conference.sty to your Overleaf / arXiv folder',
      '\\documentclass{article}',
      '\\usepackage{iclr2025_conference,times}',
      '\\usepackage[T1]{fontenc}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{microtype}',
    ],
  };

  const preamble: string[] = [
    ...venueHeader[venue],
    '\\usepackage{amsmath, amssymb, amsthm, mathtools}',
    '\\usepackage{graphicx}',
    '\\usepackage{booktabs}',
    ...(usesAlgo ? ['\\usepackage{algorithm}', '\\usepackage{algpseudocode}'] : []),
    '\\usepackage{xcolor}',
    ...(needsListings ? ['\\usepackage{listings}', '\\lstset{basicstyle=\\ttfamily\\small, breaklines=true, frame=single}'] : []),
    ...(hasBib && authorYear ? ['\\usepackage[round]{natbib}'] : hasBib && usesNatbibCmds ? ['\\usepackage[numbers]{natbib}'] : []),
    '\\usepackage[colorlinks=true, linkcolor=blue, citecolor=blue, urlcolor=blue]{hyperref}',
    '\\usepackage[nameinlink, capitalize]{cleveref}',
    '',
    ...envDefs,
  ];

  if (macroDefs.length) {
    preamble.push('', '% Custom macros', ...macroDefs);
  }

  preamble.push(
    '',
    `\\title{${titleText}${subtitleText}}`,
    `\\author{${authorLine}}`,
    `\\date{${doc.date?.trim() ? escLatexText(doc.date.trim()) : '\\today'}}`,
    '',
    '\\begin{document}',
    '\\maketitle',
  );

  const docParts: string[] = [preamble.join('\n')];

  if (convertedAbstract) {
    docParts.push(`\\begin{abstract}\n${convertedAbstract}\n\\end{abstract}`);
  }

  docParts.push(convertedBody);

  if (hasBib) {
    const bibStyle = venue === 'iclr' ? 'iclr2025_conference' : venue === 'icml' ? 'icml2025' : authorYear ? 'plainnat' : 'plain';
    docParts.push(
      [
        `\\bibliographystyle{${bibStyle}}`,
        '\\bibliography{references}',
      ].join('\n'),
    );
  }

  docParts.push('\\end{document}\n');

  return {
    tex: docParts.filter(Boolean).join('\n\n'),
    bib: bib.trim() ? `${bib.trim()}\n` : '',
    assets: ctx.assets,
    warnings: ctx.warnings,
  };
}
