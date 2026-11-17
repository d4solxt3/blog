#!/usr/bin/env node
/**
 * Make the front-page ASCII art from a black-on-white drawing (PNG).
 *
 *   npm run ascii                                  uses public/images/ascii-source.png
 *   npm run ascii -- public/images/my-drawing.png  any PNG
 *   npm run ascii -- my-drawing.png --width 80     wider / more detailed (default 64)
 *
 * Writes public/images/frontpage-ascii.txt, which the front page shows.
 */
import { relative, resolve } from 'node:path';
import { ASCII_OUTPUT, writeAsciiFromImage } from './ascii-lib.mjs';

const args = process.argv.slice(2);
const widthAt = args.indexOf('--width');
const columns = widthAt >= 0 ? Number(args[widthAt + 1]) : 64;
const file = args.find((a, i) => !a.startsWith('--') && (widthAt < 0 || i !== widthAt + 1));
const input = resolve(file ?? 'public/images/ascii-source.png');

try {
  const { columns: cols, rows } = writeAsciiFromImage(input, columns);
  console.log(`\n  ✓ ${relative(process.cwd(), input)} → ${relative(process.cwd(), ASCII_OUTPUT)} (${cols} × ${rows})\n`);
} catch (err) {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
