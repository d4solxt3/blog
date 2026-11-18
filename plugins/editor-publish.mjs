import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
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
    return await git('rev-parse', 'HEAD');
  } finally {
    active = false;
  }
}
