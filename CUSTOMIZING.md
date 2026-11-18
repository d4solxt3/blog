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

- **[site settings]**: the very first box is **Site name**. Change it, press **Save to heartcache.xyz**, and the name updates everywhere: the wordmark, the window bar, browser tabs and the footer. Below it you can change the banner strip, the intro text, status and mood, the changelog, the todo list, your profile and progress bars, the default font, and comment options. Any open tab of your site reloads with the changes.
- **Front-page drawing**: the wide **ascii_art.exe** box turns a PNG into the ASCII drawing on the front page (see section 5).
- **Avatar**: click *Choose File* under "Avatar image (about page)", pick a picture, then press **Save to heartcache.xyz**. It's copied into `public/images/` for you.
- **[posts]**: pick a post on the left to edit it. The right-hand panel shows a live preview as you type. Press **save** (or `Ctrl + S`). **+ new post** creates a fresh draft.

In either tab, **Save to heartcache.xyz** (Ctrl+S or Cmd+S) sends the current settings or selected post and its referenced images to GitHub and deploys the change on Railway. The status beside the button confirms when the public site serves the saved revision. Posts marked `draft: true` stay hidden. In the local writing studio at `/write`, choose **Publish** to release a published post. Its draft autosaves stay private.

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
| `frontpageAscii` | The text file with the ASCII drawing in the front page's portrait box (see section 5). Normally `"/images/frontpage-ascii.txt"` |
| `frontpageImage` | The picture used as your avatar on the About page, e.g. `"/images/me.png"`. The front page uses it too if there's no ASCII drawing |
| `invertFrontpageImageInDarkMode` | `true` for black-on-white drawings (they turn light in dark mode). Use `false` for photos and colour images |
| `motion` | `"quiet"` (default) or `"full"`: how much moves for a first-time visitor. Quiet keeps just the page transitions; full adds the ticking clock seconds, the scrolling "now" ticker, the blinking cursor, the turning background ring and the tab-title emoticons. Visitors switch with **quiet / full** in the window bar, and their choice is remembered |
| `tabAnimation` | Emoticons cycling in front of the browser-tab title (the page and site name always stay). `"preset"`: `"kaomoji"`, `"stream"` (a signal moving down a residual stream ▸···), `"moon"` (◐◓◑◒), `"cyber-hud"`, `"classic-blink"` or `"off"`. `"intervalMs"`: milliseconds per frame (950). `"frames"`: your own list, which replaces the preset's. `"enabled": false` turns it off. It only runs with motion set to "full", and pauses when the tab is hidden or the reader prefers reduced motion |
| `banner` | The slim strip under the menu on the front page, writing and about pages. `"show": false` hides it. Leave `"image": ""` for the built-in dithered horizon, or set your own, e.g. `"/images/banner.jpg"` (shown in grayscale with a halftone screen; wide pictures work best). `"alt"` describes your picture for screen readers |
| `defaultFont` | `"sans"`, `"serif"` or `"mono"`: the reading font for posts. Readers can still switch with the **Aa** buttons |
| `accentBorders` | `true` for crisp dark borders, `false` for softer grey ones |
| `newBadgeDays` | How many days a post is marked **NEW** in the writing list. Pinned posts (`pinned: true`) sit above a "latest" divider, with a small pin icon |
| `inlineAnnotations` | `true` lets readers highlight a sentence and comment on it. `false` turns that off everywhere |
| `footerText` | The small line under the page. `{year}`, `{siteName}` and `{authorName}` fill themselves in |
| `intro` | The 2–3 line hello in the front page's **about** box |
| `status` | Your current `mood`, `thought`, and when you `updated` them (the front page's **now** box) |
| `updates` | The little changelog in the front page's **updates** box (newest first) |
| `notice` | The small **note** box at the bottom of the front page's left column (`""` hides it) |
| `todo` | The **todo** box on the front page (and the About checklist). Set `"done": true` to cross an item off |
| `profile` | The rest of the About page: timezone, bio, interests, links, what you're currently into, reading and building, and `progress` bars (`{ "label": "…", "percent": 60 }`). Your timezone, links and "currently" lines also appear on the front page. If one link is an email (`"url": "mailto:you@…"`), the menu gets an **email** link to it |
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

The front page shows an **ASCII version of a drawing** in the framed portrait box at the top of the left column. It's drawn on exactly the character grid the converter uses and follows light and dark mode; click it to see it full size. To use a different drawing:

- **In `/_admin`:** in the **ascii_art.exe** box, pick a black-on-white **PNG**. It's converted and saved straight away, and the big preview shows the result; press **Save to heartcache.xyz** to publish it. Drag the **detail** slider for more columns (sharper, smaller characters) or fewer (chunkier ones). The drawing re-converts as you drag.
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

1. **Sign in** with your admin password (see section 7): press `Ctrl + Shift + E`, or open **`/moderate/`** on your site and enter it there. `/moderate/` isn't linked anywhere and search engines are told to skip it.
2. On `/moderate/` you'll see every comment, newest first, each with **[ delete ]**. While you're signed in, that browser also shows **[ delete ]** next to each comment under your posts, including quote threads.
3. **To remove a highlighted passage entirely**, click the highlight in the post to open its quote thread and press **[ delete thread ]**. That deletes the highlight and every reply on it. On `/moderate/` the same option is **[ delete highlight ]**, under each quoted passage.

Deleting can't be undone. **[ sign out ]** on `/moderate/` signs that browser out. An older `COMMENTS_ADMIN_KEY` passphrase, if you set one, still works on `/moderate/`.

Without a password, moderation is switched off on the live site. On your computer (`npm run dev`) you're always signed in, so you can try it with your test comments.

**Prefer GitHub Discussions?** Set `"provider": "giscus"` under `comments` and fill in the giscus values from [giscus.app](https://giscus.app). Highlight replies still use the built-in system.

To turn highlight-comments off everywhere, set `"inlineAnnotations": false`. To turn them off for one post, add `annotations: false` to that post's settings.

---

## 7. Writing on the live site (the hidden studio)

There's a writing studio at **`/write`**. Visitors never see a link to it.

**Getting in**
- Press **`Ctrl + Shift + E`** (`Cmd + Shift + E` on a Mac) on any page, or **triple-click the year** in the footer. A small **auth.exe** box asks for your password.
- Once you're signed in (for 30 days on that browser), small **[+ write] [edit] [config]** links appear in the window bar, and pressing **`e`** on a post opens it in the editor.
- On your computer (`npm run dev`) you're always signed in, with no password.

**Your password**
1. In Railway, open the `web` service → **Variables** → add **`ADMIN_PASSWORD`** with a long password.
2. To change it later, sign in and open **[config]** (`/write/settings/`). The new password is stored scrambled (hashed) on the server's disk and replaces `ADMIN_PASSWORD`. Changing it signs out every other browser.
3. **Forgot it?** Change `ADMIN_PASSWORD` in Railway to something new. A new value always takes over again.

Deleting in the live writing studio works even when GitHub publishing is off. In that case the server records the deletion on the Railway volume and immediately removes the post from public pages and feeds. Its source stays in Git. Deleting a post file in the studio also reserves its URL. A new post with the same title gets a numbered URL and a fresh discussion. Keep the small files in `content/retired-posts/` when you commit local deletions. Discarding a draft that has never been written to a post file does not reserve an address.

**Publishing from the studio** (one-time setup)
1. On GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Under *Repository access*, pick **Only select repositories** and choose this blog's repo. Under *Permissions*, set **Contents** to **Read and write**. Generate it and copy it.
2. In Railway, add it to the `web` service as the variable **`GITHUB_TOKEN`**.
3. In Railway, open the `web` service → **Settings → Source → Connect repo**, and pick the same repo and branch (`master`). From then on every commit rebuilds the site.

The repo and branch it commits to are set under `"publishing"` in `site.config.json`.

**How it works**
- Drafts save on their own: every keystroke is kept in your browser, and the server saves a copy 2.5 seconds after you stop typing. If the page crashes, it offers to **restore** the unsaved draft.
- **[ publish ]** commits the post (and any images it uses) to GitHub in one commit. Railway rebuilds, and the post is live in about 1–2 minutes. With the status set to **draft**, the button says **[ commit draft ]** and the post stays hidden.
- After publishing from the site, run `git pull` before editing on your computer, so you have the new post.

**Writing**
- Type **`/`** at the start of a line for blocks: headings, TL;DR box, epistemic status, collapsible details, math block, image/GIF, footnote, pull quote. Use the arrow keys and Enter.
- Type **`[[`** to link another post.
- Select text for the **B / I / code / link / $ / quote** bubble. Shortcuts: `Ctrl+B`, `Ctrl+I`, `Ctrl+K` (link), `Ctrl+Shift+F` (footnote). **[ keys ]** in the top bar lists them all.
- **Paste or drag in** png, jpg, gif, webp or svg images (up to 20 MB). They're uploaded to `public/images/posts/<post>/` and keep their colours and GIF animation.
- `Ctrl+P` previews, `Ctrl+\` is focus mode, `Ctrl+S` saves now. Your cursor and scroll position come back when you leave the preview or close the details.
- **[ details ]** holds the description, tags, series, date, font, pin and draft/published status. Every tag you've used shows as a pill (with how many posts use it): click to add or remove it, or type a new one (Enter completes a partly typed tag). Existing series are listed too; picking one fills in the next part number if part # is empty.
- The top bar shows three things separately: the **server draft** ("draft saved 14:02"), how the text compares with the **published file** ("unpublished changes" / "same as the committed version"), and **kept in this browser** when there are keystrokes the server hasn't got yet.

---

## 8. Publishing

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

## 9. If something looks wrong

- **The page didn't update:** save the file again, or refresh the browser.
- **An error page after editing `site.config.json`:** a missing comma or quote. Undo your last change.
- **A post doesn't show up:** check that the file is in `content/posts/`, ends in `.md` or `.mdx`, and (on the live site) has `draft: false`.
- **A `[[link]]` is crossed out:** no post has that filename. Check the spelling.
