import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ffmpegAvailable, assembleVideo } from '../lib/e2e/video.js'

describe('video assembly', () => {
  it('ffmpegAvailable returns a boolean', () => {
    expect(typeof ffmpegAvailable()).toBe('boolean')
  })

  it('returns ok:false with a reason when there are no frames', () => {
    const r = assembleVideo([], path.join(os.tmpdir(), 'x.mp4'))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no frames/)
  })

  // Only runs where ffmpeg exists (local dev, most CI images). Skipped otherwise so the suite stays green
  // on minimal machines.
  it.skipIf(!ffmpegAvailable())('assembles PNG frames into a real mp4', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-video-'))
    // three 2x2 solid PNGs (red/green/blue) via tiny hand-built files would be fiddly; use ffmpeg to make
    // test frames from a color source instead.
    const { spawnSync } = require('node:child_process')
    const frames = ['a', 'b', 'c'].map((n, i) => {
      const f = path.join(dir, `f${i}.png`)
      spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=0x${['ff0000', '00ff00', '0000ff'][i]}:s=64x36`, '-frames:v', '1', f], { stdio: 'ignore' })
      return f
    })
    const out = path.join(dir, 'session.mp4')
    const r = assembleVideo(frames, out, { secondsPerFrame: 0.2, width: 64 })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
