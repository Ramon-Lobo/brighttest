import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { census } = require('../lib/instrument/census.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-census-scale-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

// N components that all import one shared script (the importer lookup is per file) and extend a short chain of bases
// (the extends resolution is per component). Every 10th is a Task, the rest are Scenes.
function tree(name, n) {
  const d = path.join(tmp, name); const c = path.join(d, 'components'); fs.mkdirSync(c, { recursive: true })
  fs.writeFileSync(path.join(d, 'manifest'), 'title=Scale\n')
  fs.writeFileSync(path.join(c, 'Shared.brs'), 'sub init()\n  x = CreateObject("roUrlTransfer")\n  x.setUrl("http://a.test/x")\nend sub\n')
  fs.writeFileSync(path.join(c, 'BaseScene.xml'), '<?xml version="1.0"?>\n<component name="BaseScene" extends="Scene"><script type="text/brightscript" uri="Shared.brs"/></component>\n')
  fs.writeFileSync(path.join(c, 'BaseTask.xml'), '<?xml version="1.0"?>\n<component name="BaseTask" extends="Task"><script type="text/brightscript" uri="Shared.brs"/></component>\n')
  for (let i = 0; i < n; i++) {
    const base = i % 10 === 0 ? 'BaseTask' : 'BaseScene'
    fs.writeFileSync(path.join(c, `C${i}.xml`), `<?xml version="1.0"?>\n<component name="C${i}" extends="${base}"><script type="text/brightscript" uri="pkg:/components/Shared.brs"/></component>\n`)
  }
  return d
}
const cpuMs = async (d) => { const u = process.cpuUsage(); const r = await census(d); const t = process.cpuUsage(u); return { r, ms: (t.user + t.system) / 1000 } }

describe('census scales near-linearly with component count', () => {
  it('doubling the components does not multiply the time by much more than two', async () => {
    const small = tree('s', 600); const big = tree('b', 1200)
    await cpuMs(small) // warm the parser
    // Windows CPU time advances in ~15.6 ms ticks, so a 30 ms sample is only two ticks. Each sample runs the census
    // several times (small sample well over 150 ms) and the best of five is kept, which swamps the tick.
    const REPS = 6
    const sample = async (d) => { const u = process.cpuUsage(); for (let i = 0; i < REPS; i++) await census(d); const t = process.cpuUsage(u); return (t.user + t.system) / 1000 }
    const best = async (d) => { const xs = []; for (let i = 0; i < 5; i++) xs.push(await sample(d)); return Math.min(...xs) }
    const a = await best(small); const b = await best(big)
    // Linear gives about 2 at double the size; a quadratic regression gives about 4 or more. 4 leaves room for noise.
    expect(b / a).toBeLessThan(4)
    const { r } = await cpuMs(big)
    expect(r.counts.components).toBe(1202)
    expect(r.tasks.length).toBe(121)
    expect(r.scenes.length).toBe(1081)
  }, 120000)
})
