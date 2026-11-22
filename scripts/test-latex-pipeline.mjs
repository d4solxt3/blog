// Unit tests for the arXiv-tier Markdown + LaTeX rendering pipeline.
// Run with: node scripts/test-latex-pipeline.mjs
import assert from 'node:assert/strict';
import {
  DEFAULT_LATEX_MACROS,
  formatAuthorsFull,
  formatAuthorsShort,
  formatCitationLabel,
  friendlyKatexHint,
  parseBibTeX,
  parseLatexPreamble,
  safeAnchorId,
} from '../plugins/latex-core.mjs';
import {
  renderLiveArticle,
  renderPreview,
  renderStudioPreview,
  renderStudioPreviewFull,
} from '../plugins/preview.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err?.stack ?? err}`);
  }
}

console.log('\n[1/7] latex-core.mjs unit tests');

await test('DEFAULT_LATEX_MACROS exports all required macros', () => {
  const required = [
    '\\R', '\\N', '\\Z', '\\C', '\\E', '\\Prob', '\\Var', '\\Cov', '\\KL',
    '\\argmax', '\\argmin', '\\norm', '\\abs', '\\inner', '\\dd', '\\eps', '\\T', '\\ind',
  ];
  for (const k of required) {
    assert.equal(typeof DEFAULT_LATEX_MACROS[k], 'string', `missing ${k}`);
  }
  assert.equal(DEFAULT_LATEX_MACROS['\\inner'], '\\left\\langle #1, #2 \\right\\rangle');
});

await test('parseLatexPreamble handles nested braces, bare names, renewcommand, DeclareMathOperator', () => {
  const src = `
    % comment line
    \\newcommand{\\loss}[2]{\\mathcal{L}_{\\text{#1}}\\left(#2\\right)}
    \\newcommand\\Q{\\mathbb{Q}}
    \\renewcommand{\\eps}{\\epsilon}
    \\providecommand{\\set}[1]{\\{ #1 \\}}
    \\DeclareMathOperator{\\tr}{tr}
    \\DeclareMathOperator*{\\esssup}{ess\\,sup}
  `;
  const { macros, entries } = parseLatexPreamble(src);
  assert.equal(macros['\\loss'], '\\mathcal{L}_{\\text{#1}}\\left(#2\\right)');
  assert.equal(macros['\\Q'], '\\mathbb{Q}');
  assert.equal(macros['\\eps'], '\\epsilon');
  assert.equal(macros['\\set'], '\\{ #1 \\}');
  assert.equal(macros['\\tr'], '\\operatorname{tr}');
  assert.equal(macros['\\esssup'], '\\operatorname*{ess\\,sup}');
  assert.equal(entries.length, 6);
  assert.equal(entries[0].args, 2);
  assert.equal(entries[4].kind, 'operator');
  assert.equal(entries[5].kind, 'operator*');
});

await test('parseBibTeX handles nested braces, diacritics, # concat, and author forms', () => {
  const bib = `
    @string{neurips = "Advances in Neural Information Processing Systems"}
    @inproceedings{vaswani2017,
      title = {{Attention Is All You Need} -- A {Transformer} Study},
      author = {Vaswani, Ashish and Noam Shazeer and Niki Parmar},
      booktitle = neurips # " (NeurIPS)",
      year = 2017,
      eprint = {1706.03762}
    }
    @article{muller2020,
      title = "L\\'{e}vy Processes and G\\"{o}del's {\\c{c}}a va \\~n \\\`a",
      author = {M\\"{u}ller, Klaus and Fran\\c{c}ois Garc\\'ia},
      journal = {Journal of Math},
      year = {2020},
      doi = {10.1000/xyz123}
    }
  `;
  const entries = parseBibTeX(bib);
  assert.equal(entries.length, 2);
  const [v, m] = entries;
  assert.equal(v.key, 'vaswani2017');
  assert.equal(v.title, 'Attention Is All You Need – A Transformer Study');
  assert.equal(v.venue, 'Advances in Neural Information Processing Systems (NeurIPS)');
  assert.equal(v.year, '2017');
  assert.equal(v.authors.length, 3);
  assert.deepEqual(v.authors[0], { first: 'Ashish', last: 'Vaswani' });
  assert.deepEqual(v.authors[1], { first: 'Noam', last: 'Shazeer' });
  assert.equal(formatAuthorsShort(v.authors), 'Vaswani et al.');
  assert.equal(formatAuthorsFull(v.authors), 'Ashish Vaswani, Noam Shazeer, & Niki Parmar');
  assert.equal(formatCitationLabel(v, 0, 'numeric'), '[1]');
  assert.equal(formatCitationLabel(v, 0, 'author-year'), '(Vaswani et al., 2017)');

  assert.equal(m.key, 'muller2020');
  assert.ok(m.title.includes('Lévy'), `expected Lévy in ${m.title}`);
  assert.ok(m.title.includes('Gödel'), `expected Gödel in ${m.title}`);
  assert.ok(m.title.includes('ça'), `expected ça in ${m.title}`);
  assert.ok(m.title.includes('ñ'), `expected ñ in ${m.title}`);
  assert.ok(m.title.includes('à'), `expected à in ${m.title}`);
  assert.equal(formatAuthorsShort(m.authors), 'Müller & García');
});

await test('safeAnchorId & friendlyKatexHint', () => {
  assert.equal(safeAnchorId('eq', 'eq:loss_fn'), 'eq-loss-fn');
  assert.equal(safeAnchorId('eq', 'attention'), 'eq-attention');
  assert.equal(safeAnchorId('ref', 'Vaswani_2017'), 'ref-vaswani-2017');
  assert.ok(friendlyKatexHint('KaTeX parse error: Undefined control sequence: \\bogus').includes('\\bogus'));
  assert.ok(friendlyKatexHint("KaTeX parse error: Expected '}', got 'EOF'", '\\frac{1}{2').includes('Unclosed'));
  assert.ok(friendlyKatexHint('KaTeX parse error: Misplaced &').includes('&'));
});

console.log('\n[2/7] Delimiters, bare environments, and code-fence safety');

await test('renders \\(...\\), \\[...\\], $$...$$, and skips code fences/inline code', async () => {
  const md = `
Inline \\(f'(x_i) + x_j\\) and $a_1 + a_2$.

\\[
\\sum_{i=1}^n x_i^2 = \\norm{x}_2^2
\\]

\`\`\`tex
\\(not_math\\)
\\begin{equation}
E = mc^2
\\end{equation}
\`\`\`

Inline code \`\\(also_not_math\\)\` stays literal.
`;
  const { html, diagnostics } = await renderStudioPreviewFull(md);
  assert.equal(diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`);
  assert.ok(html.includes('class="katex"'), 'expected rendered katex');
  assert.ok(html.includes('class="math-block"'), 'expected math-block wrapper');
  assert.ok(html.includes('math-block-inner'), 'expected math-block-inner');
  assert.ok(html.includes('data-raw-tex='), 'expected data-raw-tex');
  // Verify subscripts & primes were NOT mangled by CommonMark/smartypants
  assert.ok(!html.includes('<em>i'), 'underscore inside \\(...\\) must not become <em>');
  assert.ok(html.includes('also_not_math'), 'inline code preserved');
  assert.ok(html.includes('not_math'), 'code fence preserved');
});

await test('renders bare equation, equation*, align, align*, gather, multline, flalign, alignat', async () => {
  const md = `
\\begin{equation}
\\label{eq:first}
E = mc^2
\\end{equation}

\\begin{equation*}
a^2 + b^2 = c^2
\\end{equation*}

\\begin{align}
x_1 &= y_1 \\label{eq:al1} \\\\
x_2 &= y_2 \\nonumber
\\end{align}

\\begin{align*}
u &= v \\\\
w &= z
\\end{align*}

\\begin{gather}
\\label{eq:gath}
p + q = r
\\end{gather}

\\begin{multline}
\\label{eq:mult}
a + b + c \\\\
+ d + e
\\end{multline}

\\begin{flalign*}
f(x) &= g(x)
\\end{flalign*}

\\begin{alignat*}{2}
a &= 1 & b &= 2
\\end{alignat*}
`;
  const { html, diagnostics } = await renderStudioPreviewFull(md);
  assert.equal(diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`);
  assert.ok(html.includes('id="eq-first"'), 'eq:first anchor');
  assert.ok(html.includes('data-eq-num="1"'), 'eq 1');
  assert.ok(html.includes('id="eq-al1"'), 'eq:al1 anchor');
  assert.ok(html.includes('data-eq-num="2"'), 'eq 2 (second align row suppressed by \\nonumber)');
  assert.ok(html.includes('id="eq-gath"') && html.includes('data-eq-num="3"'), 'gather eq 3');
  assert.ok(html.includes('id="eq-mult"') && html.includes('data-eq-num="4"'), 'multline eq 4');
});

console.log('\n[3/7] Equation numbering, multi-row align, \\tag, and cross-references');

await test('resolves \\eqref, \\ref, \\cref, \\Cref across equations, theorems, algorithms, and figures', async () => {
  const md = `
\\begin{equation}
\\label{eq:kl}
\\KL(P \\| Q) = \\E_{x \\sim P}\\left[\\log \\frac{P(x)}{Q(x)}\\right]
\\end{equation}

$$
\\label{eq:tagcustom}
\\tag{*}
x \\in \\R^d
$$

\\begin{align}
a &= 1 \\label{eq:row1} \\\\
b &= 2 \\label{eq:row2}
\\end{align}

![Architecture](/images/arch.png "Model architecture {#fig:arch}")

See \\eqref{eq:kl}, \\cref{eq:kl}, \\Cref{eq:kl}, \\eqref{eq:tagcustom}, \\eqref{eq:row1}, \\eqref{eq:row2}, \\cref{fig:arch}, \\ref{fig:arch}, and \\ref{missing:lbl}.
`;
  const { html, diagnostics } = await renderStudioPreviewFull(md);
  assert.equal(diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`);
  assert.ok(html.includes('href="#eq-kl"'), 'link to eq:kl');
  assert.ok(html.includes('>Eq. (1)<'), '\\cref{eq:kl} -> Eq. (1)');
  assert.ok(html.includes('>Equation (1)<'), '\\Cref{eq:kl} -> Equation (1)');
  assert.ok(html.includes('>(*)<'), 'explicit \\tag{*}');
  assert.ok(html.includes('href="#eq-row1"') && html.includes('>(2)<'), 'align row 1 -> (2)');
  assert.ok(html.includes('href="#eq-row2"') && html.includes('>(3)<'), 'align row 2 -> (3)');
  assert.ok(html.includes('id="eq-row2"'), 'extra anchor for align row 2');
  assert.ok(html.includes('href="#fig-arch"') && html.includes('>Fig. 01<'), 'deferred \\cref{fig:arch} -> Fig. 01');
  assert.ok(html.includes('data-ref-kind="figure"') && html.includes('>01<'), 'deferred \\ref{fig:arch} -> 01');
  assert.ok(html.includes('latex-ref--missing') && html.includes('[?? missing:lbl]'), 'missing label badge');
});

console.log('\n[4/7] Theorem-like environments, proofs, and algorithm blocks');

await test('renders LaTeX and ::: fenced theorems, lemmas, proofs (QED), and algorithms with markdown + math', async () => {
  const md = `
\\begin{theorem}[Cauchy--Schwarz]
\\label{thm:cs}
For all $u, v \\in \\R^n$, **inner products** satisfy
\\[
\\abs{\\inner{u}{v}} \\le \\norm{u} \\norm{v}.
\\]
\\end{theorem}

\\begin{proof}
Consider $p(t) = \\norm{u + t v}^2 \\ge 0$ for all $t \\in \\R$.
\\end{proof}

:::lemma[Subadditivity]{#lem:sub}
For any $x, y \\in \\R^n$, $\\norm{x + y} \\le \\norm{x} + \\norm{y}$.
:::

:::algorithm[Gradient Descent]{#alg:gd}
Input: initial $\\theta_0 \\in \\R^d$, step size $\\eta > 0$
for $t = 1, \\dots, T$ do
  $g_t \\gets \\nabla \\mathcal{L}(\\theta_{t-1})$
  $\\theta_t \\gets \\theta_{t-1} - \\eta g_t$
return $\\theta_T$
:::

By \\cref{thm:cs}, \\cref{lem:sub}, and \\cref{alg:gd}.
`;
  const { html, diagnostics } = await renderStudioPreviewFull(md);
  assert.equal(diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`);
  assert.ok(html.includes('class="math-env math-env--theorem"'), 'theorem wrapper');
  assert.ok(html.includes('Theorem 1') && html.includes('Cauchy'), 'theorem head');
  assert.ok(html.includes('<strong>inner products</strong>'), 'markdown parsed inside theorem');
  assert.ok(html.includes('class="math-env math-env--proof"'), 'proof wrapper');
  assert.ok(html.includes('class="math-qed"') && html.includes('∎'), 'QED tombstone');
  assert.ok(html.includes('class="math-env math-env--lemma"') && html.includes('Lemma 1'), 'fenced lemma');
  assert.ok(html.includes('<figure class="algorithm-block"'), 'algorithm figure');
  assert.ok(html.includes('Algorithm 1') && html.includes('Gradient Descent'), 'algorithm title');
  assert.ok(html.includes('data-indent="1"'), 'algorithm preserves indentation');
  assert.ok(!html.includes('Fig. 01'), 'algorithm must NOT be numbered as Fig. 01');
  assert.ok(html.includes('>Theorem 1<') && html.includes('>Lemma 1<') && html.includes('>Algorithm 1<'), 'cref resolution');
});

console.log('\n[5/7] Global + per-post + inline macros merging');

await test('merges globalMacros, frontmatter macros, and inline \\newcommand / \\DeclareMathOperator (stripping preamble lines)', async () => {
  const md = `
\\newcommand{\\myvec}[1]{\\mathbf{#1}}
\\DeclareMathOperator{\\diag}{diag}

We compute $\\myvec{x} \\in \\R^d$, $\\postop(A)$, $\\globcmd$, and $\\diag(M)$.
`;
  const { html, diagnostics } = await renderStudioPreviewFull(md, {
    globalMacros: { ...DEFAULT_LATEX_MACROS, '\\globcmd': '\\mathcal{G}' },
    macros: '\\DeclareMathOperator{\\postop}{PostOp}',
  });
  assert.equal(diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`);
  assert.ok(!html.includes('\\newcommand'), 'inline \\newcommand must be stripped from output');
  assert.ok(!html.includes('\\DeclareMathOperator'), 'inline \\DeclareMathOperator must be stripped from output');
  assert.ok(html.includes('PostOp'), 'post macro rendered');
  assert.ok(html.includes('diag'), 'inline operator rendered');
});

console.log('\n[6/7] BibTeX numeric & author-year citations + References section');

await test('resolves frontmatter + ```bibtex fence citations in numeric and author-year styles', async () => {
  const frontmatterBib = `
    @inproceedings{vaswani2017,
      title = {Attention Is All You Need},
      author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
      booktitle = {NeurIPS},
      year = {2017}
    }
  `;
  const md = `
Transformers \\cite{vaswani2017} inspired mechanistic interpretability \\cite{elhage2022, vaswani2017} and \\citet{elhage2022}, see [@vaswani2017] and \\cite{unknown2099}.

\`\`\`bibtex
@article{elhage2022,
  title = {Toy Models of Superposition},
  author = {Nelson Elhage and Tristan Hume and Catherine Olsson},
  journal = {Transformer Circuits Thread},
  year = {2022},
  url = {https://transformer-circuits.pub/2022/toy_models/index.html}
}
\`\`\`
`;
  // Numeric mode
  const numRes = await renderStudioPreviewFull(md, { bibliography: frontmatterBib, citationStyle: 'numeric' });
  assert.equal(numRes.diagnostics.length, 0);
  assert.ok(!numRes.html.includes('@article{elhage2022'), 'raw bibtex fence stripped');
  assert.ok(numRes.html.includes('href="#ref-vaswani2017"') && numRes.html.includes('>[1]<'), 'first citation [1]');
  assert.ok(numRes.html.includes('href="#ref-elhage2022"') && numRes.html.includes('Elhage et al. [2]'), '\\citet numeric');
  assert.ok(numRes.html.includes('latex-cite--missing') && numRes.html.includes('[? unknown2099]'), 'missing cite');
  assert.ok(numRes.html.includes('<section class="references" id="references"'), 'References section');
  assert.ok(numRes.html.includes('<li id="ref-vaswani2017" data-cite-key="vaswani2017">'), 'ref li for vaswani2017');
  assert.ok(numRes.html.indexOf('ref-vaswani2017') < numRes.html.indexOf('ref-elhage2022'), 'citation order preserved');

  // Author-year mode
  const ayRes = await renderStudioPreviewFull(md, { bibliography: frontmatterBib, citationStyle: 'author-year' });
  assert.ok(ayRes.html.includes('(Vaswani et al., 2017)'), 'author-year \\cite');
  assert.ok(ayRes.html.includes('Elhage et al. (2022)'), 'author-year \\citet');
});

console.log('\n[7/7] KaTeX error diagnostics, source data-line, and renderLiveArticle');

await test('captures KaTeX errors with accurate line numbers, friendly hints, and .has-latex-error', async () => {
  const md = `---
title: Test
---

Line 5 text.

$$
\\undefinedmacro{x}
$$

Inline error $\\frac{1}{2$ here.
`;
  const { html, diagnostics } = await renderStudioPreviewFull(md);
  assert.equal(diagnostics.length, 2, `expected 2 diagnostics, got ${diagnostics.length}`);
  assert.equal(diagnostics[0].display, true);
  assert.equal(diagnostics[0].line, 7, `expected display error at line 7, got ${diagnostics[0].line}`);
  assert.ok(diagnostics[0].hint.includes('\\undefinedmacro'), `hint should mention \\undefinedmacro: ${diagnostics[0].hint}`);
  assert.equal(diagnostics[1].display, false);
  assert.equal(diagnostics[1].line, 11, `expected inline error at line 11, got ${diagnostics[1].line}`);
  assert.ok(html.includes('has-latex-error'), 'has-latex-error class present');
  assert.ok(/class="math-block[^"]*"[^>]*data-line="7"/.test(html) || /data-line="7"[^>]*class="math-block/.test(html), 'data-line="7" tagged on .math-block');
});

await test('renderStudioPreview, renderPreview, and renderLiveArticle forward options cleanly', async () => {
  const body = `## Section\n\n$$\n\\label{eq:a}\n\\custommacro\n$$\n\nSee \\eqref{eq:a} and \\cite{k1}.`;
  const opts = {
    macros: '\\newcommand{\\custommacro}{\\mathbb{H}}',
    bibliography: '@misc{k1, title={Paper}, author={Ada Lovelace}, year={1843}}',
    citationStyle: 'author-year',
  };
  const studioHtml = await renderStudioPreview(body, opts);
  assert.ok(studioHtml.includes('(Lovelace, 1843)'));
  assert.ok(studioHtml.includes('data-line='));

  const previewHtml = await renderPreview(body, opts);
  assert.ok(previewHtml.includes('(Lovelace, 1843)'));

  const live = await renderLiveArticle(body, 'md', opts);
  assert.ok(live.html.includes('(Lovelace, 1843)'));
  assert.ok(live.html.includes('href="#eq-a"'));
  assert.equal(live.headings.length, 2);
  assert.equal(live.headings[0].text, 'Section');
  assert.equal(live.headings[1].text, 'References');
});

await test('edge cases: single-line $$ with label, inline \\[...\\], consecutive preambles, tight theorem/proof, data-line on .math-env', async () => {
  const md = `\\newcommand{\\F}{\\mathbb{F}}
\\newcommand{\\vect}[1]{\\mathbf{#1}}
\\DeclareMathOperator*{\\soft}{softmax}

Single-line display with label:

$$E = mc^2 \\label{eq:einstein}$$

Inline display bracket: consider \\[ \\vect{x} \\in \\F^d \\] here.

\\begin{theorem}[Tight Theorem]
\\label{thm:tight}
No blank lines around body, using $\\soft(z)$ and \\eqref{eq:einstein}.
\\end{theorem}

\\begin{proof}[Proof of Theorem 1]
Immediate from \\cref{thm:tight}.
\\end{proof}
`;
  const { html, diagnostics } = await renderStudioPreviewFull(md);
  assert.equal(diagnostics.length, 0, `unexpected diagnostics: ${JSON.stringify(diagnostics)}`);
  assert.ok(!html.includes('\\newcommand') && !html.includes('\\DeclareMathOperator'), 'all consecutive preamble lines stripped');
  assert.ok(html.includes('id="eq-einstein"') && html.includes('data-eq-num="1"'), 'single-line $$ promoted & numbered');
  assert.ok(html.includes('softmax'), 'consecutive \\DeclareMathOperator* worked');
  assert.ok(html.includes('id="env-thm-tight"') && html.includes('Tight Theorem'), 'tight theorem parsed');
  assert.ok(html.includes('Proof of Theorem 1') && html.includes('math-qed'), 'custom proof title + QED');
  assert.ok(/class="math-env math-env--theorem"[^>]*data-line="11"/.test(html) || /data-line="11"[^>]*class="math-env math-env--theorem"/.test(html), `data-line on .math-env: ${html.match(/<div[^>]*math-env--theorem[^>]*>/)?.[0]}`);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
