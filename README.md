# Personal blog

A small personal blog in an informal early-2000s style: a dotted desk, a faint schematic in the background, side notes, a hand-drawn sticker. The site name comes from `siteName` in `site.config.json`. Underneath is a modern writing setup:

- Light **archival paper** and **soft charcoal** dark mode (no pure black); no flash of the wrong theme.
- Reading in **IBM Plex Sans** by default. Readers can switch any post to Newsreader (serif) or JetBrains Mono with the **Aa** switch.
- **LessWrong/Substack-style writing tools:** KaTeX maths, hover footnotes, `[[wiki-links]]` with previews, `> [!TLDR]` / `[!EPISTEMIC]` / `[!NOTE]` / `[!WARNING]` / `[!QUOTE]` callouts, collapsible deep-dives, captioned figures, series navigation, drafts, an RSS feed, reading time, a table of contents, a reading progress bar and copy-code buttons.
- **Highlight-to-comment:** readers select any passage to start a quote thread (`quote_thread.exe`). Threads re-anchor by text quote with prefix/suffix context, so later edits don't break them, and they also appear in the post's `comments.exe` feed.
- **Smooth page transitions** (Astro View Transitions): the compact 780px hub frame widens to a 1120px reading frame when you open a post (with the contents column and quote panel inside it), and post titles morph into the article header.
- **No-code customisation:** `site.config.json`, a local editor at `/_admin`, and `npm run new-post`.

**👉 To change text, images and settings, or to write posts, read [CUSTOMIZING.md](CUSTOMIZING.md).** You don't need to touch `src/`.

## Quick start

Requires Node 22.23.4 or newer.

```bash
npm install
npm run dev                      # http://localhost:4321  (editor at /_admin)
npm run new-post "Post title"    # new draft in content/posts/
npm run ascii -- drawing.png     # front-page ASCII art from a PNG
npm run build                    # dist/client (static) + dist/server (comments API)
```

## How it fits together

| Piece | Where |
| --- | --- |
| Settings | `site.config.json`, read by `src/site.config.ts` |
| Posts | `content/posts/*.md(x)`, schema in `src/content.config.ts` |
| Markdown pipeline (shared by site + admin preview) | `plugins/markdown.mjs` (wiki-links, callouts, figures, KaTeX, code frames) |
| Comments API | `src/pages/api/comments.ts` + `src/lib/comment-store.ts` (JSON / Turso / Supabase) |
| Highlight & comment UI | `src/scripts/comments.ts`, markup in `src/components/Comments.astro` |
| Hover previews, ToC, progress | `src/scripts/previews.ts`, `src/scripts/post-page.ts` |
| Client-side navigation lifecycle | `src/scripts/lifecycle.ts`: every script re-initialises on `astro:page-load` and cleans up on the next one |
| Local editor (dev only) | `plugins/admin-integration.mjs` + `admin/index.html` |
| Styles | `src/styles/global.css` (tokens, shell, widgets, comments), `src/styles/prose.css` (reading) |

Pages are pre-rendered static HTML. Only `/api/comments` runs on the server, which is why `@astrojs/node` is configured. Deploy `dist/` to any Node host and run `node dist/server/entry.mjs`, or upload `dist/client/` alone to a static host; comments then become read-only. Storage options and environment variables are listed in [CUSTOMIZING.md → Comments](CUSTOMIZING.md#6-comments).
