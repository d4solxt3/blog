# Customizing your site (no code required)

You never need to open the `src/` folder. Everything you'd want to change is in one of three places:

| What | Where |
| --- | --- |
| Site name, front-page text, your profile, fonts, comments | **`site.config.json`** (or the editor at `/_admin`) |
| Your posts | **`content/posts/`** |
| Images (front-page drawing, pictures in posts) | **`public/images/`** |

---

## 1. Start the site on your computer

Open a terminal in this folder and run:

```bash
npm run dev
```

Then open **http://localhost:4321** in your browser. Leave the terminal running while you work. Every time you save a file, the page in your browser updates by itself.

To stop it, click the terminal and press `Ctrl + C`.

---

## 2. The easy way: the editor at `/_admin`

While `npm run dev` is running, open **http://localhost:4321/_admin** in your browser. There's no link to it on the site itself, and it doesn't exist on the published site: it's only for you, on your computer.

- **[site settings]**: the very first box is **Site name**. Change it, press **save settings**, and the name updates everywhere: the wordmark, the window bar, browser tabs and the footer. Below it you can change the intro text, status and mood, the changelog, the todo list, your profile and progress bars, the default font, and comment options. Any open tab of your site reloads with the changes.
- **Front-page drawing**: the wide **ascii_art.exe** box turns a PNG into the ASCII drawing on the front page (see section 5).
- **Avatar**: click *Choose File* under "Avatar image (about page)", pick a picture, then press **save settings**. It's copied into `public/images/` for you.
- **[posts]**: pick a post on the left to edit it. The right-hand panel shows a live preview as you type. Press **save** (or `Ctrl + S`). **+ new post** creates a fresh draft.

The editor only exists on your own computer. It is never part of the published site.

---

## 3. Or edit `site.config.json` directly

Open `site.config.json` in any text editor. Change only the text between the quotes, keep the commas, and save. Here's what each setting does:

| Setting | What it changes |
| --- | --- |
| `siteName` | **Your site's name.** Used for the wordmark (top right), the `[ name ]` window bar, browser tab titles, the RSS feed and the footer |
| `siteSubtitle` | One line about the site, used by search engines and RSS readers |
| `authorName` | Your name (shown on the About page) |
| `authorHandle` | Your handle, shown as `@handle` on the About page |
| `siteUrl` | Your website's address once you have one, e.g. `"https://my-notebook.net"`. Leave it `""` until then |
| `frontpageAscii` | The text file with the front-page ASCII drawing (see section 5). Normally `"/images/frontpage-ascii.txt"` |
| `frontpageImage` | The picture used as your avatar on the About page, e.g. `"/images/me.png"` |
| `invertFrontpageImageInDarkMode` | `true` for black-on-white drawings (they turn light in dark mode). Use `false` for photos and colour images |
| `defaultFont` | `"sans"`, `"serif"` or `"mono"`: the reading font for posts. Readers can still switch with the **Aa** buttons |
| `accentBorders` | `true` for crisp dark borders, `false` for softer grey ones |
| `newBadgeDays` | How many days a post shows the **NEW** badge |
| `inlineAnnotations` | `true` lets readers highlight a sentence and comment on it. `false` turns that off everywhere |
| `footerText` | The small line under the page. `{year}`, `{siteName}` and `{authorName}` fill themselves in |
| `intro` | The 2–3 line hello at the top of the front page |
| `status` | Your current `mood`, `thought`, and when you `updated` them |
| `updates` | The little changelog on the front page (newest first) |
| `notice` | The small side note on the left of the front page (`""` hides it) |
| `todo` | The todo/reading card. Set `"done": true` to cross an item off |
| `profile` | The rest of the About page: timezone, bio, interests, links, what you're currently into, reading and building, and `progress` bars (`{ "label": "…", "percent": 60 }`) |
| `comments` | Which comment system to use (see section 6) |

If the site stops loading after an edit, you probably removed a comma or a quote. Undo your last change, or use `/_admin` instead.

---

## 4. Writing posts

### Create a post

```bash
npm run new-post "My new post"
```

This creates `content/posts/my-new-post.mdx` with everything filled in. Open it and start writing below the second `---` line.

New posts are **drafts**: they show (with a DRAFT badge) on your computer, but never on the published site. When you're ready, change `draft: true` to `draft: false`.

### The settings at the top of a post

```yaml
---
title: "My new post"
subtitle: "An optional one-line subtitle"
description: "One or two sentences shown on the front page."
date: 2026-11-17
tags: [machine learning, notes]
draft: false
pinned: true            # keep it at the top of the list
font: serif             # this post's reading font: sans, serif or mono
series: "My series"     # group posts into a numbered sequence
seriesOrder: 2
annotations: false      # turn off highlight-to-comment on this post only
tldr:                   # a summary box at the top
  - First takeaway
  - Second takeaway
---
```

Only `title`, `description` and `date` are required.

### Your writing toolbox

| You type | You get |
| --- | --- |
| `## Section` / `### Subsection` | Numbered headings that appear in the table of contents |
| `$E = mc^2$` | Inline maths |
| `$$` on its own line, an equation, `$$` again | A centred equation |
| `Some claim[^1]` and later `[^1]: The note.` | A footnote that previews on hover and is listed at the bottom |
| `[[other-post-filename]]` | A link to another post, with a hover preview. Use the filename without `.md`/`.mdx`. Use `[[filename\|custom text]]` to change the link text |
| `> [!TLDR]` then lines starting with `>` | A summary box |
| `> [!EPISTEMIC]` | An "epistemic status" box (how sure you are) |
| `> [!NOTE]` / `> [!WARNING]` | A note or warning box |
| `> [!QUOTE] Someone` | A large pull-quote with an attribution |
| `<details><summary>Title</summary>` … `</details>` | A collapsible section (leave blank lines inside it) |
| `![A caption](/images/picture.png)` | A picture with a caption underneath |
| Three backticks plus a language name, e.g. ```` ```python ```` | A code block with a copy button |

Put images for posts in `public/images/` and refer to them as `/images/name.png`.

---

## 5. The front-page ASCII drawing and your avatar

The front page shows an **ASCII version of a drawing**, under the intro text. Because it's plain text, it matches light and dark mode automatically. To use a different drawing:

- **In `/_admin`:** in the **ascii_art.exe** box, pick a black-on-white **PNG**. It's converted and saved straight away, and the big preview shows the result; reload the front page to see it there. Drag the **detail** slider for more columns (sharper, smaller characters) or fewer (chunkier ones). The drawing re-converts as you drag.
- **Or in the terminal:** put the PNG in `public/images/` and run

  ```bash
  npm run ascii -- public/images/my-drawing.png
  ```

  Add `--width 80` at the end for more detail. With no file name, it re-converts `public/images/ascii-source.png`.

Either way, the result is saved to `public/images/frontpage-ascii.txt`. You can also open that file and edit the characters by hand.

The **About page avatar** is a normal picture, set by `frontpageImage` (or `profile.avatar`). Black-and-white line art works best there, because it's drawn straight onto the page with no box around it. For a colour picture, set `"invertFrontpageImageInDarkMode": false`.

---

## 6. Comments

Each post has a reply box at the bottom (`comments.exe`). Readers can also **highlight any sentence** and click **✎ quote & comment** to reply to that exact passage. Those replies also appear in the bottom list, and clicking the quote there jumps back to the highlighted sentence.

**On your computer**, comments are saved in `data/comments.json`. That file is your test data and is not uploaded anywhere.

**On the live site**, comments need a small server. Pick one option:

| Option | What to do |
| --- | --- |
| **A Node host** (Railway, Render, Fly.io, a VPS) with a persistent disk | Nothing extra. Comments are stored in `data/comments.json` on that disk |
| **Turso** (free hosted database) | Set the environment variables `COMMENTS_STORE=turso`, `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` on your host. The table is created automatically |
| **Supabase** (free hosted database) | Run the SQL below once in Supabase's SQL editor, then set `COMMENTS_STORE=supabase`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` on your host |

```sql
create table if not exists comments (
  id text primary key,
  post text not null,
  name text not null,
  body text not null,
  created_at text not null,
  anchor_id text,
  exact text,
  prefix text,
  suffix text,
  block_index integer
);
```

Spam protection is built in: a hidden trap field, a minimum time before posting, length limits, and at most 5 comments per visitor every 10 minutes.

### Deleting comments

1. **Pick a passphrase** and add it on your host as the environment variable `COMMENTS_ADMIN_KEY`. On Railway, open the service → **Variables** → **New variable**. Use something long; anyone who knows it can delete comments.
2. **Open `/moderate/`** on your site (for example `https://your-site/moderate/`). It isn't linked anywhere and search engines are told to skip it. Enter the passphrase.
3. You'll see every comment, newest first, each with **[ delete ]**. While you're signed in, that browser also shows **[ delete ]** next to each comment under your posts, including quote threads.
4. **To remove a highlighted passage entirely**, click the highlight in the post to open its quote thread and press **[ delete thread ]**. That deletes the highlight and every reply on it. On `/moderate/` the same option is **[ delete highlight ]**, under each quoted passage.

Deleting can't be undone. **[ sign out ]** on `/moderate/` forgets the passphrase on that browser. Changing `COMMENTS_ADMIN_KEY` signs every browser out.

Without `COMMENTS_ADMIN_KEY`, moderation is switched off on the live site. On your computer (`npm run dev`) any passphrase works, so you can try it with your test comments.

**Prefer GitHub Discussions?** Set `"provider": "giscus"` under `comments` and fill in the giscus values from [giscus.app](https://giscus.app). Highlight replies still use the built-in system.

To turn highlight-comments off everywhere, set `"inlineAnnotations": false`. To turn them off for one post, add `annotations: false` to that post's settings.

---

## 7. Publishing

```bash
npm run build
```

This creates a `dist/` folder:

- `dist/client/` is the website itself (pages, images, styles).
- `dist/server/` runs the comment system.

**With comments:** deploy to a Node host and start it with `node dist/server/entry.mjs`. Set `HOST=0.0.0.0`, and set `PORT` if your host requires it.

**Without a server:** upload `dist/client/` to any static host (Netlify, Cloudflare Pages, GitHub Pages). Everything works except posting comments; the comment box says so politely.

Before publishing, set `siteUrl` in `site.config.json` to your real address.

---

## 8. If something looks wrong

- **The page didn't update:** save the file again, or refresh the browser.
- **An error page after editing `site.config.json`:** a missing comma or quote. Undo your last change.
- **A post doesn't show up:** check that the file is in `content/posts/`, ends in `.md` or `.mdx`, and (on the live site) has `draft: false`.
- **A `[[link]]` is crossed out:** no post has that filename. Check the spelling.
