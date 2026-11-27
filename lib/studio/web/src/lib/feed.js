// Browser capture-card feed helpers. All pure (no DOM); the storage object is passed in.
// The calibration rectangle C = { x, y, w, h } is the active picture area inside the video frame, normalized 0..1.

const ASPECT = 16 / 9;
const MIN_SIDE = 0.05;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v) => Math.round(v * 1e6) / 1e6;

export const FULL_RECT = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

// The 16:9 picture area of a frame: the whole frame when it is 16:9 (within 1 %), else the centered 16:9 rect (contain).
export function autoRect(frameW, frameH) {
  if (!(frameW > 0) || !(frameH > 0)) return { ...FULL_RECT };
  const ar = frameW / frameH;
  if (Math.abs(ar / ASPECT - 1) <= 0.01) return { ...FULL_RECT };
  if (ar > ASPECT) { const w = round(frameH * ASPECT / frameW); return { x: round((1 - w) / 2), y: 0, w, h: 1 }; }
  const h = round(frameW / ASPECT / frameH);
  return { x: 0, y: round((1 - h) / 2), w: 1, h };
}

// CSS for the <video> (transform-origin 0 0, inside overflow hidden): the active area fills the 16:9 box.
export function cropTransform(rect) {
  const r = rect && rect.w > 0 && rect.h > 0 ? rect : FULL_RECT;
  return `scale(${round(1 / r.w)}, ${round(1 / r.h)}) translate(${round(-r.x * 100)}%, ${round(-r.y * 100)}%)`;
}

// dx, dy: scene pixels to move the picture area; sw, sh: percent change of its width and height.
// The picture moves with a positive dx (the area moves left in the frame), so the picture shifts right.
export function applyNudge(rect, scene, { dx = 0, dy = 0, sw = 0, sh = 0 } = {}) {
  const sceneW = scene && scene.w > 0 ? scene.w : 1920;
  const sceneH = scene && scene.h > 0 ? scene.h : 1080;
  const w = clamp(rect.w * (1 + sw / 100), MIN_SIDE, 1);
  const h = clamp(rect.h * (1 + sh / 100), MIN_SIDE, 1);
  // Scene pixels to frame units: one scene width is rect.w of the frame.
  const x = clamp(rect.x - (dx / sceneW) * rect.w, 0, 1 - w);
  const y = clamp(rect.y - (dy / sceneH) * rect.h, 0, 1 - h);
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

const validRect = (c) => c && ['x', 'y', 'w', 'h'].every((k) => typeof c[k] === 'number' && Number.isFinite(c[k]))
  && c.w >= MIN_SIDE && c.h >= MIN_SIDE && c.x >= 0 && c.y >= 0 && c.x + c.w <= 1.000001 && c.y + c.h <= 1.000001;

const calKey = (deviceId) => `bt.studio.feed.${deviceId}`;

// -> { v:1, label, C, auto } or null (missing, bad JSON, wrong version, bad rectangle, no storage).
export function loadCal(storage, deviceId) {
  try {
    const j = JSON.parse(storage.getItem(calKey(deviceId)));
    if (!j || j.v !== 1 || !validRect(j.C)) return null;
    return { v: 1, label: typeof j.label === 'string' ? j.label : '', C: { x: j.C.x, y: j.C.y, w: j.C.w, h: j.C.h }, auto: !!j.auto };
  } catch { return null; }
}

// -> true when stored; false when storage is missing, full or blocked.
export function saveCal(storage, deviceId, { label = '', C, auto = false }) {
  if (!validRect(C)) return false;
  try { storage.setItem(calKey(deviceId), JSON.stringify({ v: 1, label, C, auto })); return true; } catch { return false; }
}

const LAST_KEY = 'bt.studio.feedlast';
export const loadLastFeed = (storage) => { try { return storage.getItem(LAST_KEY) || null; } catch { return null; } };
export const saveLastFeed = (storage, deviceId) => { try { deviceId ? storage.setItem(LAST_KEY, deviceId) : storage.removeItem(LAST_KEY); } catch {} };

// getUserMedia error name -> a sentence for the user.
export function friendlyError(name) {
  switch (name) {
    case 'NotAllowedError': case 'SecurityError': return 'Camera access was denied. Allow it in the browser site settings, then pick the feed again.';
    case 'NotFoundError': case 'OverconstrainedError': case 'DevicesNotFoundError': return 'That capture device was not found. Check the cable and pick the feed again.';
    case 'NotReadableError': case 'TrackStartError': return 'The feed is in use by another app. Close it there, or keep using device screenshots.';
    case 'AbortError': return 'The capture device failed to start. Unplug it, plug it in again and retry.';
    case 'TypeError': return 'This browser cannot open a capture device on this address. Use http://localhost or https.';
    default: return 'Could not open the feed' + (name ? ` (${name})` : '') + '.';
  }
}

// ── overlay age and settling (video is live, the boxes come from the 300 ms tree reads) ──

// "boxes 0.3 s old"; '' when no tree has been read yet.
export function boxAgeText(ms) {
  if (!(ms >= 0)) return '';
  return `boxes ${(Math.round(ms / 100) / 10).toFixed(1)} s old`;
}

// The focused node paths, as one string: equal strings mean the focus did not move between two reads.
export function focusSig(nodes) {
  return (nodes || []).filter((n) => n && n.focused).map((n) => n.path || n.id || '').sort().join('|');
}

// Shown while a feed is live: on macOS only one app can configure the capture card at a time.
export const CARD_HELD_HINT = 'Studio holds this capture card while the feed is live; other apps (ffmpeg, OBS) cannot open it. Pick Device screenshots to free it.'
export const SETTLE_MAX_MS = 3000;
// One step after a tree read. A press starts { settling: true, prev: null }. The boxes are solid again once two
// consecutive reads agree on the focused set, or after SETTLE_MAX_MS.
export function settleStep({ settling, prev, pressAt = 0 }, sig, now) {
  if (!settling) return { settling: false, prev: sig };
  if (prev !== null && prev === sig) return { settling: false, prev: sig };
  if (pressAt && now - pressAt >= SETTLE_MAX_MS) return { settling: false, prev: sig };
  return { settling: true, prev: sig };
}
