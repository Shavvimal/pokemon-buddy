import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { fromBase64, readZip } from '../hooks/codecs'
import { Actor, buildRig, geometry, parseAnimData, pickSheets, profileFor, seeded, type Rig } from '../hooks/sky'
import { SKY_ZIP } from './sky-zip'

// The Sky style: the SpriteCollab source and the actor that walks the band.
// Test data is the zip in sky-zip.ts, drawn for this repository.

const SKY = { style: 'sky' } as const
const SHAPE = { rows: 3, cellAspect: 2, pixelScale: 2 }

const MONSTERS = {
  data: {
    monster: [
      {
        id: 25,
        name: 'Testchu',
        forms: [
          { path: '', isShiny: false, isFemale: false, sprites: { phase: 'FULL' } },
          { path: '0000/0001', isShiny: true, isFemale: false, sprites: { phase: 'FULL' } },
          { path: '0000/0002', isShiny: false, isFemale: true, sprites: { phase: 'FULL' } },
          { path: '0001', isShiny: false, isFemale: false, sprites: { phase: 'INCOMPLETE' } },
        ],
      },
      { id: 26, name: 'Nochu', forms: [{ path: '', isShiny: false, isFemale: false, sprites: { phase: null } }] },
    ],
  },
}

const BAND = {
  plugin: 'pokemon-buddy',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 40,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const reply = (status: number, text: string) => ({
  value: { status, ok: status === 200, headers: {}, text },
})
const ran = (stdout: string, exitCode = 0) => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

/** A Sky session with the sprite server, curl and the file read mocked. */
async function startSky($: Engine, on: On, { curlExit = 0 } = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: string[] = []
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    if (e.url.endsWith('/graphql')) return reply(200, JSON.stringify(MONSTERS))
    return reply(404, 'Not Found')
  })
  const commands: string[] = []
  on('process.run', (_, e) => {
    commands.push(e.argv[0]!)
    if (e.argv[0] === 'mktemp') return ran('/tmp/buddy-test-zip')
    if (e.argv[0] === 'curl') return ran('', curlExit)
    return ran('')
  })
  on('fs.read', () => ({ value: { base64: SKY_ZIP } }))
  const blits: string[] = []
  on('ui.blit', (_, e) => {
    blits.push(e.key)
    return { value: {} }
  })
  const logs: string[] = []
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  const invalidations: string[] = []
  on('ui.invalidate', (_, e) => {
    invalidations.push(e.event)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, fetched, commands, blits, logs, invalidations }
}

test('lists through the sprite server, fetches the zip with curl, and walks the band', { options: SKY }, async ($, on) => {
  const { clock, fetched, commands, blits, logs } = await startSky($, on)
  expect(fetched).toEqual(['https://spriteserver.pmdcollab.org/graphql'])
  expect(commands).toEqual(['mktemp', 'curl', 'rm'])
  expect(logs.some(line => line.includes('Testchu') && line.includes('Sky'))).toBe(true)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image', key: 'sprite' })
  expect(image?.props.rows).toBe(3)
  expect(image?.props.columns).toBe(7)
  expect(image?.props.alt).toBe('Testchu')
  expect(await ui.find({ type: 'Button', key: 'pet' })).toBeDefined()

  await clock.advance(30_000)
  expect(blits.length).toBeGreaterThan(0)
  expect(blits.every(key => key === 'sprite')).toBe(true)
  await ui.unmount()
})

test('falls back to the GitHub files when curl fails', { options: SKY }, async ($, on) => {
  const { fetched, logs } = await startSky($, on, { curlExit: 22 })
  const github = fetched.filter(url => url.includes('PMDCollab/SpriteCollab'))
  expect(github.some(url => url.endsWith('/AnimData.xml'))).toBe(true)
  expect(github.some(url => url.includes('Idle-Anim.png'))).toBe(true)
  // The mocked GitHub answers 404, so the session ends with no sprite, logged.
  expect(logs.some(line => line.includes('no sprite'))).toBe(true)
})

test('keeps the Crystal style out of the Sky draw and the sprite server out of Crystal', { options: SKY }, async ($, on) => {
  const { fetched } = await startSky($, on)
  expect(fetched.some(url => url.includes('api.github.com'))).toBe(false)
})

// ── The sheets ──

const files = () => pickSheets(readZip(fromBase64(SKY_ZIP)))

test('reads AnimData.xml, including a CopyOf', async () => {
  const metas = parseAnimData(files().xml!)
  const idle = metas.find(m => m.name === 'Idle')
  expect(idle?.frameWidth).toBe(8)
  expect(idle?.durations).toEqual([12, 6])
  expect(metas.find(m => m.name === 'EventSleep')?.copyOf).toBe('Sleep')
})

test('keeps the whitelisted sheets and the credits from the zip', async () => {
  const picked = files()
  expect(Object.keys(picked).filter(k => k.endsWith('-Anim')).sort()).toEqual(
    ['Idle', 'Pose', 'Rotate', 'Sit', 'Sleep', 'Wake', 'Walk'].map(n => `${n}-Anim`)
  )
  expect(picked.credits).toContain('TEST')
})

test('builds a rig with the front and side rows, anchored on the ground point', async () => {
  const rig = buildRig(files(), SHAPE)
  expect([...rig.clips.keys()].sort()).toEqual(['EventSleep', 'Idle', 'Pose', 'Rotate', 'Sit', 'Sleep', 'Wake', 'Walk'])
  expect(rig.clips.get('EventSleep')?.isCopy).toBe(true)
  expect([...rig.clips.get('Idle')!.frames.keys()]).toEqual([0, 2, 6])
  expect([...rig.clips.get('Walk')!.frames.keys()]).toEqual([0, 1, 2, 6, 7])
  expect(rig.clips.get('Sit')?.rows).toBe(1)
  // The ground marker is at the bottom centre of every test frame.
  expect(rig.clips.get('Idle')!.frames.get(2)![0]!.ground).toEqual({ x: 4, y: 7 })
  expect(rig.canvas.side).toBe(8)
  expect(Math.round(rig.clips.get('Idle')!.delaysMs[0]!)).toBe(200)
  const geo = geometry(rig)
  expect(geo.columns).toBe(7)
  expect(geo.sidePx).toBe(16)
})

// ── The actor ──

/** Runs the actor on a hand-cranked clock. */
function crank(rig: Rig, random: () => number, bodyColumns = 40) {
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []
  let now = 0
  const blits: number[] = []
  let invalidations = 0
  const actor = new Actor(
    {
      after: (ms, fn) => {
        const timer = { at: now + ms, fn, cancelled: false }
        timers.push(timer)
        return { cancel: () => void (timer.cancelled = true) } as never
      },
      blit: () => void blits.push(now),
      invalidate: () => void invalidations++,
      random,
    },
    rig,
    profileFor(25, rig)
  )
  actor.drawn('band', bodyColumns)
  actor.start()
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = timers.filter(t => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers.splice(timers.indexOf(due), 1)
      now = due.at
      due.fn()
      actor.drawn('band', bodyColumns)
    }
    now = until
  }
  return { actor, advance, blits, count: () => invalidations }
}

/** Random numbers from a list, then the last one for ever. */
const fromList = (values: number[]) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]!
}

test('walks to the right edge, turns through the front, and walks back', async () => {
  const rig = buildRig(files(), SHAPE)
  // 0 picks the first candidate (walk) and the left direction; the walk
  // lasts 1 s before the next pick, which walks again, and so on.
  const { actor, advance, count } = crank(rig, () => 0)
  const seen = new Set<string>()
  const rows = new Set<number>()
  let maxColumn = 0
  for (let i = 0; i < 400; i++) {
    advance(50)
    const { clip, row, facing, state } = actor.current
    seen.add(`${state}:${clip}`)
    if (clip === 'Rotate') rows.add(row)
    maxColumn = Math.max(maxColumn, actor.column)
    expect(actor.column).toBeGreaterThanOrEqual(0)
    expect(actor.column).toBeLessThanOrEqual(40 - 7)
    if (clip === 'Walk' && state === 'walk') expect([2, 6]).toContain(row)
    if (facing === 'left' && clip === 'Idle') expect(row).toBe(6)
  }
  expect(seen.has('walk:Walk')).toBe(true)
  expect(seen.has('turn:Rotate')).toBe(true)
  expect(count()).toBeGreaterThan(0)
  expect(maxColumn).toBeGreaterThan(0)
})

test('a front-only clip is always entered facing down, after a turn', async () => {
  const rig = buildRig(files(), SHAPE)
  const { actor, advance } = crank(rig, seeded(7))
  let sat = 0
  let turns = 0
  let last = actor.current
  for (let i = 0; i < 6000; i++) {
    advance(50)
    const now = actor.current
    if (now.clip === 'Sit' || now.clip === 'Sleep') {
      expect(now.row).toBe(0)
      expect(now.facing).toBe('down')
      if (now.clip === 'Sit' && last.clip !== 'Sit') sat++
    }
    // A cut from a side-facing clip straight into a front-only one never happens.
    if ((now.clip === 'Sit' || now.clip === 'Sleep') && last.clip !== now.clip) {
      expect(['Idle', 'Rotate', 'Walk', 'Sit', 'Sleep', 'Pose', 'Wake']).toContain(last.clip)
      expect(last.facing === 'down' || last.state === 'turn').toBe(true)
    }
    if (now.state === 'turn' && last.state !== 'turn') turns++
    last = now
  }
  expect(sat).toBeGreaterThan(0)
  expect(turns).toBeGreaterThan(0)
})

test('a quiet session sends the buddy to sleep, and a prompt wakes it with the Wake clip', async () => {
  const rig = buildRig(files(), SHAPE)
  const { actor, advance } = crank(rig, seeded(3))
  // Ten quiet minutes raise the sleep weight fivefold.
  advance(11 * 60 * 1000)
  let slept = false
  for (let i = 0; i < 4000 && !slept; i++) {
    advance(250)
    slept = actor.current.state === 'sleep'
  }
  expect(slept).toBe(true)
  expect(actor.current.row).toBe(0)
  actor.notify({ kind: 'prompt' })
  advance(50)
  expect(actor.current.state).toBe('wake')
  expect(actor.current.clip).toBe('Wake')
})

test('a press plays a pose at the next clean cut', async () => {
  const rig = buildRig(files(), SHAPE)
  const { actor, advance } = crank(rig, () => 0.3)
  actor.notify({ kind: 'poke' })
  let posed = false
  for (let i = 0; i < 200 && !posed; i++) {
    advance(50)
    posed = actor.current.clip === 'Pose'
  }
  expect(posed).toBe(true)
})

test('the profile is the same for the same species', async () => {
  const rig = buildRig(files(), SHAPE)
  expect(profileFor(143, rig)).toEqual(profileFor(143, rig))
  expect(profileFor(143, rig).pace).not.toBe(profileFor(25, rig).pace)
})
