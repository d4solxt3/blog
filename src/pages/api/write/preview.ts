/** POST { slug, body, macros?, bibliography?, citationStyle? } → { html, diagnostics } rendered with the site's Markdown + LaTeX pipeline (owner only); blocks carry data-line for the studio. */
import type { APIRoute } from 'astro';
import { renderStudioPreviewFull } from '../../../../plugins/preview.mjs';
import { DEV, isOwner, json, ownerOnly } from '../../../lib/auth';
import { readMedia, SLUG } from '../../../lib/content';
import { readGlobalLatexConfig } from './latex-macros';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!isOwner(request)) return ownerOnly();
  const body = (await request.json().catch(() => null)) as {
    slug?: unknown;
    body?: unknown;
    macros?: unknown;
    bibliography?: unknown;
    citationStyle?: unknown;
  } | null;
  const src = typeof body?.body === 'string' ? body.body.slice(0, 2_000_000) : '';
  const slug = typeof body?.slug === 'string' && SLUG.test(body.slug) ? body.slug : '';
  const macros = typeof body?.macros === 'string' ? body.macros.slice(0, 50_000) : '';
  const bibliography = typeof body?.bibliography === 'string' ? body.bibliography.slice(0, 200_000) : '';
  const rawStyle = typeof body?.citationStyle === 'string' ? body.citationStyle : '';
  const globalCfg = readGlobalLatexConfig();
  const citationStyle = rawStyle === 'numeric' || rawStyle === 'author-year' ? rawStyle : globalCfg.citationStyle;

  // Same HTML as the article, plus data-line="n" on each block for the split view's scroll sync.
  const rendered = await renderStudioPreviewFull(src, {
    macros,
    bibliography,
    citationStyle,
    globalMacros: globalCfg.macros,
  });
  let html = rendered.html;
  const diagnostics = Array.isArray(rendered.diagnostics) ? rendered.diagnostics : [];

  // On the live site, images uploaded since the last deploy are served from the server's disk.
  if (!DEV && slug) {
    html = html.replace(/(src=")\/images\/posts\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]*\.(?:png|jpg|gif|webp|svg))"/g, (m, pre, s, file) =>
      s === slug && readMedia(s, file) ? `${pre}/api/media/${s}/${file}"` : m,
    );
  }
  return json({ html, diagnostics });
};
