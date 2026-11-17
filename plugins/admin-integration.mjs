// Local editor at http://localhost:4321/_admin — only exists while `npm run dev`
// is running (it hooks the dev server), so it can never ship to production.
// It can only write to: site.config.json, content/posts/*.md(x), public/images/*.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPost, isRetiredLocally, POSTS_DIR } from '../scripts/post-template.mjs';
import { ASCII_OUTPUT, writeAsciiFromImage } from '../scripts/ascii-lib.mjs';
import { renderPreview } from './preview.mjs';

const ROOT = process.cwd();
const CONFIG = resolve(ROOT, 'site.config.json');
const IMAGES = resolve(ROOT, 'public/images');
const ADMIN_HTML = resolve(ROOT, 'admin/index.html');
const POST_NAME = /^[a-z0-9][a-z0-9-]*\.(md|mdx)$/;
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
// Uploads from look.cfg can also be short looping videos (banner / sidebar slots).
const MEDIA_NAME = /\.(png|jpe?g|gif|webp|svg|avif|mp4|webm)$/i;
const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY = 8 * 1024 * 1024;

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

function writeAtomic(file, contents) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, file);
}

const frontmatter = (src) => src.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
const fmValue = (fm, key) => fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');

function listPosts() {
  if (!existsSync(POSTS_DIR)) return [];
  return readdirSync(POSTS_DIR)
    .filter((f) => POST_NAME.test(f))
    .map((file) => {
      const fm = frontmatter(readFileSync(join(POSTS_DIR, file), 'utf8'));
      return {
        file,
        slug: file.replace(/\.(md|mdx)$/, ''),
        title: fmValue(fm, 'title') || file,
        date: fmValue(fm, 'date') || '',
        draft: /^draft:\s*true/m.test(fm),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

async function handle(req, res, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/_admin';
  const method = req.method ?? 'GET';

  if (path === '/_admin' && method === 'GET') {
    return send(res, 200, readFileSync(ADMIN_HTML, 'utf8'), 'text/html; charset=utf-8');
  }

  if (path === '/_admin/api/config') {
    if (method === 'GET') return send(res, 200, readFileSync(CONFIG, 'utf8'));
    if (method === 'PUT') {
      const data = JSON.parse(await readBody(req));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Config must be a JSON object');
      // Merge over what's on disk, so a save from an older /_admin tab (one that
      // doesn't know about newer settings) can't wipe those settings.
      let current = {};
      try {
        current = JSON.parse(readFileSync(CONFIG, 'utf8'));
      } catch {}
      writeAtomic(CONFIG, `${JSON.stringify({ ...current, ...data }, null, 2)}\n`);
      return send(res, 200, { ok: true });
    }
  }

  if (path === '/_admin/api/posts' && method === 'GET') return send(res, 200, listPosts());

  if (path === '/_admin/api/post') {
    const file = url.searchParams.get('file') ?? '';
    if (!POST_NAME.test(file)) return send(res, 400, { error: 'Invalid post file name' });
    const full = join(POSTS_DIR, file);
    if (method === 'GET') {
      if (!existsSync(full)) return send(res, 404, { error: 'Not found' });
      return send(res, 200, { file, content: readFileSync(full, 'utf8') });
    }
    if (method === 'PUT') {
      if (isRetiredLocally(file.replace(/\.(md|mdx)$/, ''))) return send(res, 409, { error: 'This post address is retired.' });
      const { content } = JSON.parse(await readBody(req));
      if (typeof content !== 'string' || !/^---\r?\n/.test(content)) throw new Error('Post must start with frontmatter (---)');
      mkdirSync(POSTS_DIR, { recursive: true });
      writeAtomic(full, content);
      return send(res, 200, { ok: true });
    }
  }

  if (path === '/_admin/api/new-post' && method === 'POST') {
    const { title } = JSON.parse(await readBody(req));
    if (typeof title !== 'string' || !title.trim()) return send(res, 400, { error: 'Title required' });
    try {
      const { slug } = createPost(title.trim());
      return send(res, 200, { file: `${slug}.mdx`, slug });
    } catch (err) {
      return send(res, err.code === 'EEXIST' ? 409 : 500, { error: err.message });
    }
  }

  if (path === '/_admin/api/preview' && method === 'POST') {
    const { content } = JSON.parse(await readBody(req));
    return send(res, 200, { html: await renderPreview(String(content ?? '')) });
  }

  if (path === '/_admin/api/upload' && method === 'POST') {
    const { name, data } = JSON.parse(await readBody(req));
    const safe = String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[.-]+/, '');
    if (!MEDIA_NAME.test(safe)) return send(res, 400, { error: 'Images or short videos only: png, jpg, gif, webp, svg, avif, mp4, webm' });
    const base64 = String(data ?? '').replace(/^data:[^;]+;base64,/, '');
    mkdirSync(IMAGES, { recursive: true });
    writeFileSync(join(IMAGES, safe), Buffer.from(base64, 'base64'));
    return send(res, 200, { path: `/images/${safe}` });
  }

  // Typed or pasted ASCII for the sidebar card (same file the converter writes).
  if (path === '/_admin/api/ascii-text' && method === 'PUT') {
    const { text } = JSON.parse(await readBody(req));
    const art = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    if (art.length > 40000) return send(res, 413, { error: 'That ASCII is too long (40k characters max).' });
    writeAtomic(ASCII_OUTPUT, art ? `${art}\n` : '');
    return send(res, 200, { ok: true, columns: Math.max(0, ...art.split('\n').map((l) => l.length)), rows: art ? art.split('\n').length : 0 });
  }

  if (path === '/_admin/api/ascii' && method === 'POST') {
    const { image, columns } = JSON.parse(await readBody(req));
    const name = String(image ?? '').replace(/^\/images\//, '');
    if (!/^[a-z0-9._-]+\.png$/i.test(name)) return send(res, 400, { error: 'Pick a PNG image from public/images.' });
    const file = join(IMAGES, name);
    if (!existsSync(file)) return send(res, 404, { error: `public/images/${name} not found` });
    try {
      return send(res, 200, writeAsciiFromImage(file, columns));
    } catch (err) {
      return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return send(res, 404, { error: 'Unknown admin route' });
}

export default function localAdmin() {
  return {
    name: 'local-admin',
    hooks: {
      'astro:server:setup': ({ server, logger }) => {
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (!url.pathname.startsWith('/_admin')) return next();
          if (!LOCAL.has(req.socket.remoteAddress ?? '')) return send(res, 403, { error: 'The editor only works on this computer.' });
          try {
            await handle(req, res, url);
          } catch (err) {
            send(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        });
        logger.info('local editor: http://localhost:4321/_admin');
      },
    },
  };
}
