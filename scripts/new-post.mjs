#!/usr/bin/env node
// Usage: npm run new-post "My Post Title"
import { relative } from 'node:path';
import { createPost } from './post-template.mjs';

const title = process.argv.slice(2).join(' ').trim();
if (!title) {
  console.error('Usage: npm run new-post "My Post Title"');
  process.exit(1);
}

try {
  const { slug, file } = createPost(title);
  console.log(`\n  ✓ created ${relative(process.cwd(), file)}`);
  console.log(`    it's a draft: it shows at http://localhost:4321/posts/${slug}/ while "npm run dev" is running.`);
  console.log(`    set "draft: false" in the file when you're ready to publish.\n`);
} catch (err) {
  console.error(`\n  ✗ ${err.message}\n`);
  process.exit(1);
}
