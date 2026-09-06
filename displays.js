/**
 * Monitor enumeration and per-display capture.
 *
 * The rule this exists to enforce: with more than one display connected, never
 * guess. Grabbing "the display the window happens to sit on" is wrong roughly
 * half the time on a two-monitor desk, and a wrong screenshot costs a whole
 * round trip to notice.
 *
 * `describeDisplays` is pure so the labelling and ordering can be tested; the
 * capture half takes its Electron pieces by injection for the same reason.
 */

'use strict';

/** Long edge a capture is scaled to before it is sent to a model. */
const MAX_EDGE = 1600;

/** Past this, re-encode as JPEG — see `encodeShot`. */
const PNG_BUDGET_BYTES = 1_100_000;

/**
 * Turns Electron's display records into something a picker can render.
 * Ordered primary first, then left to right, so "Display 1" means the same
 * thing between launches.
 */
function describeDisplays(raw, { primaryId = null } = {}) {
  const displays = (raw || []).map((d) => {
    const scale = d.scaleFactor || 1;
    return {
      id: String(d.id),
      primary: primaryId != null ? String(d.id) === String(primaryId) : !!d.primary,
      width: Math.round((d.size && d.size.width) || 0),
      height: Math.round((d.size && d.size.height) || 0),
      scaleFactor: scale,
      bounds: d.bounds || null,
      internal: !!d.internal,
      rotation: d.rotation || 0
    };
  });

  displays.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    const ax = (a.bounds && a.bounds.x) || 0;
    const bx = (b.bounds && b.bounds.x) || 0;
    return ax - bx;
  });

  return displays.map((d, i) => ({
    ...d,
    index: i + 1,
    label: `Display ${i + 1}`,
    detail: [
      `${d.width} × ${d.height}`,
      d.scaleFactor !== 1 ? `${d.scaleFactor}×` : null,
      d.primary ? 'Primary' : d.internal ? 'Built-in' : 'Secondary'
    ].filter(Boolean).join(' · ')
  }));
}

/**
 * Whether a saved window rectangle still overlaps a connected display.
 *
 * Monitors get unplugged. Restoring a window to a position that no longer exists
 * puts it somewhere the user cannot reach it, which looks exactly like the app
 * failing to open — so both the launch path and the Presentation Mode restore
 * path check first.
 */
function boundsOnAnyDisplay(bounds, displays) {
  if (!bounds || !Number.isInteger(bounds.x) || !Number.isInteger(bounds.y)) return false;
  return (displays || []).some((d) => {
    const area = d.workArea || d.bounds;
    if (!area) return false;
    return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x &&
           bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
  });
}

/** Only ask when there is something to ask about. */
function needsPicker(displays, { remembered = null, alwaysAsk = true } = {}) {
  if (!displays || displays.length < 2) return false;
  if (alwaysAsk) return true;
  return !displays.some((d) => d.id === String(remembered));
}

/**
 * Picks the source matching a display id, tolerating the id mismatch that
 * happens on some Linux and Wayland setups where `display_id` comes back empty.
 */
function matchSource(sources, displayId, displays) {
  const exact = sources.find((s) => String(s.display_id) === String(displayId));
  if (exact) return exact;

  // Fall back to positional order, which desktopCapturer keeps stable.
  const index = (displays || []).findIndex((d) => d.id === String(displayId));
  if (index >= 0 && sources[index]) return sources[index];
  return sources[0] || null;
}

/**
 * PNG keeps text crisp, which is what a screenshot of a coding problem is made
 * of — so it stays the default. Only when a capture is large enough to slow the
 * upload noticeably do we trade to JPEG, and then at a quality where code is
 * still legible.
 */
function encodeShot(image, { budget = PNG_BUDGET_BYTES } = {}) {
  const png = image.toPNG();
  if (png.length <= budget) {
    return { dataBase64: png.toString('base64'), mimeType: 'image/png', bytes: png.length };
  }
  const jpeg = image.toJPEG(84);
  return jpeg.length < png.length
    ? { dataBase64: jpeg.toString('base64'), mimeType: 'image/jpeg', bytes: jpeg.length }
    : { dataBase64: png.toString('base64'), mimeType: 'image/png', bytes: png.length };
}

function thumbSize(display, width) {
  const ratio = display.height && display.width ? display.height / display.width : 0.5625;
  return { width, height: Math.max(1, Math.round(width * ratio)) };
}

function captureSize(display, maxEdge = MAX_EDGE) {
  const { width, height } = display;
  const scale = Math.min(1, maxEdge / Math.max(width || 1, height || 1));
  return {
    width: Math.max(1, Math.round((width || maxEdge) * scale)),
    height: Math.max(1, Math.round((height || maxEdge) * scale))
  };
}

function createDisplayCapture({ screen, desktopCapturer, hideWindow = async () => () => {}, log = () => {} }) {
  function list() {
    let primaryId = null;
    try { primaryId = screen.getPrimaryDisplay().id; } catch { /* headless */ }
    return describeDisplays(screen.getAllDisplays(), { primaryId });
  }

  /**
   * Small previews for the picker. Best-effort by design: on a machine where
   * capture permission has not been granted this returns no images, and the
   * picker still works from the text description alone.
   */
  async function previews({ width = 240 } = {}) {
    const displays = list();
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: thumbSize(displays[0] || { width: 16, height: 9 }, width)
      });
      return displays.map((d) => {
        const source = matchSource(sources, d.id, displays);
        const thumb = source && source.thumbnail && !source.thumbnail.isEmpty()
          ? source.thumbnail.toDataURL()
          : null;
        return { ...d, preview: thumb, name: source ? source.name : d.label };
      });
    } catch (err) {
      log(`could not build display previews: ${err.message}`);
      return displays.map((d) => ({ ...d, preview: null, name: d.label }));
    }
  }

  /** @param {string|null} displayId — null captures the primary display. */
  async function capture(displayId, { maxEdge = MAX_EDGE } = {}) {
    const displays = list();
    if (!displays.length) throw new Error('No displays detected.');

    const target = displays.find((d) => d.id === String(displayId)) ||
                   displays.find((d) => d.primary) ||
                   displays[0];

    const restore = await hideWindow();      // never capture our own window
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: captureSize(target, maxEdge)
      });
      const source = matchSource(sources, target.id, displays);
      if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
        throw new Error('That display returned an empty image. On macOS, grant Screen Recording permission and restart.');
      }
      return { ...encodeShot(source.thumbnail), display: target };
    } finally {
      await restore();
    }
  }

  return { list, previews, capture };
}

module.exports = {
  createDisplayCapture, describeDisplays, needsPicker, boundsOnAnyDisplay,
  matchSource, encodeShot, captureSize, thumbSize,
  MAX_EDGE, PNG_BUDGET_BYTES
};
