/**
 * Sky buddies: a Pokémon from PMDCollab/SpriteCollab (the Pokémon Mystery
 * Dungeon: Explorers of Sky style) that walks the band above the prompt and
 * acts with some character.
 *
 * Three parts, top to bottom:
 * - sheets: AnimData.xml and the per-action sprite sheets become a `Rig`,
 *   every frame anchored on its ground point so clips cut cleanly;
 * - painting: one frame of the rig, shifted by a few pixels, as an image
 *   the band draws;
 * - the actor: facing, position, a small state machine, weighted choices
 *   with drives and a per-species profile, and the session events it
 *   notices.
 *
 * The data format is described in docs/spritecollab-format.md and the
 * design in docs/sky-buddy-design.md. No sprite is stored in this
 * repository.
 */
import type { ImageSource, Timer } from 'claude-code'
import { decodePng, encodePng, fromBase64, toBase64 } from './codecs'

// ── Sheets ──────────────────────────────────────────────────────────────────

/** The actions the buddy may play, in the order they are looked for. */
export const SKY_ACTIONS = [
  'Idle', 'Walk', 'Sleep', 'Rotate', 'Wake', 'Charge', 'Attack', 'Pose', 'Nod', 'Sit',
  'LookUp', 'Eat', 'Laying', 'Pull', 'DeepBreath', 'Tumble', 'Cringe', 'LostBalance',
  'Float', 'EventSleep',
] as const

export type SkyAction = (typeof SKY_ACTIONS)[number]

/** Actions whose lunge makes their frames far larger than the rest. */
const WIDE_ACTIONS: ReadonlySet<string> = new Set(['Attack'])

/** The eight direction rows of a sheet, top to bottom. */
export const ROW = { down: 0, downRight: 1, right: 2, upRight: 3, up: 4, upLeft: 5, left: 6, downLeft: 7 } as const

/** Rows the rig keeps: the side views, the front, and the two front quarters
 * of Walk (a turn without Rotate steps through them). */
const KEPT_ROWS: readonly number[] = [ROW.down, ROW.right, ROW.left]
const KEPT_WALK_ROWS: readonly number[] = [ROW.down, ROW.downRight, ROW.right, ROW.left, ROW.downLeft]

const TICK_MS = 1000 / 60

export type AnimMeta = {
  name: string
  frameWidth: number
  frameHeight: number
  /** Per frame, in 60 fps ticks. */
  durations: number[]
  copyOf?: string
}

/** Reads the `<Anim>` entries of an AnimData.xml. */
export function parseAnimData(xml: string): AnimMeta[] {
  const field = (body: string, tag: string) =>
    new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(body)?.[1]
  return [...xml.matchAll(/<Anim>([\s\S]*?)<\/Anim>/g)].flatMap(([, body = '']) => {
    const name = field(body, 'Name')
    if (!name) return []
    const copyOf = field(body, 'CopyOf')
    if (copyOf) return [{ name, frameWidth: 0, frameHeight: 0, durations: [], copyOf }]
    const frameWidth = Number(field(body, 'FrameWidth'))
    const frameHeight = Number(field(body, 'FrameHeight'))
    const durations = [...body.matchAll(/<Duration>\s*(\d+)\s*<\/Duration>/g)].map(m => Number(m[1]))
    if (!(frameWidth > 0 && frameHeight > 0) || durations.length === 0) return []
    return [{ name, frameWidth, frameHeight, durations }]
  })
}

/** The files one Sky sprite keeps: `xml` as text, each sheet as base64 PNG. */
export type SkyFiles = Record<string, string>

/**
 * Keeps, from a sprite's zip, AnimData.xml and the three sheets of each
 * action the buddy may play (a `CopyOf` keeps its source's sheets instead).
 */
export function pickSheets(members: Map<string, () => Uint8Array>): SkyFiles {
  const read = (name: string) => members.get(name)?.()
  const xmlBytes = read('AnimData.xml')
  if (!xmlBytes) throw new Error('sprite zip has no AnimData.xml')
  const decoder = new TextDecoder()
  const xml = decoder.decode(xmlBytes)
  const files: SkyFiles = { xml }
  const credits = read('credits.txt')
  if (credits) files.credits = decoder.decode(credits)
  const metas = new Map(parseAnimData(xml).map(meta => [meta.name, meta]))
  const wanted = new Set<string>()
  for (const action of SKY_ACTIONS) {
    const meta = metas.get(action)
    if (meta) wanted.add(meta.copyOf ?? action)
  }
  for (const name of wanted) {
    for (const kind of ['Anim', 'Offsets', 'Shadow']) {
      const bytes = read(`${name}-${kind}.png`)
      if (bytes) files[`${name}-${kind}`] = toBase64(bytes)
    }
  }
  return files
}

type Point = { x: number; y: number }

/** One frame of one row: its pixels, where its feet are, and how far its
 * opaque pixels reach from there (left, right, up and down, in pixels). */
type FrameData = { rgba: Uint8Array; ground: Point; reach: { left: number; right: number; up: number; down: number } }

export type Clip = {
  name: string
  frameWidth: number
  frameHeight: number
  /** 1 for a front-only sheet (it faces the viewer), else 8. */
  rows: number
  delaysMs: number[]
  /** The kept rows, each the clip's frames in order. */
  frames: Map<number, FrameData[]>
  /** True when the sheets belong to another action (`CopyOf`). */
  isCopy: boolean
}

export type RigShape = { rows: number; cellAspect: number; pixelScale: number }

export type Rig = {
  kind: 'rig'
  clips: Map<string, Clip>
  /** The fixed box every frame is painted into, in sprite pixels, square. */
  canvas: { side: number; groundX: number; groundY: number }
  shape: RigShape
  /** The sprite's credits.txt, when the zip had one. */
  credits?: string
}

/** Builds the rig: every kept frame of every kept action, anchored. */
export function buildRig(files: SkyFiles, shape: RigShape): Rig {
  const xml = files.xml
  if (!xml) throw new Error('sprite has no AnimData.xml')
  const metas = new Map(parseAnimData(xml).map(meta => [meta.name, meta]))
  const clips = new Map<string, Clip>()

  for (const action of SKY_ACTIONS) {
    const meta = metas.get(action)
    if (!meta) continue
    const source = meta.copyOf ? metas.get(meta.copyOf) : meta
    if (!source || source.copyOf) continue
    const sheets = ['Anim', 'Offsets', 'Shadow'].map(kind => files[`${source.name}-${kind}`])
    if (!sheets[0]) continue
    try {
      const clip = decodeClip(source, sheets[0], sheets[1], sheets[2], action === 'Walk')
      clips.set(action, { ...clip, name: action, isCopy: Boolean(meta.copyOf) })
    } catch {
      // A sheet this decoder cannot read leaves the action out; the rest play.
    }
  }
  if (!clips.has('Idle')) throw new Error('sprite has no Idle animation')

  return { kind: 'rig', clips, canvas: fitCanvas(clips), shape, credits: files.credits }
}

function decodeClip(
  meta: AnimMeta,
  animBase64: string,
  offsetsBase64: string | undefined,
  shadowBase64: string | undefined,
  isWalk: boolean
): Omit<Clip, 'name' | 'isCopy'> {
  const anim = decodePng(fromBase64(animBase64))
  if (anim.kind !== 'rgba') throw new Error(`${meta.name} sheet is not RGBA`)
  const offsets = offsetsBase64 ? decodePng(fromBase64(offsetsBase64)) : undefined
  const shadow = shadowBase64 ? decodePng(fromBase64(shadowBase64)) : undefined

  const { frameWidth, frameHeight } = meta
  const rows = Math.floor(anim.height / frameHeight)
  const count = Math.min(Math.floor(anim.width / frameWidth), meta.durations.length)
  if ((rows !== 1 && rows !== 8) || count < 1) throw new Error(`${meta.name} sheet has an odd shape`)

  const keptRows = rows === 1 ? [0] : isWalk ? KEPT_WALK_ROWS : KEPT_ROWS
  const frames = new Map<number, FrameData[]>()
  for (const row of keptRows) {
    const list: FrameData[] = []
    for (let i = 0; i < count; i++) {
      const tile = { left: i * frameWidth, top: row * frameHeight, width: frameWidth, height: frameHeight }
      const rgba = cutTile(anim.rgba, anim.width, tile)
      const ground =
        (shadow?.kind === 'rgba' ? findMarker(shadow.rgba, shadow.width, tile, isWhite) : undefined) ??
        (offsets?.kind === 'rgba' ? findMarker(offsets.rgba, offsets.width, tile, isGreen) : undefined) ??
        { x: Math.floor(frameWidth / 2), y: frameHeight - 1 }
      list.push({ rgba, ground, reach: reachOf(rgba, frameWidth, frameHeight, ground) })
    }
    frames.set(row, list)
  }

  return {
    frameWidth,
    frameHeight,
    rows,
    delaysMs: meta.durations.slice(0, count).map(ticks => Math.max(1, ticks) * TICK_MS),
    frames,
  }
}

type Tile = { left: number; top: number; width: number; height: number }

function cutTile(rgba: Uint8Array, sheetWidth: number, tile: Tile): Uint8Array {
  const out = new Uint8Array(tile.width * tile.height * 4)
  for (let y = 0; y < tile.height; y++) {
    const from = ((tile.top + y) * sheetWidth + tile.left) * 4
    out.set(rgba.subarray(from, from + tile.width * 4), y * tile.width * 4)
  }
  return out
}

/** How far a frame's opaque pixels reach from its ground point; a frame
 * carries transparent padding, which must not push the feet off the floor. */
function reachOf(rgba: Uint8Array, width: number, height: number, ground: Point): FrameData['reach'] {
  let minX = width
  let maxX = -1
  let minY = height
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  }
  if (maxX < 0) return { left: 0, right: 0, up: 0, down: 0 }
  return {
    left: Math.max(0, ground.x - minX),
    right: Math.max(0, maxX - ground.x),
    up: Math.max(0, ground.y - minY),
    down: Math.max(0, maxY - ground.y),
  }
}

const isWhite = (r: number, g: number, b: number) => r === 255 && g === 255 && b === 255
/** Green, or any mix that holds it: the markers combine where they overlap. */
const isGreen = (_r: number, g: number, _b: number) => g === 255

function findMarker(
  rgba: Uint8Array,
  sheetWidth: number,
  tile: Tile,
  matches: (r: number, g: number, b: number) => boolean
): Point | undefined {
  for (let y = 0; y < tile.height; y++) {
    for (let x = 0; x < tile.width; x++) {
      const at = ((tile.top + y) * sheetWidth + tile.left + x) * 4
      if (rgba[at + 3] === 255 && matches(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!)) return { x, y }
    }
  }
  return undefined
}

/**
 * The square box that holds the opaque pixels of every kept frame once its
 * ground point sits at one place, with the feet on the bottom edge, leaving
 * out the wide attack frames (they are clipped to it).
 */
function fitCanvas(clips: Map<string, Clip>): Rig['canvas'] {
  let left = 0
  let right = 0
  let up = 0
  let down = 0
  for (const clip of clips.values()) {
    if (WIDE_ACTIONS.has(clip.name)) continue
    for (const frames of clip.frames.values()) {
      for (const { reach } of frames) {
        left = Math.max(left, reach.left)
        right = Math.max(right, reach.right)
        up = Math.max(up, reach.up)
        down = Math.max(down, reach.down)
      }
    }
  }
  const width = left + right + 1
  const height = up + down + 1
  const side = Math.max(width, height)
  return {
    side,
    groundX: left + Math.floor((side - width) / 2),
    groundY: up + (side - height),
  }
}

// ── Painting ────────────────────────────────────────────────────────────────
// One frame into the canvas, upscaled, with the canvas a few terminal
// columns wider than the sprite: the sprite shifts by pixels inside it, and
// the band moves the picture only when the sprite reaches its far side.

/**
 * The spare columns the picture carries beside the sprite. A column move
 * redraws the band, which competes with typing; a swap does not. Three spare
 * columns make one redraw every three columns of walk, for a picture that
 * is mostly transparent and costs little more as a PNG.
 */
export const SLACK_COLUMNS = 3

/** The painted picture's geometry, in terminal cells and pixels. */
export function geometry(rig: Rig) {
  const { rows, cellAspect, pixelScale } = rig.shape
  const spriteColumns = rows * cellAspect
  const sidePx = rig.canvas.side * pixelScale
  const columnPx = sidePx / spriteColumns
  // In whole sprite pixels, so the furthest shift is one too (an odd canvas
  // side would otherwise leave half a sprite pixel at the end).
  const slackPx = Math.ceil((columnPx * SLACK_COLUMNS) / pixelScale) * pixelScale
  const widthPx = sidePx + slackPx
  return {
    spriteColumns,
    /** Columns the Image takes: the sprite plus the spare ones for the shift. */
    columns: spriteColumns + SLACK_COLUMNS,
    rows,
    sidePx,
    columnPx,
    widthPx,
    /** The furthest the sprite shifts right inside the picture, in pixels. */
    slackPx,
  }
}

/** One frame, shifted right by `shiftPx`, as a PNG the band draws. */
export function paint(rig: Rig, clip: Clip, row: number, frame: number, shiftPx: number): ImageSource {
  const { sidePx, widthPx } = geometry(rig)
  const scale = rig.shape.pixelScale
  const data = clip.frames.get(row)?.[frame] ?? clip.frames.get(0)?.[frame] ?? clip.frames.get(0)![0]!
  // Whole pixels as 32-bit words: the byte order of a word copied from one
  // RGBA buffer to another does not depend on the machine.
  const pixels = new Uint32Array(widthPx * sidePx)
  const from = new Uint32Array(data.rgba.buffer, data.rgba.byteOffset, data.rgba.byteLength >> 2)
  const originX = Math.round(shiftPx) + (rig.canvas.groundX - data.ground.x) * scale
  const originY = (rig.canvas.groundY - data.ground.y) * scale
  const { frameWidth, frameHeight } = clip
  for (let fy = 0; fy < frameHeight; fy++) {
    for (let fx = 0; fx < frameWidth; fx++) {
      const pixel = from[fy * frameWidth + fx]!
      if (data.rgba[(fy * frameWidth + fx) * 4 + 3] === 0) continue
      for (let dy = 0; dy < scale; dy++) {
        const y = originY + fy * scale + dy
        if (y < 0 || y >= sidePx) continue
        for (let dx = 0; dx < scale; dx++) {
          const x = originX + fx * scale + dx
          if (x >= 0 && x < widthPx) pixels[y * widthPx + x] = pixel
        }
      }
    }
  }
  return { png: toBase64(encodePng(new Uint8Array(pixels.buffer), widthPx, sidePx)) }
}

// ── Profile ─────────────────────────────────────────────────────────────────
// A character per species, drawn once from a seed (the dex number), so the
// same species behaves the same way every session.

export type Profile = {
  /** Multiplies how fast the walk cycle plays. */
  pace: number
  /** Columns one walk cycle carries the sprite. */
  stride: number
  sleepiness: number
  curiosity: number
  temper: number
  /** How drawn it is to the prompt end of the band while Claude works. */
  attachment: number
  restless: number
}

/** A small seeded generator (mulberry32), for the profile only. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function profileFor(seed: number, rig: Rig): Profile {
  const next = seeded(seed * 2654435761 + 1)
  const between = (low: number, high: number) => low + next() * (high - low)
  const idle = rig.clips.get('Idle')!
  const isBig = idle.frameWidth >= 48
  const hasFloat = rig.clips.has('Float')
  const isExpressive = rig.clips.has('Pose') || rig.clips.has('Nod')
  return {
    pace: between(0.8, 1.3) * (hasFloat ? 0.8 : 1),
    stride: between(2.4, 3.4) * (isBig ? 1.3 : 1) * (hasFloat ? 1.2 : 1),
    sleepiness: between(0.5, 2) * (isBig ? 1.3 : 1),
    curiosity: between(0.5, 2),
    temper: between(0.2, 1.6) * (isExpressive ? 0.5 : 1),
    attachment: between(0.3, 1),
    restless: between(0.6, 1.6),
  }
}

// ── The actor ───────────────────────────────────────────────────────────────

export type Facing = 'right' | 'left' | 'down'

export type SessionEvent =
  | { kind: 'prompt' }
  | { kind: 'turn-start' }
  | { kind: 'turn-end'; isOk: boolean }
  | { kind: 'poke' }

export type ActorPorts = {
  after: (ms: number, fn: () => void) => Timer
  blit: (site: string, source: ImageSource) => void
  /** Asks the band to draw again: the sprite moved by a column. */
  invalidate: () => void
  /** A uniform random number in [0, 1). */
  random: () => number
}

/** One frame to show for `ms`. */
type Cue = { clip: string; row: number; frame: number; ms: number }

type State =
  | { kind: 'idle'; loops: number; facing: Facing }
  | { kind: 'watch' }
  | { kind: 'walk'; dir: -1 | 1; untilT: number }
  | { kind: 'turn'; to: Facing; then: () => void }
  | { kind: 'act'; action: string; loops: number; then?: () => void }
  | { kind: 'sleep'; untilT: number }
  | { kind: 'wake' }

type Candidate = { id: string; weight: number; needs?: string }

/** What the buddy may do after an idle, before the drives and profile weigh in. */
const CANDIDATES: readonly Candidate[] = [
  { id: 'walk', weight: 40, needs: 'Walk' },
  { id: 'idle', weight: 18 },
  { id: 'sit', weight: 9, needs: 'Sit' },
  { id: 'lookUp', weight: 7, needs: 'LookUp' },
  { id: 'nod', weight: 5, needs: 'Nod' },
  { id: 'pose', weight: 4, needs: 'Pose' },
  { id: 'eat', weight: 4, needs: 'Eat' },
  { id: 'deepBreath', weight: 3, needs: 'DeepBreath' },
  { id: 'sleep', weight: 3, needs: 'Sleep' },
  { id: 'float', weight: 2, needs: 'Float' },
  { id: 'charge', weight: 2, needs: 'Charge' },
  { id: 'tumble', weight: 2, needs: 'Tumble' },
  { id: 'pull', weight: 1, needs: 'Pull' },
  { id: 'lostBalance', weight: 1, needs: 'LostBalance' },
  { id: 'laying', weight: 1, needs: 'Laying' },
]

/** The clip an action plays and how many loops it holds, as a range. */
const ACTS: Record<string, { clip: string; loops: [number, number] }> = {
  sit: { clip: 'Sit', loops: [5, 12] },
  lookUp: { clip: 'LookUp', loops: [2, 4] },
  nod: { clip: 'Nod', loops: [1, 3] },
  pose: { clip: 'Pose', loops: [1, 2] },
  eat: { clip: 'Eat', loops: [3, 6] },
  deepBreath: { clip: 'DeepBreath', loops: [1, 2] },
  float: { clip: 'Float', loops: [2, 4] },
  charge: { clip: 'Charge', loops: [1, 1] },
  attack: { clip: 'Attack', loops: [1, 1] },
  tumble: { clip: 'Tumble', loops: [1, 1] },
  pull: { clip: 'Pull', loops: [1, 2] },
  lostBalance: { clip: 'LostBalance', loops: [1, 1] },
  cringe: { clip: 'Cringe', loops: [1, 2] },
  laying: { clip: 'Laying', loops: [15, 40] },
  wake: { clip: 'Wake', loops: [1, 1] },
}

const MOVE_TICK_MS = 50
const TURN_HOLD_MS = 70
const QUIET_MS = 10 * 60 * 1000
const LONG_TURN_MS = 30 * 1000
/** About 30 frames a second at most: shorter frames are skipped over. */
const MIN_TICK_MS = 33
const MAX_TICK_MS = 5000
/** Painted pictures kept, newest last; a walk cycle at every shift fits. */
const PAINT_CACHE_LIMIT = 512

export class Actor {
  /** The band's render instance, set each time the band draws the sprite. */
  site: string | undefined
  /** Where the band drew the sprite last, in columns; `-1` before a draw. */
  private drawnColumn = -1
  /** The column the picture sits at; it moves only when the sprite leaves it. */
  private anchor = -1
  /** Painted pictures by clip, row, frame and shift. */
  private readonly painted = new Map<string, ImageSource>()
  /** The picture handed out last, which the band shows. */
  private shown: ImageSource | undefined

  private readonly geo: ReturnType<typeof geometry>
  private t = 0
  private timer: Timer | undefined
  private bodyColumns = 80
  private pos = 0
  private facing: Facing = 'down'
  private state: State = { kind: 'idle', loops: 2, facing: 'down' }
  private cues: Cue[] = []
  private cue: Cue
  private cueLeft = 0
  private energy = 0.8
  private restlessness = 0
  private memory: string[] = []
  private pending: string | undefined
  private isWorking = false
  private turnStartedAt = 0
  private lastActivity = 0
  private lastTurnAt = -1e9

  constructor(
    private readonly ports: ActorPorts,
    readonly rig: Rig,
    readonly profile: Profile
  ) {
    this.geo = geometry(rig)
    this.cue = { clip: 'Idle', row: 0, frame: 0, ms: 0 }
    this.pos = this.maxPos * 0.75
    this.enterIdle(2)
  }

  // ── What the band reads ──

  /** The column the Image sits at, within the band. */
  get column(): number {
    this.settle()
    return this.anchor
  }

  get columns(): number {
    return this.geo.columns
  }

  /** The frame on show and which way the buddy faces; for tests and logs. */
  get current(): { clip: string; row: number; frame: number; facing: Facing; state: State['kind'] } {
    return { clip: this.cue.clip, row: this.cue.row, frame: this.cue.frame, facing: this.facing, state: this.state.kind }
  }

  /** The picture on show, painted once per clip, row, frame and shift. */
  get source(): ImageSource {
    const column = this.column
    // Whole sprite pixels: half a pixel of shift is not worth a new picture.
    const scale = this.rig.shape.pixelScale
    const raw = Math.round((this.pos - column * this.geo.columnPx) / scale) * scale
    const shift = Math.min(this.geo.slackPx, Math.max(0, raw))
    const clipName = this.rig.clips.has(this.cue.clip) ? this.cue.clip : 'Idle'
    const key = `${clipName}/${this.cue.row}/${this.cue.frame}/${shift}`
    let source = this.painted.get(key)
    if (source) {
      this.painted.delete(key)
    } else {
      source = paint(this.rig, this.rig.clips.get(clipName)!, this.cue.row, this.cue.frame, shift)
      if (this.painted.size >= PAINT_CACHE_LIMIT) this.painted.delete(this.painted.keys().next().value!)
    }
    this.painted.set(key, source)
    this.shown = source
    return source
  }

  /** The band tells the actor how wide it is, each time it draws. */
  drawn(site: string, bodyColumns: number): void {
    this.site = site
    if (bodyColumns !== this.bodyColumns) {
      // Room for the sprite and two columns of walk. The picture's spare
      // columns may hang past a narrower band: they are transparent there,
      // and the band clips them.
      this.bodyColumns = Math.max(this.geo.spriteColumns + 2, bodyColumns)
      this.pos = Math.min(this.pos, this.maxPos)
    }
    this.drawnColumn = this.column
  }

  setWorking(isWorking: boolean): void {
    if (isWorking && !this.isWorking) this.turnStartedAt = this.t
    this.isWorking = isWorking
  }

  // ── Life ──

  start(): void {
    this.loop()
  }

  stop(): void {
    this.timer?.cancel()
    this.timer = undefined
  }

  /** A session event the buddy notices. */
  notify(event: SessionEvent): void {
    this.lastActivity = this.t
    switch (event.kind) {
      case 'prompt':
        if (this.state.kind === 'sleep') this.wakeUp()
        else this.pending = this.has('LookUp') ? 'lookUp' : this.has('Nod') ? 'nod' : undefined
        break
      case 'turn-start':
        this.setWorking(true)
        break
      case 'turn-end': {
        const wasLong = this.t - this.turnStartedAt > LONG_TURN_MS
        this.setWorking(false)
        if (!event.isOk) this.pending = this.firstOf('cringe', 'lostBalance')
        else if (wasLong) this.pending = this.firstOf('pose', 'nod')
        if (this.state.kind === 'sleep' && !event.isOk) this.wakeUp()
        break
      }
      case 'poke':
        if (this.state.kind === 'sleep') this.wakeUp()
        else this.pending = this.firstOf('pose', 'nod', 'lookUp', 'attack')
        break
    }
  }

  // ── Time ──

  private loop(): void {
    const dt = this.nextDelay()
    this.timer = this.ports.after(dt, () => {
      this.t += dt
      this.advance(dt)
      this.draw()
      this.loop()
    })
  }

  private nextDelay(): number {
    let dt = this.cueLeft
    // A walk or nap reads its `untilT` only when a clip ends, in finish(), so
    // the tick waits for the cue; capping it at `untilT` only made no-op
    // ticks at MIN_TICK_MS once that time had passed.
    if (this.state.kind === 'walk') dt = Math.min(dt, MOVE_TICK_MS)
    return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, Math.ceil(dt)))
  }

  private advance(dt: number): void {
    const seconds = dt / 1000
    if (this.state.kind === 'walk') {
      this.pos = Math.min(this.maxPos, Math.max(0, this.pos + this.state.dir * this.speedPxPerMs * dt))
      this.energy = Math.max(0, this.energy - 0.004 * seconds)
      this.restlessness = 0
    } else if (this.state.kind === 'sleep') {
      this.energy = Math.min(1, this.energy + 0.02 * seconds)
    } else if (this.state.kind === 'act' && ['sit', 'laying'].includes(this.state.action)) {
      this.energy = Math.min(1, this.energy + 0.006 * seconds)
      this.restlessness = Math.min(1, this.restlessness + 0.03 * seconds)
    } else if (this.state.kind === 'act') {
      this.energy = Math.max(0, this.energy - 0.01 * seconds)
    } else {
      this.restlessness = Math.min(1, this.restlessness + 0.03 * seconds)
    }

    this.cueLeft -= dt
    for (let guard = 0; this.cueLeft <= 0 && guard < 64; guard++) {
      const next = this.cues.shift()
      if (next) {
        this.cue = next
        this.cueLeft += next.ms
      } else {
        this.finish()
      }
    }
  }

  /** Moves the picture (a redraw) or swaps it (a blit), and only on a change. */
  private draw(): void {
    if (!this.site) return
    if (this.column !== this.drawnColumn) {
      this.ports.invalidate()
      return
    }
    const before = this.shown
    const source = this.source
    if (source !== before) this.ports.blit(this.site, source)
  }

  /** Keeps the picture where it is while the sprite fits inside it; else
   * moves it so the sprite has the spare columns ahead in its direction. */
  private settle(): void {
    const { columnPx, slackPx } = this.geo
    const maxColumn = Math.max(0, this.bodyColumns - this.geo.columns)
    const shift = this.pos - this.anchor * columnPx
    if (this.anchor >= 0 && this.anchor <= maxColumn && shift >= 0 && shift <= slackPx) return
    const under = Math.floor(this.pos / columnPx)
    const column = this.anchor >= 0 && shift < 0 ? under - SLACK_COLUMNS + 1 : under
    this.anchor = Math.min(maxColumn, Math.max(0, column))
  }

  // ── Geometry ──

  private get maxPos(): number {
    return (this.bodyColumns - this.geo.spriteColumns) * this.geo.columnPx
  }

  private get speedPxPerMs(): number {
    const walk = this.rig.clips.get('Walk')
    const cycleMs = walk ? walk.delaysMs.reduce((a, b) => a + b, 0) / this.profile.pace : 600
    return (this.profile.stride * this.geo.columnPx) / cycleMs
  }

  private get atLeftEdge(): boolean {
    return this.pos <= 0.5
  }

  private get atRightEdge(): boolean {
    return this.pos >= this.maxPos - 0.5
  }

  // ── Clips and rows ──

  private has(clip: string): boolean {
    const found = this.rig.clips.get(clip)
    return found !== undefined && !found.isCopy
  }

  private firstOf(...actions: string[]): string | undefined {
    return actions.find(action => this.has(ACTS[action]?.clip ?? ''))
  }

  private rowFor(clip: Clip, facing: Facing): number {
    if (clip.rows === 1) return 0
    return facing === 'right' ? ROW.right : facing === 'left' ? ROW.left : ROW.down
  }

  /** Queues every frame of a clip in the current facing, once. */
  private enqueueClip(name: string, speed = 1): boolean {
    const clip = this.rig.clips.get(name)
    if (!clip) return false
    const row = this.rowFor(clip, this.facing)
    const count = clip.frames.get(row)?.length ?? 0
    for (let frame = 0; frame < count; frame++) {
      this.cues.push({ clip: name, row, frame, ms: clip.delaysMs[frame]! / speed })
    }
    return count > 0
  }

  /** Queues the frames that turn the sprite from `this.facing` to `to`, through the front. */
  private enqueueTurn(to: Facing): void {
    const from = this.facing === 'right' ? ROW.right : this.facing === 'left' ? ROW.left : ROW.down
    const target = to === 'right' ? ROW.right : to === 'left' ? ROW.left : ROW.down
    // Through the front: from Right the directions count down to Left; from
    // Left they count up; from Down they go whichever way is shorter.
    const step = from === ROW.right ? -1 : from === ROW.left ? 1 : target === ROW.right ? 1 : -1
    const rotate = this.rig.clips.get('Rotate')
    const walk = this.rig.clips.get('Walk')
    for (let dir = from; dir !== target; ) {
      dir = (dir + step + 8) % 8
      if (rotate && rotate.rows === 8) {
        // Rotate row r, frame i shows direction (r − i) mod 8.
        this.cues.push({ clip: 'Rotate', row: from, frame: (from - dir + 8) % 8, ms: TURN_HOLD_MS })
      } else if (walk?.frames.has(dir)) {
        this.cues.push({ clip: 'Walk', row: dir, frame: 0, ms: TURN_HOLD_MS })
      }
    }
  }

  // ── States ──

  private enterIdle(loops: number): void {
    this.state = { kind: 'idle', loops, facing: this.facing }
    this.enqueueClip('Idle')
  }

  private enterWalk(dir: -1 | 1): void {
    const seconds = 1 + this.ports.random() * 5
    this.state = { kind: 'walk', dir, untilT: this.t + seconds * 1000 }
    this.enqueueClip('Walk', this.profile.pace)
  }

  private enterTurn(to: Facing, then: () => void): void {
    if (this.facing === to) {
      then()
      return
    }
    this.state = { kind: 'turn', to, then }
    this.enqueueTurn(to)
    if (this.cues.length === 0) {
      this.facing = to
      then()
    }
  }

  private enterAct(action: string, then?: () => void): void {
    const act = ACTS[action]
    const clip = act && this.rig.clips.get(act.clip)
    if (!act || !clip) {
      this.enterIdle(1)
      return
    }
    if (clip.rows === 1 && this.facing !== 'down') {
      this.enterTurn('down', () => this.enterAct(action, then))
      return
    }
    const [low, high] = act.loops
    const loops = low + Math.floor(this.ports.random() * (high - low + 1))
    this.state = { kind: 'act', action, loops, then }
    this.remember(action)
    this.enqueueClip(act.clip)
  }

  private enterSleep(): void {
    if (this.facing !== 'down' && (this.rig.clips.get('Sleep')?.rows ?? 1) === 1) {
      this.enterTurn('down', () => this.enterSleep())
      return
    }
    const seconds = 20 + this.ports.random() * 70
    this.state = { kind: 'sleep', untilT: this.t + seconds * 1000 }
    this.remember('sleep')
    if (!this.enqueueClip('Sleep')) this.enqueueClip('Idle')
  }

  /** Drops what was queued and shows the Wake clip at once. */
  private wakeUp(): void {
    this.timer?.cancel()
    this.cues = []
    this.enterWake()
    const first = this.cues.shift()
    if (first) {
      this.cue = first
      this.cueLeft = first.ms
    }
    this.draw()
    if (this.timer) this.loop()
  }

  /** Queues the Wake clip. The timer chain is left alone, so this is safe
   * from inside a tick: a nap that ends on its own must not start a second
   * chain, which `wakeUp()` would. */
  private enterWake(): void {
    this.state = { kind: 'wake' }
    if (!this.enqueueClip('Wake')) this.enqueueClip('Idle')
  }

  /** A walk or idle, to turn to the prompt end and watch Claude work. */
  private enterWatch(): void {
    this.state = { kind: 'watch' }
    this.enqueueClip('Idle')
  }

  /** The current clip ended with nothing queued: decide what comes next. */
  private finish(): void {
    const state = this.state
    switch (state.kind) {
      case 'idle':
        if (this.pending) this.doPending()
        else if (state.loops > 1) {
          this.state = { ...state, loops: state.loops - 1 }
          this.enqueueClip('Idle')
        } else this.choose()
        return
      case 'watch':
        if (this.pending || !this.isWorking) this.choose()
        else this.enqueueClip('Idle')
        return
      case 'walk':
        if (this.pending) this.doPending()
        // A walk that reaches the prompt end while Claude works stops there
        // and watches; without this it always turned back first.
        else if (this.atRightEdge && this.isWorking) this.enterTurn('down', () => this.enterWatch())
        else if (this.atLeftEdge || this.atRightEdge) {
          const to: Facing = this.atLeftEdge ? 'right' : 'left'
          this.enterTurn(to, () => this.enterWalk(to === 'right' ? 1 : -1))
        } else if (this.t >= state.untilT) this.enterIdle(1 + Math.floor(this.ports.random() * 3))
        else if (this.ports.random() < 0.08 && this.t - this.lastTurnAt > 3000) {
          this.lastTurnAt = this.t
          const to: Facing = state.dir === 1 ? 'left' : 'right'
          this.enterTurn(to, () => this.enterWalk(to === 'right' ? 1 : -1))
        } else this.enqueueClip('Walk', this.profile.pace)
        return
      case 'turn':
        this.facing = state.to
        state.then()
        return
      case 'act':
        if (state.loops > 1) {
          this.state = { ...state, loops: state.loops - 1 }
          this.enqueueClip(ACTS[state.action]!.clip)
        } else if (state.then) state.then()
        else this.enterIdle(1)
        return
      case 'sleep':
        if (this.t >= state.untilT) this.enterWake()
        else if (!this.enqueueClip('Sleep')) this.enqueueClip('Idle')
        return
      case 'wake':
        this.energy = Math.min(1, this.energy + 0.2)
        this.enterIdle(1)
        return
    }
  }

  private doPending(): void {
    const action = this.pending
    this.pending = undefined
    if (action) this.enterAct(action)
    else this.enterIdle(1)
  }

  private remember(action: string): void {
    this.memory = [action, ...this.memory].slice(0, 3)
  }

  // ── Choosing ──

  private weightOf({ id, weight }: Candidate): number {
    const p = this.profile
    const isQuiet = this.t - this.lastActivity > QUIET_MS
    let w = weight
    switch (id) {
      case 'walk':
        w *= (0.5 + this.energy) * (1 + this.restlessness) * p.restless
        break
      case 'sleep':
        w *= (1 - this.energy) * 3 * p.sleepiness * (isQuiet ? 5 : 1) * (this.isWorking ? 0.5 : 1)
        break
      case 'sit':
      case 'laying':
        w *= (1.5 - this.energy) * p.sleepiness
        break
      case 'lookUp':
      case 'nod':
      case 'pose':
        w *= p.curiosity * (this.isWorking ? 2 : 1)
        break
      case 'charge':
        w *= p.temper
        break
    }
    const seen = this.memory.filter(m => m === id).length
    if (seen > 0 && id !== 'walk' && id !== 'idle') w /= 2 ** seen
    return w
  }

  private choose(): void {
    // While Claude works, a drawn buddy goes to the prompt end and watches.
    if (this.isWorking && this.ports.random() < this.profile.attachment) {
      if (this.atRightEdge) {
        this.enterTurn('down', () => this.enterWatch())
        return
      }
      if (this.has('Walk')) {
        this.enterTurn('right', () => this.enterWalk(1))
        return
      }
    }

    const options = CANDIDATES.filter(c => !c.needs || this.has(c.needs)).map(c => ({
      id: c.id,
      weight: this.weightOf(c),
    }))
    const total = options.reduce((sum, o) => sum + o.weight, 0)
    let pick = this.ports.random() * total
    let chosen = options[0]?.id ?? 'idle'
    for (const option of options) {
      pick -= option.weight
      if (pick < 0) {
        chosen = option.id
        break
      }
    }
    this.dispatch(chosen)
  }

  private dispatch(id: string): void {
    switch (id) {
      case 'idle':
        this.enterIdle(1 + Math.floor(this.ports.random() * 3))
        return
      case 'walk': {
        const dir: -1 | 1 = this.atLeftEdge ? 1 : this.atRightEdge ? -1 : this.ports.random() < 0.5 ? -1 : 1
        this.enterTurn(dir === 1 ? 'right' : 'left', () => this.enterWalk(dir))
        return
      }
      case 'sleep': {
        const yawn = this.firstOf('lookUp', 'deepBreath')
        if (yawn && this.ports.random() < 0.7) this.enterAct(yawn, () => this.enterSleep())
        else this.enterSleep()
        return
      }
      case 'charge':
        this.enterAct('charge', () => {
          if (this.has('Attack') && this.ports.random() < 0.5) this.enterAct('attack')
          else this.enterIdle(1)
        })
        return
      case 'lostBalance':
        this.enterAct('lostBalance', () => {
          if (this.has('Cringe')) this.enterAct('cringe')
          else this.enterIdle(1)
        })
        return
      default:
        this.enterAct(id)
    }
  }
}
