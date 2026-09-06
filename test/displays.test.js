'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDisplayCapture, describeDisplays, needsPicker,
  matchSource, encodeShot, captureSize, MAX_EDGE
} = require('../displays');

const RAW = [
  { id: 22, size: { width: 2560, height: 1440 }, scaleFactor: 1, bounds: { x: -2560, y: 0, width: 2560, height: 1440 } },
  { id: 11, size: { width: 1920, height: 1080 }, scaleFactor: 1.5, bounds: { x: 0, y: 0, width: 1280, height: 720 }, internal: true },
  { id: 33, size: { width: 3840, height: 2160 }, scaleFactor: 2, bounds: { x: 2560, y: 0, width: 1920, height: 1080 } }
];

const fakeImage = (png, jpeg) => ({
  isEmpty: () => false,
  toPNG: () => Buffer.alloc(png, 1),
  toJPEG: () => Buffer.alloc(jpeg, 2),
  toDataURL: () => 'data:image/png;base64,AAAA'
});

// ---------------------------------------------------------------------------
// Description and ordering
// ---------------------------------------------------------------------------

test('the primary display is always Display 1, then left to right', () => {
  const displays = describeDisplays(RAW, { primaryId: 11 });

  assert.deepEqual(displays.map((d) => d.label), ['Display 1', 'Display 2', 'Display 3']);
  assert.deepEqual(displays.map((d) => d.id), ['11', '22', '33']);
  assert.equal(displays[0].primary, true);
  assert.deepEqual(displays.map((d) => d.index), [1, 2, 3]);
});

test('each display describes itself well enough to pick from', () => {
  const [primary, left, right] = describeDisplays(RAW, { primaryId: 11 });

  assert.equal(primary.detail, '1920 × 1080 · 1.5× · Primary');
  assert.equal(left.detail, '2560 × 1440 · Secondary');
  assert.equal(right.detail, '3840 × 2160 · 2× · Secondary');
});

test('ids are strings throughout, since they cross an IPC boundary', () => {
  for (const d of describeDisplays(RAW, { primaryId: 11 })) {
    assert.equal(typeof d.id, 'string');
  }
});

test('an empty or missing display list does not throw', () => {
  assert.deepEqual(describeDisplays([]), []);
  assert.deepEqual(describeDisplays(undefined), []);
});

// ---------------------------------------------------------------------------
// When to ask
// ---------------------------------------------------------------------------

test('one display is captured directly — never ask a question with one answer', () => {
  const single = describeDisplays([RAW[0]], { primaryId: 22 });
  assert.equal(needsPicker(single, { alwaysAsk: true }), false);
  assert.equal(needsPicker([], { alwaysAsk: true }), false);
});

test('two or more displays ask by default', () => {
  const displays = describeDisplays(RAW, { primaryId: 11 });
  assert.equal(needsPicker(displays, {}), true);
  assert.equal(needsPicker(displays, { alwaysAsk: true, remembered: '11' }), true);
});

test('a remembered display suppresses the picker once the user opts out of asking', () => {
  const displays = describeDisplays(RAW, { primaryId: 11 });
  assert.equal(needsPicker(displays, { alwaysAsk: false, remembered: '33' }), false);
  // ...but a remembered display that has since been unplugged must ask again.
  assert.equal(needsPicker(displays, { alwaysAsk: false, remembered: '99' }), true);
  assert.equal(needsPicker(displays, { alwaysAsk: false, remembered: null }), true);
});

// ---------------------------------------------------------------------------
// Source matching
// ---------------------------------------------------------------------------

test('a source is matched by display id when the platform provides one', () => {
  const sources = [{ display_id: '33', name: 'Screen 3' }, { display_id: '11', name: 'Screen 1' }];
  assert.equal(matchSource(sources, '11', []).name, 'Screen 1');
});

test('when display ids are missing, position is the fallback rather than a wrong screen', () => {
  const displays = describeDisplays(RAW, { primaryId: 11 });
  const sources = [{ display_id: '', name: 'first' }, { display_id: '', name: 'second' }, { display_id: '', name: 'third' }];

  assert.equal(matchSource(sources, '22', displays).name, 'second');
  assert.equal(matchSource(sources, '33', displays).name, 'third');
  assert.equal(matchSource([], '33', displays), null);
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

test('a capture is scaled so its long edge fits the model budget', () => {
  assert.deepEqual(captureSize({ width: 3840, height: 2160 }), { width: MAX_EDGE, height: 900 });
  // Already small enough: left alone rather than upscaled.
  assert.deepEqual(captureSize({ width: 1280, height: 720 }), { width: 1280, height: 720 });
});

test('screenshots stay PNG while they are small — text has to stay crisp', () => {
  const shot = encodeShot(fakeImage(2000, 1000), { budget: 5000 });
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(shot.bytes, 2000);
});

test('an oversized capture is re-encoded as JPEG to keep the upload quick', () => {
  const shot = encodeShot(fakeImage(9000, 3000), { budget: 5000 });
  assert.equal(shot.mimeType, 'image/jpeg');
  assert.equal(shot.bytes, 3000);
});

test('JPEG is refused when it would not actually be smaller', () => {
  const shot = encodeShot(fakeImage(9000, 12000), { budget: 5000 });
  assert.equal(shot.mimeType, 'image/png');
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function fakeElectron({ sources, primaryId = 11 } = {}) {
  return {
    screen: {
      getAllDisplays: () => RAW,
      getPrimaryDisplay: () => RAW.find((d) => d.id === primaryId)
    },
    desktopCapturer: {
      calls: [],
      async getSources(opts) {
        this.calls.push(opts);
        return sources;
      }
    }
  };
}

test('capture targets the requested display and reports which one it used', async () => {
  const { screen, desktopCapturer } = fakeElectron({
    sources: [
      { display_id: '11', name: 'one', thumbnail: fakeImage(100, 50) },
      { display_id: '33', name: 'three', thumbnail: fakeImage(200, 80) }
    ]
  });

  const capture = createDisplayCapture({ screen, desktopCapturer });
  const shot = await capture.capture('33');

  assert.equal(shot.display.id, '33');
  assert.equal(shot.display.label, 'Display 3');
  assert.equal(shot.mimeType, 'image/png');
  assert.deepEqual(desktopCapturer.calls[0].thumbnailSize, captureSize({ width: 3840, height: 2160 }));
});

test('the window steps aside for the capture and is restored afterwards', async () => {
  const order = [];
  const { screen, desktopCapturer } = fakeElectron({
    sources: [{ display_id: '11', thumbnail: fakeImage(100, 50) }]
  });

  const capture = createDisplayCapture({
    screen, desktopCapturer,
    hideWindow: async () => { order.push('hidden'); return async () => order.push('restored'); }
  });

  await capture.capture('11');
  assert.deepEqual(order, ['hidden', 'restored']);
});

test('the window is restored even when the capture fails', async () => {
  const order = [];
  const { screen, desktopCapturer } = fakeElectron({ sources: [] });

  const capture = createDisplayCapture({
    screen, desktopCapturer,
    hideWindow: async () => { order.push('hidden'); return async () => order.push('restored'); }
  });

  await assert.rejects(() => capture.capture('11'));
  assert.deepEqual(order, ['hidden', 'restored'], 'a failed capture must not leave the window hidden');
});

test('an empty image becomes advice about screen-recording permission', async () => {
  const { screen, desktopCapturer } = fakeElectron({
    sources: [{ display_id: '11', thumbnail: { isEmpty: () => true } }]
  });

  await assert.rejects(
    () => createDisplayCapture({ screen, desktopCapturer }).capture('11'),
    /Screen Recording permission/
  );
});

test('an unknown display id falls back to the primary rather than failing', async () => {
  const { screen, desktopCapturer } = fakeElectron({
    sources: [{ display_id: '11', thumbnail: fakeImage(100, 50) }]
  });

  const shot = await createDisplayCapture({ screen, desktopCapturer }).capture('does-not-exist');
  assert.equal(shot.display.id, '11');
  assert.equal(shot.display.primary, true);
});

test('previews degrade to text when capture permission is missing', async () => {
  const capture = createDisplayCapture({
    screen: { getAllDisplays: () => RAW, getPrimaryDisplay: () => RAW[1] },
    desktopCapturer: { getSources: async () => { throw new Error('permission denied'); } }
  });

  const previews = await capture.previews();
  assert.equal(previews.length, 3);
  assert.ok(previews.every((p) => p.preview === null));
  assert.equal(previews[0].label, 'Display 1', 'the picker still has something to show');
});
