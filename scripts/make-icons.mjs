#!/usr/bin/env node
/**
 * Generates the extension icons (16/32/48/128 px PNG) with no image dependency.
 *
 * Chrome refuses SVG in `icons` / `action.default_icon`, so the manifest needs
 * real PNGs. Rendering a padlock by hand keeps the repository free of binary
 * blobs nobody can regenerate.
 *
 * Run: npm run icons
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "extension", "icons");
const SIZES = [16, 32, 48, 128];

const BG = [11, 18, 32];
const LOCK = [103, 232, 249];
const DARK = [6, 10, 18];

function roundRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** Colour + alpha of one sample point in 0..1 space. */
function sample(x, y) {
  // Rounded square backdrop.
  if (!roundRect(x, y, 0.04, 0.04, 0.96, 0.96, 0.2)) return null;

  // Shackle: annulus, upper half, joined to the body.
  const sx = x - 0.5;
  const sy = y - 0.4;
  const r = Math.hypot(sx, sy);
  if (r >= 0.125 && r <= 0.185 && y <= 0.5) return LOCK;

  // Body.
  if (roundRect(x, y, 0.29, 0.47, 0.71, 0.79, 0.05)) {
    // Keyhole punched out of the body.
    const kx = x - 0.5;
    const ky = y - 0.61;
    if (kx * kx + ky * ky <= 0.032 * 0.032) return DARK;
    if (Math.abs(kx) <= 0.014 && y >= 0.62 && y <= 0.71) return DARK;
    return LOCK;
  }
  return BG;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const sub = 3;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          const x = (px + (sx + 0.5) / sub) / size;
          const y = (py + (sy + 0.5) / sub) / size;
          const colour = sample(x, y);
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 255;
          }
        }
      }
      const total = sub * sub;
      const i = (py * size + px) * 4;
      const alpha = a / total;
      // Average only over covered subsamples so edges keep their colour.
      const covered = a === 0 ? 1 : a / 255;
      pixels[i] = Math.round(r / covered);
      pixels[i + 1] = Math.round(g / covered);
      pixels[i + 2] = Math.round(b / covered);
      pixels[i + 3] = Math.round(alpha);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, png(size, render(size)));
  console.log(`wrote ${file}`);
}
