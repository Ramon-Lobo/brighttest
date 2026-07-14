'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Optional session video: assemble the per-step screenshots a run already captures into a single
// slideshow video (or GIF) with ffmpeg. Roku's ECP has no video-out; the dev screenshot endpoint tops
// out at ~1 fps (see experiments/VIDEO-FINDINGS.md), so this is a labelled step-by-step replay, not
// smooth-motion capture. ffmpeg is an optional external tool — absent, we skip with a note.

function ffmpegAvailable() {
  try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; }
  catch (e) { return false; }
}

// Assemble `frames` (absolute image paths, in order) into `outPath` (.mp4 or .gif). Each frame is held
// for `secondsPerFrame`. Returns { ok, outPath, reason? }.
function assembleVideo(frames, outPath, { secondsPerFrame = 1.5, width = 960 } = {}) {
  if (!frames || !frames.length) return { ok: false, reason: 'no frames' };
  if (!ffmpegAvailable()) return { ok: false, reason: 'ffmpeg not found on PATH' };
  const isGif = /\.gif$/i.test(outPath);
  const esc = (f) => f.replace(/'/g, "'\\''");
  // concat demuxer: hold each frame for a duration; the last entry must be repeated (a demuxer quirk)
  // for the final frame's duration to apply.
  const list = frames.map((f) => `file '${esc(f)}'\nduration ${secondsPerFrame}`).join('\n') +
    `\nfile '${esc(frames[frames.length - 1])}'\n`;
  const listPath = path.join(os.tmpdir(), `brighttest-video-${process.pid}-${frames.length}.txt`);
  fs.writeFileSync(listPath, list);
  const vf = isGif
    ? `fps=10,scale=${width}:-2:flags=lanczos`
    : `scale=${width}:-2,format=yuv420p`;
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-vf', vf];
  if (!isGif) args.push('-r', '30');
  args.push(outPath);
  const r = spawnSync('ffmpeg', args, { stdio: 'ignore' });
  try { fs.unlinkSync(listPath); } catch (e) { /* ignore */ }
  return { ok: r.status === 0, outPath, reason: r.status === 0 ? undefined : 'ffmpeg failed' };
}

module.exports = { ffmpegAvailable, assembleVideo };
