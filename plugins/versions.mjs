// Version shelf for the local editor (dev only — /_admin/versions).
//
//  - Shelf: every commit on the current branch, plus named snapshots of the
//    working tree. Snapshots are ordinary git commits kept under
//    refs/versions/* (written with a throwaway index, so the editor's files,
//    branch and staging area are never touched).
//  - Preview: a chosen revision is exported (git cat-file) into its own folder
//    outside the repo, built there, and served read-only on 127.0.0.1:43xx with
//    an empty data folder and no credentials. The editor tree never changes.
//  - Publish: a separate, explicit step. It builds one new commit on top of
//    the destination branch whose tree is the selected version's own source
//    (what the preview built), plus the destination's newer posts, retirement
//    records and the media those posts use. Fast-forward push only — never
//    --force. Mutating calls need same-origin loopback + x-versions-action.
//    Destinations:
//      mock — a local bare repo in the versions store (for testing)
//      live — origin/master + the Railway deploy the editor already uses;
//             only enabled when the dev server starts with VERSIONS_LIVE_PUBLISH=1
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, createReadStream } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = process.cwd();
const STORE = join(tmpdir(), 'blog-versions', createHash('sha1').update(ROOT).digest('hex').slice(0, 10));
const PREVIEWS = join(STORE, 'previews');
const MOCK = join(STORE, 'mock-remote.git');
const REF_PREFIX = 'refs/versions/';
const PAGE = resolve(ROOT, 'admin/versions.html');
const LIVE_ENABLED = process.env.VERSIONS_LIVE_PUBLISH === '1';
const MAX_RUNNING = 3;

// Never part of a snapshot or a publish, whatever .gitignore says.
const dataRel = process.env.DATA_DIR ? relative(ROOT, resolve(process.env.DATA_DIR)).replace(/\\/g, '/') : '';
const EXCLUDE = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /^(data|dist|node_modules|\.astro|\.git)\//,
  /(^|\/)admin-password\.json$/,
  /(^|\/)session-secret$/,
  /(^|\/)comments[^/]*\.json$/,
  /(^|\/)drafts\//,
  /(^|\/)\.railway\//,
];
const excluded = (p) => EXCLUDE.some((re) => re.test(p)) || (dataRel && !dataRel.startsWith('..') && (p === dataRel || p.startsWith(dataRel + '/')));

// ---------------------------------------------------------------- git helpers

const baseEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
async function git(args, { env = {}, input } = {}) {
  if (input === undefined) {
    const { stdout } = await run('git', args, { cwd: ROOT, env: { ...baseEnv, ...env }, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    return stdout;
  }
  return new Promise((ok, fail) => {
    const child = spawn('git', args, { cwd: ROOT, env: { ...baseEnv, ...env }, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok(Buffer.concat(out).toString('utf8')) : fail(new Error(Buffer.concat(err).toString('utf8').trim() || `git ${args[0]} failed`))));
    child.stdin.end(input);
  });
}
const trim = async (args, opts) => (await git(args, opts)).trim();

const REV = /^[0-9a-f]{7,40}$/;
async function resolveRev(rev) {
  if (typeof rev !== 'string' || !(REV.test(rev) || rev.startsWith(REF_PREFIX))) throw Object.assign(new Error('Unknown revision.'), { status: 400 });
  try {
    return await trim(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  } catch {
    throw Object.assign(new Error('That revision is not in this repository.'), { status: 404 });
  }
}

const postPath = (p) => /^(src\/)?content\/(posts|blog)\/[^/]+\.(md|mdx)$/.test(p);
const kindOf = (p) => (postPath(p) ? 'posts' : /^content\/retired-posts\//.test(p) ? 'retired' : p === 'site.config.json' ? 'config' : p.startsWith('public/') ? 'media' : 'source');

// ---------------------------------------------------------------------- shelf

async function shelf() {
  const branch = (await trim(['branch', '--show-current'])) || 'HEAD';
  const head = await trim(['rev-parse', 'HEAD']);
  let tracked = ''; // origin/master as last fetched: the tracked branch, not proof of what's deployed
  try {
    tracked = await trim(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master']);
  } catch {}
  const snaps = (await git(['for-each-ref', REF_PREFIX, '--sort=-creatordate', '--format=%(objectname)%00%(creatordate:iso-strict)%00%(subject)%00%(refname)']))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [rev, date, name, ref] = line.split('\0');
      return { kind: 'snapshot', rev, short: rev.slice(0, 7), date, name, ref };
    });
  const commits = (await git(['log', 'HEAD', '-n', '200', '--format=%H%x00%cI%x00%s']))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [rev, date, name] = line.split('\0');
      return { kind: 'commit', rev, short: rev.slice(0, 7), date, name, head: rev === head, tracked: rev === tracked };
    });
  const entries = [...snaps, ...commits].map((e) => ({ ...e, preview: previewState(e.rev) }));
  return { branch, head, tracked, store: STORE, liveEnabled: LIVE_ENABLED, entries };
}

// ------------------------------------------------------------------ snapshots

async function snapshot(rawName) {
  const name = String(rawName ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) throw Object.assign(new Error('Give the version a name.'), { status: 400 });
  const files = (await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
    .split('\0')
    .filter((p) => p && !excluded(p) && existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile());
  if (!files.length) throw new Error('Nothing to save.');
  mkdirSync(STORE, { recursive: true });
  const index = join(STORE, `snapshot-index-${randomUUID()}`);
  try {
    // A fresh index: the editor's own staging area (.git/index) is untouched.
    await git(['update-index', '--add', '-z', '--stdin'], { env: { GIT_INDEX_FILE: index }, input: files.join('\0') + '\0' });
    const tree = await trim(['write-tree'], { env: { GIT_INDEX_FILE: index } });
    const commit = await trim(['commit-tree', tree, '-p', 'HEAD', '-m', name]);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'version';
    const ref = `${REF_PREFIX}${stamp}-${slug}`;
    // Do not replace an existing named version if two saves coincide.
    await git(['update-ref', ref, commit, '0'.repeat(40)]);
    return { rev: commit, short: commit.slice(0, 7), name, ref, files: files.length };
  } finally {
    rmSync(index, { force: true });
  }
}

// -------------------------------------------------------------------- preview

const previews = new Map(); // rev → { status, port, url, log, error, child, server, at }
let buildQueue = Promise.resolve();

function previewState(rev) {
  const p = previews.get(rev);
  if (!p) return { status: existsSync(join(PREVIEWS, rev, 'built.ok')) ? 'built' : 'none' };
  return { status: p.status, url: p.url, error: p.error, log: p.log.slice(-1200) };
}

const freePort = (from) =>
  new Promise((ok) => {
    const tryPort = (port) => {
      const s = createNetServer();
      s.once('error', () => tryPort(port + 1));
      s.listen(port, '127.0.0.1', () => s.close(() => ok(port)));
    };
    tryPort(from);
  });

/** Write every file of `rev` into `dir` with one `git cat-file --batch`. */
async function exportTree(rev, dir) {
  const entries = (await git(['ls-tree', '-r', '-z', rev]))
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      const [mode, type, sha] = meta.split(' ');
      return { mode, type, sha, path };
    })
    .filter((e) => e.type === 'blob' && !excluded(e.path));
  await new Promise((ok, fail) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: ROOT, env: baseEnv, windowsHide: true });
    let buf = Buffer.alloc(0);
    let i = 0;
    child.stdout.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        const header = buf.subarray(0, nl).toString();
        const size = Number(header.split(' ')[2]);
        if (buf.length < nl + 1 + size + 1) return;
        const body = buf.subarray(nl + 1, nl + 1 + size);
        buf = buf.subarray(nl + 1 + size + 1);
        const e = entries[i++];
        const target = join(dir, ...e.path.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body);
      }
    });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 && i === entries.length ? ok() : fail(new Error('Could not export that revision.'))));
    child.stdin.end(entries.map((e) => e.sha).join('\n') + '\n');
  });
  return entries.length;
}

/** Only what a build and a server need — no tokens, passwords or Railway settings. */
function cleanEnv(extra) {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, NODE_ENV: 'production', ASTRO_TELEMETRY_DISABLED: '1', ...extra };
}

function runLogged(cmd, args, opts, entry) {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { ...opts, windowsHide: true });
    const add = (d) => (entry.log = (entry.log + d.toString()).slice(-8000));
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`${args.at(-1)} exited with ${code}`))));
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm' };
/** For static-output layouts (no server entry): a tiny read-only file server. */
function staticServer(root, port) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return res.writeHead(400).end(); }
    let file = resolve(root, '.' + p);
    if (file !== root && !file.startsWith(root + sep)) return res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) file = existsSync(join(root, '404.html')) ? join(root, '404.html') : '';
    if (!file) return res.writeHead(404).end('Not found');
    res.writeHead(file.endsWith('404.html') && !p.endsWith('404.html') ? 404 : 200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

/** Forwards GET/HEAD to the preview's SSR server; refuses everything else. */
function readOnlyProxy(innerPort, port) {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('This is a read-only preview: nothing can be posted or saved here.');
    }
    const headers = { ...req.headers, host: `127.0.0.1:${innerPort}` };
    delete headers.cookie;
    delete headers.authorization;
    const up = httpRequest({ host: '127.0.0.1', port: innerPort, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end('Preview server unavailable.'));
    up.end();
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

async function waitForHttp(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('The preview server did not start.');
}

function stopPreview(rev) {
  const p = previews.get(rev);
  if (!p) return;
  p.child?.kill();
  p.server?.close();
  previews.delete(rev);
}
process.on('exit', () => previews.forEach((p) => (p.child?.kill(), p.server?.close())));

async function startPreview(rawRev) {
  const rev = await resolveRev(rawRev);
  const existing = previews.get(rev);
  if (existing && existing.status !== 'error') return previewState(rev);
  const entry = { status: 'queued', log: '', at: Date.now() };
  previews.set(rev, entry);
  buildQueue = buildQueue.then(() => buildAndServe(rev, entry)).catch(() => {});
  return previewState(rev);
}

async function buildAndServe(rev, entry) {
  const dir = join(PREVIEWS, rev);
  const src = join(dir, 'src-tree');
  const active = () => previews.get(rev) === entry;
  if (!active()) return;
  try {
    if (!existsSync(join(dir, 'built.ok'))) {
      entry.status = 'exporting';
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(src, { recursive: true });
      const n = await exportTree(rev, src);
      entry.log += `exported ${n} files from ${rev.slice(0, 7)}\n`;
      // Dependencies: link the editor's installed packages (read-only use).
      symlinkSync(resolve(ROOT, 'node_modules'), join(src, 'node_modules'), 'junction');
      entry.status = 'building';
      const astro = resolve(ROOT, 'node_modules/astro/bin/astro.mjs');
      await runLogged(process.execPath, [astro, 'build'], { cwd: src, env: cleanEnv({ DATA_DIR: join(dir, 'data') }) }, entry);
      writeFileSync(join(dir, 'built.ok'), new Date().toISOString());
    }
    if (!active()) return;
    const running = [...previews.entries()].filter(([, p]) => p.status === 'ready').sort((a, b) => a[1].at - b[1].at);
    while (running.length >= MAX_RUNNING) stopPreview(running.shift()[0]);
    entry.status = 'starting';
    const port = await freePort(4330);
    const url = `http://127.0.0.1:${port}/`;
    const serverEntry = join(src, 'dist', 'server', 'entry.mjs');
    if (existsSync(serverEntry)) {
      // The SSR server listens on a private port; visitors reach it through a
      // read-only proxy (GET/HEAD only), with an empty data folder: no real
      // comments, sessions or drafts, and nothing can be posted.
      mkdirSync(join(dir, 'data'), { recursive: true });
      const inner = await freePort(port + 500);
      if (!active()) return;
      entry.child = spawn(process.execPath, [serverEntry], {
        cwd: src,
        env: cleanEnv({ HOST: '127.0.0.1', PORT: String(inner), DATA_DIR: join(dir, 'data') }),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const add = (d) => (entry.log = (entry.log + d.toString()).slice(-8000));
      entry.child.stdout.on('data', add);
      entry.child.stderr.on('data', add);
      entry.child.on('exit', () => {
        entry.server?.close();
        if (active() && entry.status === 'ready') stopPreview(rev);
      });
      await waitForHttp(`http://127.0.0.1:${inner}/`);
      if (!active()) return;
      entry.server = await readOnlyProxy(inner, port);
    } else {
      const out = [join(src, 'dist', 'client'), join(src, 'dist')].find((d) => existsSync(join(d, 'index.html')));
      if (!out) throw new Error('This revision built, but there is no server entry or index.html to serve.');
      entry.server = await staticServer(out, port);
    }
    if (!active()) { entry.server?.close(); return; }
    await waitForHttp(url);
    Object.assign(entry, { status: 'ready', url, port, at: Date.now() });
  } catch (err) {
    entry.status = 'error';
    entry.error = err instanceof Error ? err.message : String(err);
    entry.child?.kill();
    entry.server?.close();
  }
}

// -------------------------------------------------------------------- publish

async function destinations() {
  let origin = '';
  try {
    origin = (await trim(['remote', 'get-url', 'origin'])).replace(/\/\/[^@/]*@/, '//');
  } catch {}
  return {
    mock: { id: 'mock', label: 'local mock remote (test)', url: MOCK, branch: 'master', enabled: true },
    live: {
      id: 'live',
      label: 'GitHub origin + Railway deploy',
      url: origin,
      branch: 'master',
      enabled: LIVE_ENABLED && !!origin,
      why: LIVE_ENABLED ? '' : 'off: start the dev server with VERSIONS_LIVE_PUBLISH=1 to enable live releases',
    },
  };
}

async function ensureMock() {
  if (existsSync(join(MOCK, 'HEAD'))) return;
  mkdirSync(STORE, { recursive: true });
  // A bare clone of this repo: the "remote" starts exactly where master is.
  await git(['clone', '--bare', '--quiet', ROOT, MOCK]);
}

async function destHead(dest) {
  if (dest.id === 'mock') {
    await ensureMock();
    const line = await trim(['ls-remote', MOCK, `refs/heads/${dest.branch}`]);
    const head = line.split(/\s+/)[0];
    if (!head) throw new Error('The mock remote has no master branch.');
    try {
      await git(['cat-file', '-e', `${head}^{commit}`]);
    } catch {
      await git(['fetch', '--quiet', MOCK, `refs/heads/${dest.branch}`]);
    }
    return head;
  }
  if (!dest.enabled) throw Object.assign(new Error(dest.why || 'Live releases are off.'), { status: 403 });
  await git(['fetch', '--quiet', 'origin', dest.branch]);
  return trim(['rev-parse', 'FETCH_HEAD']);
}

const lsTree = async (rev) =>
  (await git(['ls-tree', '-r', '-z', rev]))
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split('\t');
      const [mode, type, sha] = meta.split(' ');
      return { mode, type, sha, path, line };
    })
    .filter((e) => e.type === 'blob');

const retiredRecord = (p) => /^content\/retired-posts\/[^/]+\.txt$/.test(p);

/**
 * The release tree is the selected version's own source tree — exactly what
 * the preview built — plus, from the destination, only what must survive:
 *   - posts that exist only at the destination (newer posts),
 *   - retirement records (deleted posts stay deleted),
 *   - media those kept posts reference,
 *   - private paths this tool never manages (.env, data, …).
 * Newer source files (routes, scripts) that the version doesn't have are
 * removed, so an old design never ships code its preview didn't contain.
 */
async function releaseTree(head, rev) {
  const selected = (await lsTree(rev)).filter((e) => !excluded(e.path));
  const dest = await lsTree(head);
  const slug = (path) => path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.'));
  const retired = new Set([...dest, ...selected].filter((e) => retiredRecord(e.path)).map((e) => slug(e.path)));
  const isRetiredPost = (e) => postPath(e.path) && retired.has(slug(e.path));
  const version = selected.filter((e) => !isRetiredPost(e));
  const versionSlugs = new Set(version.filter((e) => postPath(e.path)).map((e) => slug(e.path)));
  const inVersion = new Set(version.map((e) => e.path));
  const keep = [];
  const kept = { posts: [], retired: [], media: [], private: [] };
  const keptPosts = dest.filter((e) => postPath(e.path) && !isRetiredPost(e) && !versionSlugs.has(slug(e.path)));
  const keptPostPaths = new Set(keptPosts.map((e) => e.path));
  // Media referenced by the kept posts (same rule the editor's publisher uses).
  const wanted = new Set();
  for (const e of keptPosts) {
    const text = await git(['cat-file', 'blob', e.sha]);
    for (const m of text.matchAll(/\/images\/[a-zA-Z0-9._/-]+/g)) wanted.add('public' + m[0]);
  }
  for (const e of dest) {
    if (inVersion.has(e.path)) continue;
    if (keptPostPaths.has(e.path)) (keep.push(e), kept.posts.push(e.path));
    else if (retiredRecord(e.path)) (keep.push(e), kept.retired.push(e.path));
    else if (wanted.has(e.path)) (keep.push(e), kept.media.push(e.path));
    else if (excluded(e.path)) (keep.push(e), kept.private.push(e.path));
  }
  mkdirSync(STORE, { recursive: true });
  const index = join(STORE, `publish-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await git(['read-tree', '--empty'], { env });
    const lines = [...version, ...keep].map((e) => e.line);
    if (lines.length) await git(['update-index', '--add', '-z', '--index-info'], { env, input: lines.join('\0') + '\0' });
    return { tree: await trim(['write-tree'], { env }), kept };
  } finally {
    rmSync(index, { force: true });
  }
}


async function plan(rawRev, destId) {
  const rev = await resolveRev(rawRev);
  const dests = await destinations();
  const dest = dests[destId];
  if (!dest) throw Object.assign(new Error('Unknown destination.'), { status: 400 });
  const head = await destHead(dest);
  const { tree, kept } = await releaseTree(head, rev);
  const headTree = await trim(['rev-parse', `${head}^{tree}`]);
  const bucket = () => ({ added: [], changed: [], removed: [] });
  const impact = { posts: { ...bucket(), kept: kept.posts }, config: bucket(), media: { ...bucket(), kept: kept.media }, source: bucket(), retired: { ...bucket(), kept: kept.retired }, private: { kept: kept.private.length } };
  const diff = (await git(['diff-tree', '-r', '-z', '--name-status', '--no-renames', headTree, tree])).split('\0').filter(Boolean);
  const verb = { A: 'added', M: 'changed', T: 'changed', D: 'removed' };
  for (let i = 0; i < diff.length; i += 2) {
    const v = verb[diff[i][0]] ?? 'changed';
    impact[kindOf(diff[i + 1])][v].push(diff[i + 1]);
  }
  // Line counts for the content that changes (posts and site settings).
  const stat = {};
  for (const line of (await git(['diff', '--numstat', '--no-renames', headTree, tree, '--', 'content', 'src/content', 'site.config.json'])).split('\n').filter(Boolean)) {
    const [plus, minus, path] = line.split('\t');
    stat[path] = `+${plus} −${minus}`;
  }
  impact.lines = stat;
  const [subject, date] = (await trim(['log', '-1', '--format=%s%x00%cI', rev])).split('\0');
  return {
    destination: { id: dest.id, label: dest.label, url: dest.url, branch: dest.branch, head, headShort: head.slice(0, 7) },
    version: { rev, short: rev.slice(0, 7), name: subject, date },
    tree,
    unchanged: tree === headTree,
    impact,
  };
}

async function publish({ rev: rawRev, destination, confirm, expectHead, expectTree }) {
  const p = await plan(rawRev, destination);
  if (confirm !== p.version.short) throw Object.assign(new Error(`Type ${p.version.short} to confirm.`), { status: 400 });
  if (expectHead !== p.destination.head || expectTree !== p.tree) {
    throw Object.assign(new Error('The destination changed since this plan was made. Review the new plan and confirm again.'), { status: 409 });
  }
  if (p.unchanged) throw Object.assign(new Error('Nothing to release: the destination already matches this version.'), { status: 409 });
  const message = `Release "${p.version.name}" (${p.version.short})\n\nPublished from the local version shelf.\nVersion: ${p.version.rev}`;
  const commit = await trim(['commit-tree', p.tree, '-p', p.destination.head, '-m', message]);
  const remote = p.destination.id === 'mock' ? MOCK : 'origin';
  // No --force: git refuses anything that isn't a fast-forward.
  await git(['push', '--porcelain', remote, `${commit}:refs/heads/${p.destination.branch}`]);
  let deploy = null;
  let deployError = '';
  if (p.destination.id === 'live') {
    // The push has landed. If the deploy request fails, the release can be
    // retried from here without pushing again.
    pushedAwaitingDeploy.add(commit);
    ({ deploy, deployError } = await requestDeploy(commit));
  }
  const log = p.destination.id === 'mock' ? (await git(['--git-dir', MOCK, 'log', '-3', '--format=%h %s', p.destination.branch])).trim().split('\n') : [];
  return { commit, short: commit.slice(0, 7), pushed: true, destination: p.destination, version: p.version, deploy, deployError, remoteLog: log };
}

const pushedAwaitingDeploy = new Set();
async function requestDeploy(commit) {
  try {
    const { deployRevision } = await import('./editor-publish.mjs');
    await deployRevision(commit);
    pushedAwaitingDeploy.delete(commit);
    return { deploy: 'requested', deployError: '' };
  } catch (err) {
    return { deploy: 'failed', deployError: err instanceof Error ? err.message : String(err) };
  }
}

/** Retry only the Railway step for a commit this shelf already pushed. */
async function retryDeploy(commit) {
  if (!LIVE_ENABLED) throw Object.assign(new Error('Live releases are off.'), { status: 403 });
  if (!/^[0-9a-f]{40}$/.test(String(commit)) || !pushedAwaitingDeploy.has(commit)) {
    throw Object.assign(new Error('No pushed release is waiting for a deploy with that revision.'), { status: 400 });
  }
  return { commit, ...(await requestDeploy(commit)) };
}

// ------------------------------------------------------------------- routing

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

/**
 * Every action that changes something (a snapshot ref, a preview build or
 * server, the mock remote, a release) must come from the versions page itself:
 * same origin, a loopback host, and an explicit x-versions-action header —
 * the same pattern as the editor's own publisher.
 */
const ACTIONS = {
  '/_admin/api/versions/snapshot': 'snapshot',
  '/_admin/api/versions/preview': 'preview',
  '/_admin/api/versions/preview-stop': 'preview-stop',
  '/_admin/api/versions/plan': 'plan',
  '/_admin/api/versions/publish': 'publish',
  '/_admin/api/versions/deploy-retry': 'deploy-retry',
};
function allowed(req, path) {
  const want = ACTIONS[path];
  if (!want) return true;
  const origin = req.headers.origin ?? '';
  try {
    return origin === 'http://' + req.headers.host && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname) && req.headers['x-versions-action'] === want;
  } catch {
    return false;
  }
}

/** Returns true when the request was a versions route. */
export async function handleVersions(req, res, path) {
  const method = req.method ?? 'GET';
  if (path === '/_admin/versions' && method === 'GET') return send(res, 200, readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8'), true;
  if (!path.startsWith('/_admin/api/versions')) return false;
  if (method !== 'GET' && !allowed(req, path)) return send(res, 403, { error: 'Use the versions page in the local editor.' }), true;
  try {
    if (path === '/_admin/api/versions' && method === 'GET') return send(res, 200, await shelf()), true;
    if (path === '/_admin/api/versions/destinations' && method === 'GET') return send(res, 200, await destinations()), true;
    if (path === '/_admin/api/versions/snapshot' && method === 'POST') return send(res, 200, await snapshot((await body(req)).name)), true;
    if (path === '/_admin/api/versions/preview' && method === 'POST') return send(res, 200, await startPreview((await body(req)).rev)), true;
    if (path === '/_admin/api/versions/preview-stop' && method === 'POST') {
      stopPreview(await resolveRev((await body(req)).rev));
      return send(res, 200, { ok: true }), true;
    }
    if (path === '/_admin/api/versions/plan' && method === 'POST') {
      const b = await body(req);
      return send(res, 200, await plan(b.rev, b.destination)), true;
    }
    if (path === '/_admin/api/versions/publish' && method === 'POST') return send(res, 200, await publish(await body(req))), true;
    if (path === '/_admin/api/versions/deploy-retry' && method === 'POST') return send(res, 200, await retryDeploy((await body(req)).commit)), true;
    return send(res, 404, { error: 'Unknown versions route' }), true;
  } catch (err) {
    send(res, err?.status ?? 500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

export { excluded as versionExcluded };
