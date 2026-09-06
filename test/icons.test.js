'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { drawIcon, encodePNG, encodeICO, encodeICNS } = require('../tools/make-icons');

const ROOT = path.join(__dirname, '..');
const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/**
 * The mark is pure float maths, so its pixels are reproducible everywhere.
 * The encoded PNG is not — deflate output varies with the zlib version — which
 * is why this pins the pixels rather than the file.
 */
test('the brand mark renders identically every time', () => {
  assert.equal(digest(drawIcon(32)), '34981f7ff62a13d3');
  assert.equal(digest(drawIcon(512)), '38942ca452521199');
  assert.equal(digest(drawIcon(64)), digest(drawIcon(64)));
});

test('the icon is a full-bleed rounded tile: opaque centre, clear corners', () => {
  const size = 64;
  const rgba = drawIcon(size);
  const alphaAt = (x, y) => rgba[(y * size + x) * 4 + 3];

  assert.equal(alphaAt(size / 2, size / 2), 255, 'the centre must be solid');
  assert.equal(alphaAt(0, 0), 0, 'the corner must be transparent, or it renders as a square');
  assert.equal(alphaAt(size - 1, size - 1), 0);

  // The tile is inset by a small margin (0.035), so mid-side goes clear → solid
  // within a few pixels rather than bleeding to the very edge.
  assert.equal(alphaAt(size / 2, 0), 0, 'the margin keeps the tile off the bitmap edge');
  assert.equal(alphaAt(size / 2, 5), 255, 'and it is solid just inside that margin');
});

test('the mark is light on a coloured tile, so it reads on any taskbar', () => {
  const size = 64;
  const rgba = drawIcon(size);
  const pixel = (x, y) => [...rgba.slice((y * size + x) * 4, (y * size + x) * 4 + 3)];

  // The left upright of the N.
  const [r, g, b] = pixel(Math.round(size * 0.315), Math.round(size * 0.5));
  assert.ok(r > 240 && g > 240 && b > 240, `expected a near-white stroke, got ${r},${g},${b}`);

  // A background corner inside the tile carries the gradient, not white.
  const [br, bg, bb] = pixel(Math.round(size * 0.12), Math.round(size * 0.5));
  assert.ok(br < 200 || bg < 200 || bb < 200, `expected the gradient, got ${br},${bg},${bb}`);
});

test('the mark survives being drawn at tray size', () => {
  // At 16px the strokes are ~1px, so this is where a design silently turns to mush.
  const size = 16;
  const rgba = drawIcon(size);
  let light = 0;
  for (let i = 0; i < size * size; i++) {
    if (rgba[i * 4] > 200 && rgba[i * 4 + 1] > 200 && rgba[i * 4 + 2] > 200 && rgba[i * 4 + 3] > 200) light++;
  }
  const share = light / (size * size);
  assert.ok(share > 0.06 && share < 0.45, `the glyph should occupy a readable share of a 16px icon, got ${(share * 100).toFixed(1)}%`);
});

// ---------------------------------------------------------------------------
// Container formats
// ---------------------------------------------------------------------------

test('encodePNG produces a valid, correctly sized PNG', () => {
  const png = encodePNG(32, drawIcon(32));

  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
  assert.equal(png[24], 8, 'bit depth');
  assert.equal(png[25], 6, 'RGBA colour type');
  assert.equal(png.toString('ascii', png.length - 8, png.length - 4), 'IEND');
});

test('encodeICO indexes each image at the right offset', () => {
  const images = [16, 32, 256].map((size) => ({ size, png: encodePNG(size, drawIcon(size)) }));
  const ico = encodeICO(images);

  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type: icon');
  assert.equal(ico.readUInt16LE(4), 3, 'image count');

  let expected = 6 + 16 * 3;
  images.forEach((img, i) => {
    const entry = 6 + 16 * i;
    assert.equal(ico[entry], img.size >= 256 ? 0 : img.size, '256 is encoded as 0');
    assert.equal(ico.readUInt16LE(entry + 6), 32, 'bits per pixel');
    assert.equal(ico.readUInt32LE(entry + 8), img.png.length);
    assert.equal(ico.readUInt32LE(entry + 12), expected, 'offset points at the payload');
    assert.equal(ico.toString('hex', expected, expected + 8), '89504e470d0a1a0a');
    expected += img.png.length;
  });
});

test('encodeICNS declares a length that matches the file', () => {
  const entries = [
    { type: 'ic07', png: encodePNG(128, drawIcon(128)) },
    { type: 'ic08', png: encodePNG(256, drawIcon(256)) }
  ];
  const icns = encodeICNS(entries);

  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length, 'the header length must match the file');

  let at = 8;
  for (const entry of entries) {
    assert.equal(icns.toString('ascii', at, at + 4), entry.type);
    assert.equal(icns.readUInt32BE(at + 4), 8 + entry.png.length);
    at += 8 + entry.png.length;
  }
  assert.equal(at, icns.length, 'the chunks should account for the whole file');
});

// ---------------------------------------------------------------------------
// What is committed
// ---------------------------------------------------------------------------

test('the committed icons are the right formats and sizes', () => {
  const png = fs.readFileSync(path.join(ROOT, 'icon.png'));
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 512, 'icon.png should be 512px for Linux and dmg');

  const ico = fs.readFileSync(path.join(ROOT, 'icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) >= 5, 'the .ico should carry several sizes');

  const icns = fs.readFileSync(path.join(ROOT, 'icon.icns'));
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
});

test('the embedded tray icon is a real PNG of the mark', () => {
  const { TRAY_ICON_B64 } = require('../tray-icon');
  const png = Buffer.from(TRAY_ICON_B64, 'base64');

  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 32, 'a 32px source, resized to 16 at runtime');
  // Embedded rather than read from disk so the tray never depends on a file path.
  assert.ok(png.length < 8000, 'it has to stay small enough to sit in source');
});
