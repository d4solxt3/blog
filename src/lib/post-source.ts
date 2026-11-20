import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const POSTS_DIR = resolve('content/posts');
export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Same hash GitHub uses for file contents, so local and GitHub versions compare. */
export const blobSha = (content: Buffer | string) => {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
};

export type Published = { ext: 'md' | 'mdx'; source: string; sha: string };

export function readPostFile(slug: string): Published | null {
  for (const ext of ['md', 'mdx'] as const) {
    const file = join(POSTS_DIR, `${slug}.${ext}`);
    if (existsSync(file)) {
      const source = readFileSync(file, 'utf8');
      return { ext, source, sha: blobSha(source) };
    }
  }
  return null;
}
