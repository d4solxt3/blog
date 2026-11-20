import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { slugify, isRetiredLocally } from '../../scripts/post-template.mjs';
import { DATA_DIR } from './auth';
import { POSTS_DIR, SLUG } from './post-source';
import { retiredOnServer } from './retired-posts';

const indexFile = join(DATA_DIR, 'post-addresses.json');

function readOwners(): Map<string, string> {
  return existsSync(indexFile) ? new Map(JSON.parse(readFileSync(indexFile, 'utf8'))) : new Map();
}

export function addressOwner(address: string): string | undefined {
  return SLUG.test(address) ? readOwners().get(address) : undefined;
}

function isReserved(address: string) {
  return isRetiredLocally(address) || retiredOnServer(address)
    || existsSync(join(POSTS_DIR, address + '.md')) || existsSync(join(POSTS_DIR, address + '.mdx'))
    || existsSync(join(DATA_DIR, 'drafts', address + '.json'))
    || existsSync(join(DATA_DIR, 'published-posts', address + '.json'));
}

// Stable post IDs own their historical links. Only the displayed title determines
// which of those links is canonical. Keep all claims, including those for deleted posts.
export function assignAddresses(posts: { id: string; title: string }[]) {
  const owners = readOwners();
  const before = owners.size;
  const current = new Map<string, string>();
  for (const { id } of posts) if (!owners.has(id)) owners.set(id, id);
  for (const { id, title } of posts) {
    const base = slugify(title.replace(/['’]/g, '')).replace(/-+$/, '');
    let candidate = base;
    for (let n = 2; owners.get(candidate) !== id && (owners.has(candidate) || isReserved(candidate)); n++) {
      const suffix = '-' + n;
      candidate = base.slice(0, 80 - suffix.length).replace(/-+$/, '') + suffix;
    }
    owners.set(candidate, id);
    current.set(id, candidate);
  }
  if (owners.size !== before) {
    mkdirSync(DATA_DIR, { recursive: true });
    const temporary = indexFile + '.' + randomUUID();
    writeFileSync(temporary, JSON.stringify([...owners]), { mode: 0o600 });
    renameSync(temporary, indexFile);
  }
  return current;
}

export function publishedUrl(id: string, title: string) {
  return '/posts/' + assignAddresses([{ id, title }]).get(id) + '/';
}
