/**
 * Owner-only arXiv / Overleaf .zip bundle builder.
 * POST { slug, tex, bib, assets: string[] } → application/zip containing
 *   main.tex, references.bib (if non-empty), and figures/<file> for each bundled image.
 */
import type { APIRoute } from 'astro';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isOwner, json, ownerOnly } from '../../../lib/auth';
import { MEDIA_FILE, readMedia, SLUG } from '../../../lib/content';

export const prerender = false;

// ---- Minimal zero-dependency ZIP (store method 0, standard CRC-32) ----
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries: Array<{ name: string; data: Uint8Array }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  const now = new Date();
  const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
  const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const crc = crc32(dataBuf);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localParts.push(local, dataBuf);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    centralParts.push(central);
    offset += local.length + dataBuf.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function resolveAssetBuffer(slug: string, assetPath: string): { fileName: string; buf: Buffer } | null {
  // Post upload path: /images/posts/<slug>/<file> or /api/media/<slug>/<file>
  const postMatch = assetPath.match(/^\/(?:images\/posts|api\/media)\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]*\.(?:png|jpg|jpeg|gif|webp|svg))$/i);
  if (postMatch) {
    const [, assetSlug, file] = postMatch;
    if (SLUG.test(assetSlug) && MEDIA_FILE.test(file)) {
      const m = readMedia(assetSlug, file);
      if (m) return { fileName: file, buf: m.buf };
    }
    const pubPath = resolve(process.cwd(), 'public/images/posts', assetSlug, file);
    if (existsSync(pubPath) && statSync(pubPath).isFile()) {
      return { fileName: file, buf: readFileSync(pubPath) };
    }
  }
  // Static public/images/<file>
  const staticMatch = assetPath.match(/^\/images\/([a-z0-9][a-z0-9._-]*\.(?:png|jpg|jpeg|gif|webp|svg))$/i);
  if (staticMatch && !assetPath.includes('..')) {
    const file = staticMatch[1];
    const pubPath = resolve(process.cwd(), 'public/images', file);
    if (existsSync(pubPath) && statSync(pubPath).isFile()) {
      return { fileName: file, buf: readFileSync(pubPath) };
    }
  }
  return null;
}

export const POST: APIRoute = async ({ request }) => {
  if (!isOwner(request)) return ownerOnly();
  const body = (await request.json().catch(() => null)) as {
    slug?: unknown;
    tex?: unknown;
    bib?: unknown;
    assets?: unknown;
  } | null;

  const slug = typeof body?.slug === 'string' && SLUG.test(body.slug) ? body.slug : 'paper';
  const tex = typeof body?.tex === 'string' ? body.tex.slice(0, 3_000_000) : '';
  const bib = typeof body?.bib === 'string' ? body.bib.slice(0, 1_000_000) : '';
  const assets = Array.isArray(body?.assets) ? body.assets.filter((a): a is string => typeof a === 'string').slice(0, 60) : [];

  if (!tex.trim()) return json({ error: 'No LaTeX source to bundle.' }, 400);

  const entries: Array<{ name: string; data: Uint8Array }> = [
    { name: 'main.tex', data: Buffer.from(tex, 'utf8') },
  ];
  if (bib.trim()) {
    entries.push({ name: 'references.bib', data: Buffer.from(bib, 'utf8') });
  }

  const addedFiles = new Set<string>();
  for (const asset of assets) {
    const resolved = resolveAssetBuffer(slug, asset);
    if (!resolved || addedFiles.has(resolved.fileName)) continue;
    addedFiles.add(resolved.fileName);
    entries.push({ name: `figures/${resolved.fileName}`, data: resolved.buf });
  }

  const zip = buildZip(entries);
  return new Response(new Uint8Array(zip), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${slug}-arxiv.zip"`,
      'cache-control': 'no-store',
    },
  });
};
