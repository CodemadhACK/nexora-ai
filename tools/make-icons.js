/**
 * Generates every Nexora icon from one vector description.
 *
 * Pure Node — zlib is the only thing it needs, so the brand can be regenerated
 * on any machine with `npm run icons` and nothing to install. Shapes are drawn
 * as signed distance fields and antialiased analytically, which keeps the mark
 * crisp all the way down to a 16px tray icon.
 *
 * Outputs: icon.png, icon.ico, icon.icns, favicon.png, tray-icon.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// The mark: an "N" drawn as a four-node graph, on a rounded indigo→cyan tile.
// ---------------------------------------------------------------------------

const BRAND = {
  from: [0x5b, 0x63, 0xff],   // indigo
  to:   [0x22, 0xd3, 0xee],   // cyan
  mark: [0xff, 0xff, 0xff]
};

// Normalised, y-down. A/D are the outer feet, B/C the inner joins of the N.
const A = [0.315, 0.742];
const B = [0.315, 0.258];
const C = [0.685, 0.742];
const D = [0.685, 0.258];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mix = (a, b, t) => a + (b - a) * t;

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function sdRoundBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** @returns {Buffer} RGBA pixels, size × size. */
function drawIcon(size) {
  const out = Buffer.alloc(size * size * 4);
  const aa = 1.1 / size;

  // Small renders need proportionally fatter strokes or the N dissolves.
  const stroke = size <= 32 ? 0.064 : 0.051;
  const nodeR = size <= 32 ? 0.088 : 0.074;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      const tile = sdRoundBox(u - 0.5, v - 0.5, 0.5 - 0.035, 0.5 - 0.035, 0.225);
      const alpha = smoothstep(aa, -aa, tile);

      const t = clamp(u * 0.65 + v * 0.35, 0, 1);
      let r = mix(BRAND.from[0], BRAND.to[0], t);
      let g = mix(BRAND.from[1], BRAND.to[1], t);
      let b = mix(BRAND.from[2], BRAND.to[2], t);

      let mark = Math.min(
        sdSegment(u, v, A[0], A[1], B[0], B[1]),
        sdSegment(u, v, B[0], B[1], C[0], C[1]),
        sdSegment(u, v, C[0], C[1], D[0], D[1])
      ) - stroke;
      for (const p of [A, B, C, D]) {
        mark = Math.min(mark, Math.hypot(u - p[0], v - p[1]) - nodeR);
      }

      const m = smoothstep(aa, -aa, mark);
      r = mix(r, BRAND.mark[0], m);
      g = mix(g, BRAND.mark[1], m);
      b = mix(b, BRAND.mark[2], m);

      const i = (y * size + x) * 4;
      out[i] = Math.round(r);
      out[i + 1] = Math.round(g);
      out[i + 2] = Math.round(b);
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;                                  // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** ICO with PNG payloads — supported by Windows Vista onwards. */
function encodeICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;

  images.forEach((img, i) => {
    const e = 16 * i;
    entries[e] = img.size >= 256 ? 0 : img.size;      // 0 means 256
    entries[e + 1] = img.size >= 256 ? 0 : img.size;
    entries.writeUInt16LE(1, e + 4);                  // colour planes
    entries.writeUInt16LE(32, e + 6);                 // bits per pixel
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}

/** ICNS with PNG payloads, one chunk per OSType. */
function encodeICNS(entries) {
  const body = Buffer.concat(entries.map((e) => {
    const head = Buffer.alloc(8);
    head.write(e.type, 0, 4, 'ascii');
    head.writeUInt32BE(8 + e.png.length, 4);
    return Buffer.concat([head, e.png]);
  }));

  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------------------

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICNS_TYPES = { 32: 'ic11', 64: 'ic12', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };

function main() {
  const png = new Map(SIZES.map((s) => [s, encodePNG(s, drawIcon(s))]));
  const write = (name, buf) => {
    fs.writeFileSync(path.join(ROOT, name), buf);
    console.log(`  ${name.padEnd(16)} ${(buf.length / 1024).toFixed(1)} KB`);
  };

  console.log('Nexora icons:');
  write('icon.png', png.get(512));
  write('favicon.png', png.get(32));
  write('icon.ico', encodeICO([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, png: png.get(s) }))));
  write('icon.icns', encodeICNS(
    Object.entries(ICNS_TYPES).map(([size, type]) => ({ type, png: png.get(Number(size)) }))
  ));

  // Embedded rather than read from disk so the tray never depends on a runtime
  // file path, packaged or not.
  write('tray-icon.js', Buffer.from(
    '/** Generated by tools/make-icons.js — do not edit by hand. */\n\n' +
    "'use strict';\n\n" +
    `module.exports = { TRAY_ICON_B64: '${png.get(32).toString('base64')}' };\n`,
    'utf8'
  ));
}

if (require.main === module) main();

module.exports = { drawIcon, encodePNG, encodeICO, encodeICNS, crc32 };
