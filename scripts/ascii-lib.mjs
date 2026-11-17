/**
 * Turn a black-on-white drawing (PNG) into ASCII line art.
 * Used by `npm run ascii` (scripts/make-ascii.mjs) and the /_admin editor.
 *
 * Characters follow the direction of the lines (- | / \) rather than just
 * darkness, so line art stays crisp. No dependencies: PNG is decoded with zlib.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { resolve } from 'node:path';

export const ASCII_OUTPUT = resolve(process.cwd(), 'public/images/frontpage-ascii.txt');
const CHAR_ASPECT = 0.6; // monospace glyph width / line height

// ---------------------------------------------------------------- PNG decode
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file (convert it to PNG first).');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`Only 8-bit PNGs are supported (this one is ${depth}-bit).`);
  if (interlace) throw new Error('Interlaced PNGs are not supported; re-save without interlacing.');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`Unsupported PNG colour type ${type}.`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }

  // Ink amount per pixel: 0 = paper, 1 = black (transparent counts as paper).
  const ink = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    let r;
    let g;
    let b;
    let alpha = 255;
    if (type === 0 || type === 4) {
      r = g = b = pixels[p];
      if (type === 4) alpha = pixels[p + 1];
    } else if (type === 3) {
      const k = pixels[p] * 3;
      r = palette[k];
      g = palette[k + 1];
      b = palette[k + 2];
    } else {
      r = pixels[p];
      g = pixels[p + 1];
      b = pixels[p + 2];
      if (type === 6) alpha = pixels[p + 3];
    }
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    ink[i] = (1 - lum) * (alpha / 255);
  }
  return { width, height, ink };
}

// ---------------------------------------------------------------- ASCII
export function toAscii({ width, height, ink }, cols) {
  const cw = width / cols;
  const ch = cw / CHAR_ASPECT;
  const rows = Math.round(height / ch);
  const lines = [];
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor(col * cw);
      const x1 = Math.min(width, Math.floor((col + 1) * cw));
      const y0 = Math.floor(row * ch);
      const y1 = Math.min(height, Math.floor((row + 1) * ch));
      let n = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      const area = Math.max(1, (x1 - x0) * (y1 - y0));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (ink[y * width + x] < 0.5) continue;
          const u = (x - x0) / (x1 - x0);
          const v = (y - y0) / (y1 - y0);
          n++;
          sx += u;
          sy += v;
          sxx += u * u;
          syy += v * v;
          sxy += u * v;
        }
      }
      const cover = n / area;
      if (cover < 0.035) {
        line += ' ';
        continue;
      }
      if (cover > 0.5) {
        line += '#';
        continue;
      }
      const mx = sx / n;
      const my = sy / n;
      // Covariance in a square frame so diagonals read correctly in tall cells.
      const kx = 1;
      const ky = 1 / CHAR_ASPECT;
      const cxx = (sxx / n - mx * mx) * kx * kx;
      const cyy = (syy / n - my * my) * ky * ky;
      const cxy = (sxy / n - mx * my) * kx * ky;
      const tr = cxx + cyy;
      const det = cxx * cyy - cxy * cxy;
      const gap = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const l1 = tr / 2 + gap;
      const l2 = tr / 2 - gap;
      const elongated = l1 > 2.2 * Math.max(l2, 1e-6);
      if (!elongated) {
        // Crossing strokes read as "+"; a lone speck sits high or low in the cell.
        line += cover > 0.14 ? '+' : my > 0.6 ? '.' : my < 0.4 ? "'" : '-';
        continue;
      }
      const angle = (0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180) / Math.PI; // y points down
      const a = Math.abs(angle);
      if (a < 25) line += my > 0.68 ? '_' : '-';
      else if (a > 65) line += '|';
      else line += angle > 0 ? '\\' : '/';
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  // Trim the common left margin so the art sits flush.
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

/** Convert a PNG file and save the result as the front-page ASCII art. */
export function writeAsciiFromImage(imagePath, columns = 64) {
  const cols = Math.max(24, Math.min(140, Math.round(Number(columns) || 64)));
  const art = toAscii(decodePng(readFileSync(imagePath)), cols);
  writeFileSync(ASCII_OUTPUT, `${art}\n`, 'utf8');
  return { art, columns: cols, rows: art.split('\n').length };
}
