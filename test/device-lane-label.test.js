import { describe, it, expect } from 'vitest'
import device from '../lib/device.js'

describe('device lane header label (DEV2-04)', () => {
  it('uses deviceLabel with host, model and firmware, never the serial', () => {
    const h = device.laneHeader({ host: '1.2.3.4' }, { deviceInfo: { model: 'Ultra', softwareVersion: '16.0.4', build: '853', serial: 'SECRET' } })
    expect(h).toBe('  building, deploying to 1.2.3.4 · Ultra · firmware 16.0.4 (build 853), and running…')
    expect(h).not.toContain('SECRET')
  })
  it('host-only info labels with the host', () => {
    expect(device.laneHeader({ host: '1.2.3.4' })).toBe('  building, deploying to 1.2.3.4, and running…')
  })
  it('empty info keeps the old header text', () => {
    expect(device.laneHeader({})).toBe('  building, deploying to the device, and running…')
  })
})
