// arXiv-tier Rehype plugin replacing rehype-katex:
// - Renders inline & display math directly via KaTeX with merged macros + trust:true
// - Wraps display math in <div class="math-block"> with .math-block-inner, .eq-num,
//   data-raw-tex, data-eq-num, data-eq-label, id, and preserved source position
// - Captures KaTeX parse errors with friendly hints into vfile.data.latexDiagnostics
//   and marks offending nodes with .has-latex-error
// - Resolves deferred figure & section cross-references AFTER rehypeFigureNumbers runs
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';
import { toText } from 'hast-util-to-text';
import katex from 'katex';
import { visit } from 'unist-util-visit';
import { SKIP, visitParents } from 'unist-util-visit-parents';
import { DEFAULT_LATEX_MACROS, friendlyKatexHint, safeAnchorId } from './latex-core.mjs';

function getClassList(node) {
  const cls = node?.properties?.className;
  if (Array.isArray(cls)) return cls.map(String);
  if (typeof cls === 'string') return cls.split(/\s+/).filter(Boolean);
  return [];
}

function getProp(props, kebab, camel) {
  if (!props) return undefined;
  return props[kebab] ?? props[camel];
}

function renderKatexHtml(tex, displayMode, macros) {
  const baseOpts = {
    displayMode,
    strict: false,
    trust: true,
    macros: { ...macros },
  };

  try {
    const html = katex.renderToString(tex, { ...baseOpts, throwOnError: true });
    return { html, error: null };
  } catch (err) {
    const message = String(err?.message ?? err);
    let html = '';
    try {
      html = katex.renderToString(tex, {
        ...baseOpts,
        macros: { ...macros },
        strict: 'ignore',
        throwOnError: false,
      });
    } catch {
      html = '';
    }
    return { html, error: message };
  }
}

function parseKatexHast(html, tex, errorMessage) {
  if (html) {
    const root = fromHtmlIsomorphic(html, { fragment: true });
    if (root.children?.length) return root.children;
  }
  return [
    {
      type: 'element',
      tagName: 'span',
      properties: {
        className: ['katex-error'],
        title: errorMessage || 'KaTeX render error',
      },
      children: [{ type: 'text', value: tex }],
    },
  ];
}

/** Collect numbered figures (`<figure id="...">` + `.fig-num`) and headings (`<h1..h6 id="...">`). */
function collectDeferredTargets(tree) {
  const figures = new Map();
  const headings = new Map();

  visit(tree, 'element', (node) => {
    const id = node.properties?.id;
    if (!id || typeof id !== 'string') return;

    if (node.tagName === 'figure') {
      // Find .fig-num span inside figcaption (added by rehypeFigureNumbers)
      let figNumText = '';
      visit(node, 'element', (child) => {
        if (child.tagName === 'span' && getClassList(child).includes('fig-num')) {
          figNumText = toText(child).trim();
        }
      });
      const digits = figNumText.match(/\d+/)?.[0] ?? '';
      const entry = {
        id,
        kind: 'figure',
        figNumText: figNumText || id,
        digits: digits || figNumText || id,
      };
      figures.set(id.toLowerCase(), entry);
    } else if (/^h[1-6]$/.test(node.tagName)) {
      const title = toText(node).trim();
      headings.set(id.toLowerCase(), { id, kind: 'section', title: title || id });
    }
  });

  return { figures, headings };
}

function resolveDeferredRefs(tree) {
  const { figures, headings } = collectDeferredTargets(tree);
  if (figures.size === 0 && headings.size === 0) return;

  visit(tree, 'element', (node) => {
    if (node.tagName !== 'span') return;
    const classes = getClassList(node);
    if (!classes.includes('latex-ref--missing')) return;

    const label = getProp(node.properties, 'data-ref-label', 'dataRefLabel');
    const cmd = getProp(node.properties, 'data-ref-cmd', 'dataRefCmd') || 'ref';
    if (!label || typeof label !== 'string') return;

    const lower = label.toLowerCase();
    const figCandidate =
      figures.get(lower) ||
      figures.get(safeAnchorId('fig', label)) ||
      figures.get(`fig-${lower.replace(/^fig:/, '')}`);

    if (figCandidate) {
      let text = figCandidate.figNumText;
      if (cmd === 'ref') text = figCandidate.digits;
      else if (cmd === 'Cref') text = `Figure ${figCandidate.digits}`;
      else if (cmd === 'eqref') text = `(${figCandidate.digits})`;
      else if (cmd === 'cref') text = figCandidate.figNumText;

      node.tagName = 'a';
      node.properties = {
        className: ['latex-ref'],
        href: `#${figCandidate.id}`,
        'data-ref-target': figCandidate.id,
        'data-ref-label': label,
        'data-ref-kind': 'figure',
      };
      node.children = [{ type: 'text', value: text }];
      return;
    }

    const secKey = lower.replace(/^sec:/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const headingCandidate = headings.get(lower) || headings.get(secKey);
    if (headingCandidate) {
      const text =
        cmd === 'cref' || cmd === 'Cref'
          ? `Section "${headingCandidate.title}"`
          : headingCandidate.title;
      node.tagName = 'a';
      node.properties = {
        className: ['latex-ref'],
        href: `#${headingCandidate.id}`,
        'data-ref-target': headingCandidate.id,
        'data-ref-label': label,
        'data-ref-kind': 'section',
      };
      node.children = [{ type: 'text', value: text }];
    }
  });
}

export default function rehypeLatex(options = {}) {
  return (tree, file) => {
    const fileMacros = file?.data?.latex?.macros;
    const macros = {
      ...DEFAULT_LATEX_MACROS,
      ...(options.macros && typeof options.macros === 'object' ? options.macros : {}),
      ...(fileMacros && typeof fileMacros === 'object' ? fileMacros : {}),
    };

    /** @type {Array<{ line: number, offset?: number, message: string, hint: string, tex: string, display: boolean }>} */
    const diagnostics = [];

    visitParents(tree, 'element', (element, parents) => {
      const classes = getClassList(element);
      const languageMath = classes.includes('language-math');
      const mathDisplay = classes.includes('math-display');
      const mathInline = classes.includes('math-inline');

      if (!languageMath && !mathDisplay && !mathInline) return;

      let displayMode = mathDisplay;
      let parent = parents[parents.length - 1];
      let scope = element;

      if (
        element.tagName === 'code' &&
        languageMath &&
        parent &&
        parent.type === 'element' &&
        parent.tagName === 'pre'
      ) {
        scope = parent;
        parent = parents[parents.length - 2];
        displayMode = true;
      }

      if (!parent) return;

      const tex = toText(scope, { whitespace: 'pre' }).trim();
      if (!tex) return;

      // Read equation metadata from either <pre> (scope) or <code> (element)
      const props = { ...(element.properties || {}), ...(scope.properties || {}) };
      const rawTex = getProp(props, 'data-raw-tex', 'dataRawTex') ?? tex;
      const eqNum = getProp(props, 'data-eq-num', 'dataEqNum');
      const eqDisplay = getProp(props, 'data-eq-display', 'dataEqDisplay');
      const eqLabel = getProp(props, 'data-eq-label', 'dataEqLabel');
      const eqMulti = getProp(props, 'data-eq-multi', 'dataEqMulti') === 'true';
      const extraIdsRaw = getProp(props, 'data-eq-extra-ids', 'dataEqExtraIds');
      const anchorId = props.id;

      const { html, error } = renderKatexHtml(tex, displayMode, macros);
      const katexChildren = parseKatexHast(html, tex, error);

      if (error) {
        const line = scope.position?.start?.line ?? element.position?.start?.line ?? 1;
        const offset = scope.position?.start?.offset ?? element.position?.start?.offset;
        diagnostics.push({
          line,
          ...(offset !== undefined ? { offset } : {}),
          message: error.replace(/^KaTeX parse error:\s*/i, ''),
          hint: friendlyKatexHint(error, rawTex),
          tex: rawTex,
          display: displayMode,
        });
      }

      const idx = parent.children.indexOf(scope);
      if (idx < 0) return;

      if (displayMode) {
        const blockClasses = ['math-block'];
        if (eqNum) blockClasses.push('math-block--numbered');
        if (error) blockClasses.push('has-latex-error');

        const extraAnchors = extraIdsRaw
          ? String(extraIdsRaw)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((extraId) => ({
                type: 'element',
                tagName: 'span',
                properties: { id: extraId, className: ['eq-anchor'], ariaHidden: 'true' },
                children: [],
              }))
          : [];

        const blockChildren = [
          ...extraAnchors,
          {
            type: 'element',
            tagName: 'div',
            properties: { className: ['math-block-inner'] },
            children: katexChildren,
          },
        ];

        if (eqNum && !eqMulti) {
          blockChildren.push({
            type: 'element',
            tagName: 'span',
            properties: { className: ['eq-num'] },
            children: [{ type: 'text', value: eqDisplay || `(${eqNum})` }],
          });
        }

        const wrapper = {
          type: 'element',
          tagName: 'div',
          position: scope.position ?? element.position,
          properties: {
            className: blockClasses,
            ...(anchorId ? { id: anchorId } : {}),
            ...(eqNum ? { 'data-eq-num': String(eqNum) } : {}),
            ...(eqLabel ? { 'data-eq-label': String(eqLabel) } : {}),
            'data-raw-tex': String(rawTex),
          },
          children: blockChildren,
        };

        parent.children.splice(idx, 1, wrapper);
        return SKIP;
      }

      // Inline math
      if (error) {
        const errWrap = {
          type: 'element',
          tagName: 'span',
          position: element.position,
          properties: {
            className: ['math-inline', 'has-latex-error'],
            title: friendlyKatexHint(error, rawTex),
          },
          children: katexChildren,
        };
        parent.children.splice(idx, 1, errWrap);
      } else {
        parent.children.splice(idx, 1, ...katexChildren);
      }
      return SKIP;
    });

    // Resolve deferred figure & section cross-references (runs after rehypeFigureNumbers)
    resolveDeferredRefs(tree);

    // Expose diagnostics on vfile.data and optional preview sink
    if (file) {
      file.data = file.data || {};
      file.data.latexDiagnostics = diagnostics;
      const sink = file.data.astro?.frontmatter?.__latexDiagnostics;
      if (Array.isArray(sink)) {
        sink.push(...diagnostics);
      }
    }
  };
}
