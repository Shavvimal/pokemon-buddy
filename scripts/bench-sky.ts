// Drawing-cost benchmark for the Sky buddy: runs the real Actor on real
// SpriteCollab rigs, headless, on a simulated clock, and checks what it would
// send to the host against budgets. Local only; CI does not run it.
//
//   make bench        fetches the sprites on first use, then runs
//   make check        runs it only when the sprites are already fetched
//
// The sprites are game assets: they are fetched into the cache directory
// below, outside the repository, and never committed (see NOTICE.md).
//
// Node 22.7 or later (it runs with --experimental-transform-types). The mod's
// sources are copied beside the sprites as .ts, because Node's TypeScript
// support reads neither .tsx files nor imports without an extension.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Rigs that span the sizes: small (Pikachu, Gengar, Lucario) and large (Dialga). */
const SPRITES = ['0025', '0094', '0448', '0483']
const SPRITE_URL = (id: string) => `https://spriteserver.pmdcollab.org/assets/${id}/sprites.zip`
const SHAPE = { rows: 3, cellAspect: 2, pixelScale: 2 }
const BAND_COLUMNS = 100
const MINUTES = 5

/** What one rig may cost, per second of walking and watching. */
const BUDGET = { imageKBPerSecond: 48, redrawsPerSecond: 1.5, blitsPerSecond: 30 }

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
const dataDir = join(cacheHome, 'pokemon-buddy', 'bench')
const spriteDir = join(dataDir, 'sprites')
const buildDir = join(dataDir, 'build')
const shouldFetch = process.argv.includes('--fetch')

const missing = SPRITES.filter(id => !existsSync(join(spriteDir, `${id}.zip`)))
if (missing.length > 0 && !shouldFetch) {
  console.log(`bench: skipped; run 'make bench' once to fetch ${missing.length} sprites into ${dataDir}`)
  process.exit(0)
}
mkdirSync(spriteDir, { recursive: true })
for (const id of missing) {
  const response = await fetch(SPRITE_URL(id))
  if (!response.ok) throw new Error(`bench: fetching sprite ${id} failed with HTTP ${response.status}`)
  writeFileSync(join(spriteDir, `${id}.zip`), new Uint8Array(await response.arrayBuffer()))
  console.log(`bench: fetched sprite ${id}`)
}

// The hooks runtime has the native Uint8Array base64 methods; Node before 25 does not.
const proto = Uint8Array.prototype as unknown as { toBase64?: () => string }
proto.toBase64 ??= function (this: Uint8Array) {
  return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('base64')
}
const ctor = Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }
ctor.fromBase64 ??= (text: string) => new Uint8Array(Buffer.from(text, 'base64'))

mkdirSync(buildDir, { recursive: true })
copyFileSync(join(root, 'hooks', 'codecs.ts'), join(buildDir, 'codecs.ts'))
writeFileSync(
  join(buildDir, 'sky.ts'),
  readFileSync(join(root, 'hooks', 'sky.tsx'), 'utf8').replace("from './codecs'", "from './codecs.ts'")
)
const codecs = await import(join(buildDir, 'codecs.ts'))
const sky = await import(join(buildDir, 'sky.ts'))

type Timer = { at: number; fn: () => void; isCancelled: boolean }

let failures = 0
console.log(`bench: ${MINUTES} simulated minutes per rig on a ${BAND_COLUMNS}-column band, working for the first half`)
for (const id of SPRITES) {
  const zip = new Uint8Array(readFileSync(join(spriteDir, `${id}.zip`)))
  const rig = sky.buildRig(sky.pickSheets(codecs.readZip(zip)), SHAPE)

  let now = 0
  const timers: Timer[] = []
  let blits = 0
  let redraws = 0
  let bytes = 0
  const paintMs: number[] = []
  let isRenderDue = true
  let isWorking = true

  const actor = new sky.Actor(
    {
      after: (ms: number, fn: () => void) => {
        const timer = { at: now + ms, fn, isCancelled: false }
        timers.push(timer)
        return { cancel: () => void (timer.isCancelled = true) }
      },
      blit: (_site: string, source: { png: string }) => {
        blits++
        bytes += source.png.length
      },
      invalidate: () => {
        redraws++
        isRenderDue = true
      },
      random: sky.seeded(Number(id)),
    },
    rig,
    sky.profileFor(Number(id), rig)
  )
  // The host draws after an invalidate and reads the picture; time each read,
  // since a picture not yet cached is painted on the spot.
  const render = () => {
    if (!isRenderDue) return
    isRenderDue = false
    actor.drawn('band', BAND_COLUMNS)
    const started = performance.now()
    const source = actor.source as { png: string }
    paintMs.push(performance.now() - started)
    bytes += source.png.length
  }

  render()
  actor.start()
  actor.notify({ kind: 'turn-start' })
  const endMs = MINUTES * 60_000
  const started = performance.now()
  while (now < endMs) {
    timers.sort((a, b) => a.at - b.at)
    const timer = timers.shift()
    if (!timer) break
    if (timer.isCancelled) continue
    now = timer.at
    timer.fn()
    render()
    if (isWorking && now > endMs / 2) {
      isWorking = false
      actor.notify({ kind: 'turn-end', isOk: true })
    }
  }
  const cpuMs = performance.now() - started

  const seconds = endMs / 1000
  const kbPerSecond = bytes / 1024 / seconds
  const redrawsPerSecond = redraws / seconds
  const blitsPerSecond = blits / seconds
  paintMs.sort((a, b) => a - b)
  const p95 = paintMs[Math.floor(paintMs.length * 0.95)] ?? 0
  const over = [
    kbPerSecond > BUDGET.imageKBPerSecond && `image ${kbPerSecond.toFixed(0)} KB/s > ${BUDGET.imageKBPerSecond}`,
    redrawsPerSecond > BUDGET.redrawsPerSecond && `redraws ${redrawsPerSecond.toFixed(2)}/s > ${BUDGET.redrawsPerSecond}`,
    blitsPerSecond > BUDGET.blitsPerSecond && `blits ${blitsPerSecond.toFixed(1)}/s > ${BUDGET.blitsPerSecond}`,
  ].filter(Boolean)
  if (over.length > 0) failures++

  const geo = sky.geometry(rig)
  console.log(
    `${id}  picture ${geo.widthPx}x${geo.sidePx} px, ${geo.columns} cols | ` +
      `image ${kbPerSecond.toFixed(1)} KB/s, redraws ${redrawsPerSecond.toFixed(2)}/s, blits ${blitsPerSecond.toFixed(1)}/s | ` +
      `draw-time paint p95 ${p95.toFixed(2)} ms | actor CPU ${(cpuMs / seconds).toFixed(2)} ms/s` +
      (over.length > 0 ? `  OVER BUDGET: ${over.join(', ')}` : '')
  )
}

if (failures > 0) {
  console.error(`bench: ${failures} of ${SPRITES.length} rigs over budget`)
  process.exit(1)
}
console.log('bench: every rig within budget')
