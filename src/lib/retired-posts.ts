import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './auth';

const directory = join(DATA_DIR, 'retired-posts');
const validSlug = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function retiredOnServer(slug: string) {
  return validSlug.test(slug) && existsSync(join(directory, slug + '.txt'));
}

export function retireOnServer(slug: string) {
  if (!validSlug.test(slug)) throw new Error('Invalid post address.');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, slug + '.txt'), slug + '\n');
}
