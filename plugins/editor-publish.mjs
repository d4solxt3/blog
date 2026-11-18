import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const git = async (...args) => (await run('git', args, {
  cwd: root, windowsHide: true, timeout: 90_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})).stdout.trim();

function publishFiles(file) {
  const source = readFileSync(resolve(root, file), 'utf8');
  const paths = new Set([file]);
  for (const match of source.matchAll(/\/images\/[a-zA-Z0-9._/-]+/g)) {
    const path = 'public' + match[0];
    const absolute = resolve(root, path);
    if (!absolute.startsWith(resolve(root, 'public/images') + sep) || !existsSync(absolute)) continue;
    if (!lstatSync(absolute).isFile() || !realpathSync(absolute).startsWith(realpathSync(resolve(root, 'public/images')) + sep)) continue;
    paths.add(path);
  }
  return [...paths];
}

const target = ['--service', 'web', '--environment', 'production'];
const inProgress = new Set(['INITIALIZING', 'QUEUED', 'WAITING', 'BUILDING', 'DEPLOYING']);
const failures = new Set(['FAILED', 'CRASHED', 'SKIPPED', 'REMOVED']);
const deployInfo = new Map();

async function railway(args) {
  // npm run dev provides npm's JS entry point on Windows, macOS and Linux.
  const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const { stdout } = await run(process.execPath, [npm, 'exec', '--yes', '--package=@railway/cli@5.75.0', '--', 'railway', ...args, ...target, '--json'], {
    cwd: root, windowsHide: true, timeout: 90_000, maxBuffer: 2_000_000,
  });
  return JSON.parse(stdout);
}

async function deployRevision(revision) {
  const deployments = await railway(['deployment', 'list', '--limit', '8']);
  const current = deployments[0];
  let id = current?.id;
  if (current?.meta?.commitHash !== revision || (!inProgress.has(current.status) && current.status !== 'SUCCESS')) {
    const deployment = await railway(['redeploy', '--commit', revision, '--yes']);
    id = deployment.id;
  }
  deployInfo.clear();
  deployInfo.set(revision, { id, checked: 0, status: 'QUEUED' });
}

export async function releaseStatus(revision) {
  const live = await fetch('https://heartcache.xyz/release.json?check=' + Date.now(), {
    cache: 'no-store', signal: AbortSignal.timeout(8000),
  }).then(response => response.ok ? response.json() : {}).catch(() => ({}));
  if (live.revision === revision) return { live: true };
  const entry = deployInfo.get(revision);
  if (entry && Date.now() - entry.checked > 20_000) {
    entry.checked = Date.now();
    const deployments = await railway(['deployment', 'list', '--limit', '8']);
    entry.status = deployments.find(d => d.id === entry.id)?.status ?? entry.status;
  }
  return { live: false, failed: failures.has(entry?.status), status: entry?.status };
}

let active = false;
export async function publishFile(file) {
  if (active) throw new Error('A publish is already running. Try again when it finishes.');
  if (file !== 'site.config.json' && !/^content\/posts\/[a-z0-9][a-z0-9-]*\.mdx?$/.test(file)) throw new Error('Invalid editor file.');
  active = true;
  try {
    if (await git('branch', '--show-current') !== 'master') throw new Error('Open the master checkout to publish.');
    await git('fetch', 'origin', 'master');
    const behind = await git('rev-list', '--count', 'HEAD..origin/master');
    if (behind !== '0') await git('merge', '--ff-only', 'origin/master');
    const ahead = await git('log', '--format=%s', 'origin/master..HEAD');
    if (ahead && ahead.split('\n').some((s) => !s.startsWith('Publish from local editor: '))) {
      throw new Error('There are other unpushed commits. Push or move those first.');
    }
    const paths = publishFiles(file);
    if (await git('status', '--porcelain', '--', ...paths)) {
      await git('add', '--', ...paths);
      await git('commit', '--only', '-m', 'Publish from local editor: ' + file, '--', ...paths);
    }
    await git('push', 'origin', 'HEAD:refs/heads/master');
    const revision = await git('rev-parse', 'HEAD');
    await deployRevision(revision);
    return revision;
  } finally {
    active = false;
  }
}
