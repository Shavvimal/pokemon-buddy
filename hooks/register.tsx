/**
 * Pokémon Buddy: one random animated Pokémon per Claude Code session, drawn
 * in the Game Boy Color style of Pokémon Crystal at the right end of the band
 * above the prompt.
 *
 * The sprites come from Polished Crystal (github.com/Rangi42/polishedcrystal),
 * a Pokémon Crystal ROM hack whose source keeps each Pokémon as a 4-shade PNG
 * strip of frames, a frame script and a 2-colour palette. This mod ships no
 * sprites: it fetches them from that public repository when a session starts,
 * caches a few for offline sessions, and plays them the way the game does.
 * README.md and NOTICE.md credit the sprite artists and rights holders.
 *
 * Sections, top to bottom: configuration, base64, inflate, PNG decoding,
 * pic animation, sprite shaping, sprite source, playback, and hooks.
 * Pictures need a terminal with a graphics protocol (Ghostty, kitty, or
 * iTerm2 3.5+); anywhere else the band stays empty.
 */
import type { HttpInit, HttpResponse, ImageSource, Register, Timer } from 'claude-code'

// ── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  /** Sprite height in terminal rows: 3 is small, 6 shows every pixel. */
  rows: 3,
  /** Terminal cell height divided by its width; keeps the sprite square. */
  cellAspect: 2,
  /** Nearest-neighbour upscale before the terminal scales, so pixels stay sharp. */
  pixelScale: 2,
  /** Rest between animation loops, in ms; 0 loops without a break. */
  loopPauseMs: 3000,
  /** One session in this many gets the shiny palette; 0 turns shinies off. */
  shinyOdds: 512,
  /** Pokémon kept in the store for offline sessions, about 3 KB each. */
  cacheLimit: 60,
  /** How long the list of Pokémon is kept before it is fetched again, in ms. */
  indexMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Sprite folders left out of the draw. */
  exclude: ['egg'],
  /** Where the sprites live. */
  repo: { owner: 'Rangi42', name: 'polishedcrystal', ref: 'master', dir: 'gfx/pokemon' },
} as const

// ── Base64 ──────────────────────────────────────────────────────────────────
// The hooks runtime has the native Uint8Array base64 methods; TypeScript's
// standard lib declares them only from 6.0, so they are typed here.

const fromBase64 = (base64: string): Uint8Array =>
  (Uint8Array as unknown as { fromBase64(text: string): Uint8Array }).fromBase64(base64)

const toBase64 = (bytes: Uint8Array): string =>
  (bytes as unknown as { toBase64(): string }).toBase64()

// ── Inflate ─────────────────────────────────────────────────────────────────
// zlib (RFC 1950) and deflate (RFC 1951) decompression for PNG image data,
// after the structure of zlib's puff.c. The hooks runtime has no
// DecompressionStream, so the mod carries its own.

type Huffman = { counts: Uint16Array; symbols: Uint16Array }

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

class BitReader {
  private at = 0
  private buffer = 0
  private count = 0

  constructor(private readonly data: Uint8Array) {}

  /** Reads `width` bits, least significant first. */
  bits(width: number): number {
    while (this.count < width) {
      this.buffer |= this.byte() << this.count
      this.count += 8
    }
    const value = this.buffer & ((1 << width) - 1)
    this.buffer >>>= width
    this.count -= width
    return value
  }

  /** Drops the bits left in the current byte. */
  align(): void {
    this.buffer = 0
    this.count = 0
  }

  byte(): number {
    if (this.at >= this.data.length) throw new Error('compressed data ends early')
    return this.data[this.at++]!
  }
}

function huffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16)
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!
    counts[length] = counts[length]! + 1
  }
  counts[0] = 0

  const offsets = new Uint16Array(16)
  for (let length = 1; length < 15; length++) {
    offsets[length + 1] = offsets[length]! + counts[length]!
  }
  const symbols = new Uint16Array(lengths.length)
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!
    if (length === 0) continue
    symbols[offsets[length]!] = symbol
    offsets[length] = offsets[length]! + 1
  }
  return { counts, symbols }
}

function decodeSymbol(reader: BitReader, table: Huffman): number {
  let code = 0
  let first = 0
  let index = 0
  for (let length = 1; length < 16; length++) {
    code |= reader.bits(1)
    const count = table.counts[length]!
    if (code - count < first) return table.symbols[index + (code - first)]!
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('bad Huffman code')
}

const FIXED_TABLES = (() => {
  const lengths = new Uint8Array(288)
  lengths.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288)
  return { literals: huffman(lengths), distances: huffman(new Uint8Array(30).fill(5)) }
})()

function readDynamicTables(reader: BitReader) {
  const literalCount = reader.bits(5) + 257
  const distanceCount = reader.bits(5) + 1
  const codeLengthCount = reader.bits(4) + 4

  const codeLengths = new Uint8Array(19)
  for (let i = 0; i < codeLengthCount; i++) codeLengths[CODE_LENGTH_ORDER[i]!] = reader.bits(3)
  const codeLengthTable = huffman(codeLengths)

  const lengths = new Uint8Array(literalCount + distanceCount)
  for (let i = 0; i < lengths.length; ) {
    const symbol = decodeSymbol(reader, codeLengthTable)
    if (symbol < 16) {
      lengths[i++] = symbol
      continue
    }
    let value = 0
    let repeat: number
    if (symbol === 16) {
      if (i === 0) throw new Error('length repeat with no previous length')
      value = lengths[i - 1]!
      repeat = 3 + reader.bits(2)
    } else if (symbol === 17) {
      repeat = 3 + reader.bits(3)
    } else {
      repeat = 11 + reader.bits(7)
    }
    if (i + repeat > lengths.length) throw new Error('too many code lengths')
    lengths.fill(value, i, i + repeat)
    i += repeat
  }

  return {
    literals: huffman(lengths.subarray(0, literalCount)),
    distances: huffman(lengths.subarray(literalCount)),
  }
}

function inflateBlock(
  reader: BitReader,
  out: number[],
  { literals, distances }: { literals: Huffman; distances: Huffman }
): void {
  for (;;) {
    const symbol = decodeSymbol(reader, literals)
    if (symbol < 256) {
      out.push(symbol)
      continue
    }
    if (symbol === 256) return

    // A length's extra bits come before the distance code.
    const lengthIndex = symbol - 257
    if (lengthIndex >= 29) throw new Error('bad length code')
    const length = LENGTH_BASE[lengthIndex]! + reader.bits(LENGTH_EXTRA[lengthIndex]!)
    const distanceIndex = decodeSymbol(reader, distances)
    if (distanceIndex >= 30) throw new Error('bad distance code')
    const distance = DISTANCE_BASE[distanceIndex]! + reader.bits(DISTANCE_EXTRA[distanceIndex]!)
    if (distance > out.length) throw new Error('distance reaches before the start')
    for (let i = 0; i < length; i++) out.push(out[out.length - distance]!)
  }
}

function copyStoredBlock(reader: BitReader, out: number[]): void {
  reader.align()
  const length = reader.byte() | (reader.byte() << 8)
  const complement = reader.byte() | (reader.byte() << 8)
  if ((length ^ 0xffff) !== complement) throw new Error('stored block length is corrupt')
  for (let i = 0; i < length; i++) out.push(reader.byte())
}

/** Decompresses a zlib stream. The checksum is not verified. */
function inflateZlib(data: Uint8Array): Uint8Array {
  if (((data[0] ?? 0) & 0x0f) !== 8) throw new Error('not a zlib deflate stream')
  const reader = new BitReader(data.subarray(2))
  const out: number[] = []
  for (let isLast = false; !isLast; ) {
    isLast = reader.bits(1) === 1
    const type = reader.bits(2)
    if (type === 0) copyStoredBlock(reader, out)
    else if (type === 1) inflateBlock(reader, out, FIXED_TABLES)
    else if (type === 2) inflateBlock(reader, out, readDynamicTables(reader))
    else throw new Error('bad deflate block type')
  }
  return Uint8Array.from(out)
}

// ── PNG decoding ────────────────────────────────────────────────────────────
// Reads the greyscale PNGs Game Boy graphics are kept in: non-interlaced,
// colour type 0, 1 to 8 bits per pixel. Each pixel becomes a shade from
// 0 (black) to 3 (white).

type Greyscale = { width: number; height: number; shades: Uint8Array }

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function decodeGreyscalePng(bytes: Uint8Array): Greyscale {
  if (PNG_SIGNATURE.some((value, i) => bytes[i] !== value)) throw new Error('not a PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let width = 0
  let height = 0
  let depth = 0
  const data: Uint8Array[] = []
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      depth = body[8]!
      const isPlainGreyscale = body[9] === 0 && body[12] === 0 && depth <= 8
      if (!isPlainGreyscale) throw new Error('PNG is not plain greyscale')
    } else if (type === 'IDAT') {
      data.push(body)
    } else if (type === 'IEND') {
      break
    }
    at += length + 12
  }
  if (width === 0 || data.length === 0) throw new Error('PNG has no image data')

  const rowBytes = Math.ceil((width * depth) / 8)
  const rows = unfilter(inflateZlib(concatBytes(data)), rowBytes, height)
  const maxSample = (1 << depth) - 1
  const shades = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = x * depth
      const byte = rows[y * rowBytes + (bit >> 3)]!
      const sample = (byte >> (8 - depth - (bit & 7))) & maxSample
      shades[y * width + x] = Math.round((sample * 3) / maxSample)
    }
  }
  return { width, height, shades }
}

/** Undoes PNG's per-row filters; greyscale up to 8 bits has 1 byte per pixel. */
function unfilter(raw: Uint8Array, rowBytes: number, height: number): Uint8Array {
  const rows = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]
    const line = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1))
    const at = y * rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const left = x > 0 ? rows[at + x - 1]! : 0
      const up = y > 0 ? rows[at + x - rowBytes]! : 0
      const upLeft = x > 0 && y > 0 ? rows[at + x - rowBytes - 1]! : 0
      rows[at + x] = (line[x]! + predict(filter, left, up, upLeft)) & 0xff
    }
  }
  return rows
}

function predict(filter: number | undefined, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0
    case 1:
      return left
    case 2:
      return up
    case 3:
      return (left + up) >> 1
    case 4: {
      const estimate = left + up - upLeft
      const toLeft = Math.abs(estimate - left)
      const toUp = Math.abs(estimate - up)
      const toUpLeft = Math.abs(estimate - upLeft)
      if (toLeft <= toUp && toLeft <= toUpLeft) return left
      return toUp <= toUpLeft ? up : upLeft
    }
    default:
      throw new Error(`unknown PNG filter ${filter}`)
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return joined
}

// ── Pic animation ───────────────────────────────────────────────────────────
// Plays a Crystal "pic": a vertical strip of square frames, frame 0 the
// resting pose, run by a frame script of `frame N, ticks`, `setrepeat N`,
// `dorepeat COMMAND` and `endanim`, at 60 ticks a second. The four shades
// become white, the palette's light and dark colours, and black; white that
// touches the edge becomes transparent, as the battle background shows it.

type Frame = { rgba: Uint8Array; delayMs: number }
type Animation = { width: number; height: number; frames: Frame[] }
type Rgb = readonly [number, number, number]
type Step = { frame: number; ticks: number }

const TICK_MS = 1000 / 60
const MAX_STEPS = 512
const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]

function animatePic(pic: Greyscale, script: string | null, palette: readonly [Rgb, Rgb]): Animation {
  const size = pic.width
  const count = Math.max(1, Math.floor(pic.height / size))
  const [light, dark] = palette
  const colours = [BLACK, dark, light, WHITE]
  const frames = Array.from({ length: count }, (_, i) => colourFrame(pic, i, colours))
  const frameAt = (index: number) => frames[Math.min(Math.max(index, 0), count - 1)]!

  const steps = script ? runFrameScript(script) : []
  return {
    width: size,
    height: size,
    frames: [
      ...steps.map(step => ({ rgba: frameAt(step.frame), delayMs: step.ticks * TICK_MS })),
      { rgba: frameAt(0), delayMs: 0 }, // back to rest; the loop pause is added later
    ],
  }
}

function colourFrame(pic: Greyscale, index: number, colours: readonly Rgb[]): Uint8Array {
  const size = pic.width
  const rgba = new Uint8Array(size * size * 4)
  const offset = index * size * size
  for (let p = 0; p < size * size; p++) {
    rgba.set(colours[pic.shades[offset + p]!]!, p * 4)
    rgba[p * 4 + 3] = 255
  }
  clearEdgeWhite(rgba, size)
  return rgba
}

/** Flood-fills white from the border to transparent. */
function clearEdgeWhite(rgba: Uint8Array, size: number): void {
  const isWhite = (p: number) => rgba[p * 4] === 255 && rgba[p * 4 + 1] === 255 && rgba[p * 4 + 2] === 255
  const seen = new Uint8Array(size * size)
  const stack: number[] = []
  for (let i = 0; i < size; i++) stack.push(i, size * size - 1 - i, i * size, i * size + size - 1)
  while (stack.length > 0) {
    const p = stack.pop()!
    if (seen[p] || !isWhite(p)) continue
    seen[p] = 1
    rgba[p * 4 + 3] = 0
    const x = p % size
    if (x > 0) stack.push(p - 1)
    if (x < size - 1) stack.push(p + 1)
    if (p >= size) stack.push(p - size)
    if (p < size * (size - 1)) stack.push(p + size)
  }
}

function runFrameScript(script: string): Step[] {
  const commands = script
    .split('\n')
    .map(line => line.replace(/;.*/, '').trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [op = '', ...args] = line.split(/[\s,]+/)
      return { op, args: args.map(Number) }
    })

  const steps: Step[] = []
  let repeats = 0
  for (let at = 0; at < commands.length && steps.length < MAX_STEPS; ) {
    const { op, args } = commands[at]!
    if (op === 'frame') {
      steps.push({ frame: args[0] ?? 0, ticks: args[1] ?? 1 })
      at++
    } else if (op === 'setrepeat') {
      repeats = args[0] ?? 0
      at++
    } else if (op === 'dorepeat' && repeats > 0) {
      repeats--
      at = args[0] ?? at + 1
    } else if (op === 'dorepeat') {
      at++
    } else {
      break // endanim, or a command this player does not know
    }
  }
  return steps
}

function parsePalette(text: string): readonly [Rgb, Rgb] {
  const colours = [...text.matchAll(/RGB\s+(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)].map(
    match => [1, 2, 3].map(i => Math.round((Number(match[i]) * 255) / 31)) as unknown as Rgb
  )
  const [light, dark] = colours
  if (!light || !dark) throw new Error('palette needs two colours')
  return [light, dark]
}

// ── Sprite shaping ──────────────────────────────────────────────────────────
// Turns a decoded animation into what the terminal draws: cropped to the
// Pokémon, squared up and sat on the bottom edge, upscaled, with repeated
// frames merged and each frame encoded once.

type SpriteFrame = { base64: string; delayMs: number }
type Sprite = { size: number; frames: SpriteFrame[] }

function shapeSprite(animation: Animation): Sprite {
  const box = contentBox(animation)
  const side = Math.max(box.width, box.height)
  const offsetX = Math.floor((side - box.width) / 2)
  const offsetY = side - box.height
  const size = side * CONFIG.pixelScale

  const frames: SpriteFrame[] = []
  let previous: Uint8Array | undefined
  for (const frame of animation.frames) {
    const pixels = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      const sourceY = Math.floor(y / CONFIG.pixelScale) - offsetY
      if (sourceY < 0 || sourceY >= box.height) continue
      for (let x = 0; x < size; x++) {
        const sourceX = Math.floor(x / CONFIG.pixelScale) - offsetX
        if (sourceX < 0 || sourceX >= box.width) continue
        const from = ((box.top + sourceY) * animation.width + box.left + sourceX) * 4
        pixels.set(frame.rgba.subarray(from, from + 4), (y * size + x) * 4)
      }
    }

    const last = frames.at(-1)
    if (last && previous && sameBytes(previous, pixels)) {
      last.delayMs += frame.delayMs
    } else {
      frames.push({ base64: toBase64(pixels), delayMs: frame.delayMs })
      previous = pixels
    }
  }
  frames.at(-1)!.delayMs += CONFIG.loopPauseMs

  return { size, frames }
}

/** The smallest box holding every visible pixel of every frame. */
function contentBox({ width, height, frames }: Animation) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (const { rgba } of frames) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (rgba[(y * width + x) * 4 + 3] === 0) continue
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
  }
  if (maxX < 0) return { left: 0, top: 0, width, height }
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ── Sprite source ───────────────────────────────────────────────────────────
// Lists the Pokémon in the Polished Crystal repository, picks one, fetches
// its pic, frame script and palettes, and caches them in the plugin store.
// A failed fetch falls back to a Pokémon cached by an earlier session. The
// engine is reached only through the ports the hooks pass in.

type SourcePorts = {
  now: () => Promise<number>
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<void>
    keys: () => Promise<string[]>
  }
}

/** One sprite folder: its paths in the repository, relative to `repo.dir`. */
type IndexEntry = { name: string; anim: string | null; normal: string; shiny: string }
type StoredIndex = { fetchedAt: number; entries: IndexEntry[] }
/** What a cached Pokémon keeps: the pic as base64 PNG, and its text files. */
type PicRecord = { png: string; anim: string | null; normal: string; shiny: string }

const INDEX_KEY = 'index'
const PIC_PREFIX = 'pic:'
/** Store keys an earlier version of the mod wrote. */
const LEGACY_PREFIXES = ['gif:']
const USER_AGENT = { 'User-Agent': 'pokemon-buddy (Claude Code mod)' }
const GITHUB_API = { ...USER_AGENT, Accept: 'application/vnd.github+json' }

const { owner, name: repoName, ref, dir } = CONFIG.repo
const TREE_URL = `https://api.github.com/repos/${owner}/${repoName}/git/trees/${ref}:${dir}?recursive=1`
const contentsUrl = (path: string) =>
  `https://api.github.com/repos/${owner}/${repoName}/contents/${dir}/${path}?ref=${ref}`
const rawUrl = (path: string) =>
  `https://raw.githubusercontent.com/${owner}/${repoName}/${ref}/${dir}/${path}`

async function summon(ports: SourcePorts): Promise<Sprite> {
  const record = await freshPic(ports).catch((error: unknown) => cachedPic(ports, error))
  const isShiny = CONFIG.shinyOdds > 0 && randomInt(CONFIG.shinyOdds) === 0
  const pic = decodeGreyscalePng(fromBase64(record.png))
  const palette = parsePalette(isShiny ? record.shiny : record.normal)
  return shapeSprite(animatePic(pic, record.anim, palette))
}

async function freshPic(ports: SourcePorts): Promise<PicRecord> {
  const entry = pickEntry(await loadIndex(ports))
  if (!entry) throw new Error('the sprite list is empty')

  const key = `${PIC_PREFIX}${entry.name}`
  const cached = await ports.store.get(key)
  if (isPicRecord(cached)) return cached

  const [png, anim, normal, shiny] = await Promise.all([
    fetchBase64(ports, contentsUrl(`${entry.name}/front.png`)),
    entry.anim ? fetchText(ports, rawUrl(entry.anim)) : null,
    fetchText(ports, rawUrl(entry.normal)),
    fetchText(ports, rawUrl(entry.shiny)),
  ])
  const record: PicRecord = { png, anim, normal, shiny }
  await remember(ports, key, record)
  return record
}

async function cachedPic(ports: SourcePorts, cause: unknown): Promise<PicRecord> {
  const keys = (await ports.store.keys()).filter(key => key.startsWith(PIC_PREFIX))
  const key = keys[randomInt(keys.length)]
  const record = key ? await ports.store.get(key) : undefined
  if (!isPicRecord(record)) throw cause
  return record
}

/** The sprite list, fetched again once it is older than `indexMaxAgeMs`. */
async function loadIndex(ports: SourcePorts): Promise<IndexEntry[]> {
  const now = await ports.now()
  const stored = (await ports.store.get(INDEX_KEY)) as StoredIndex | undefined
  if (stored && now - stored.fetchedAt < CONFIG.indexMaxAgeMs) return stored.entries

  try {
    const response = await ports.fetch(TREE_URL, { headers: GITHUB_API })
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for the sprite list`)
    const { tree } = JSON.parse(response.text) as { tree: { path: string; type: string }[] }
    const entries = buildIndex(tree.filter(item => item.type === 'blob').map(item => item.path))
    await ports.store.set(INDEX_KEY, { fetchedAt: now, entries } satisfies StoredIndex)
    await dropLegacyKeys(ports)
    return entries
  } catch (error) {
    if (stored) return stored.entries
    throw error
  }
}

/**
 * One entry per folder that holds a front pic. A form without palettes of
 * its own (`dudunsparce_two_segment`) uses its species' (`dudunsparce`).
 */
function buildIndex(paths: string[]): IndexEntry[] {
  const files = new Set(paths)
  const excluded = new Set<string>(CONFIG.exclude)
  const findUp = (name: string, file: string): string | null => {
    for (const parts = name.split('_'); parts.length > 0; parts.pop()) {
      const path = `${parts.join('_')}/${file}`
      if (files.has(path)) return path
    }
    return null
  }

  const entries: IndexEntry[] = []
  for (const path of paths) {
    const match = /^([^/]+)\/front\.png$/.exec(path)
    const name = match?.[1]
    if (!name || excluded.has(name)) continue
    const normal = findUp(name, 'normal.pal')
    if (!normal) continue
    const anim = files.has(`${name}/anim.asm`) ? `${name}/anim.asm` : null
    entries.push({ name, anim, normal, shiny: findUp(name, 'shiny.pal') ?? normal })
  }
  return entries
}

/**
 * Picks a species first, then one of its forms, so a species with many
 * forms (Unown, Magikarp) is no likelier than one with a single form.
 */
function pickEntry(entries: IndexEntry[]): IndexEntry | undefined {
  const species = new Map<string, IndexEntry[]>()
  for (const entry of entries) {
    const key = entry.name.split('_')[0] ?? entry.name
    species.set(key, [...(species.get(key) ?? []), entry])
  }
  const forms = [...species.values()][randomInt(species.size)] ?? []
  return forms[randomInt(forms.length)]
}

async function fetchText(ports: SourcePorts, url: string): Promise<string> {
  const response = await ports.fetch(url, { headers: USER_AGENT })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.text
}

/**
 * Fetches a binary file through the GitHub contents API, which sends it as
 * base64 JSON: the host's fetch hands back text, which would mangle bytes.
 */
async function fetchBase64(ports: SourcePorts, url: string): Promise<string> {
  const response = await ports.fetch(url, { headers: GITHUB_API })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const { content } = JSON.parse(response.text) as { content?: string }
  if (!content) throw new Error(`${url} sent no content`)
  return content.replace(/\s/g, '')
}

/** Stores a Pokémon and drops the oldest ones past the cache limit. */
async function remember(ports: SourcePorts, key: string, record: PicRecord): Promise<void> {
  await ports.store.set(key, record)
  const keys = (await ports.store.keys()).filter(k => k.startsWith(PIC_PREFIX))
  for (const old of keys.slice(0, Math.max(0, keys.length - CONFIG.cacheLimit))) {
    await ports.store.delete(old)
  }
}

async function dropLegacyKeys(ports: SourcePorts): Promise<void> {
  for (const key of await ports.store.keys()) {
    if (LEGACY_PREFIXES.some(prefix => key.startsWith(prefix))) await ports.store.delete(key)
  }
}

function isPicRecord(value: unknown): value is PicRecord {
  const record = value as Partial<PicRecord> | null | undefined
  return typeof record?.png === 'string' && typeof record.normal === 'string' && typeof record.shiny === 'string'
}

function randomInt(below: number): number {
  return below > 0 ? crypto.getRandomValues(new Uint32Array(1))[0]! % below : 0
}

// ── Playback ────────────────────────────────────────────────────────────────
// Steps through the frames, each after its own delay, and swaps the mounted
// Image in place. While the band is not drawn, the player keeps time and
// skips the swap.

type PlayerPorts = {
  after: (ms: number, fn: () => void) => Timer
  blit: (site: string, source: ImageSource) => void
}

const IMAGE_KEY = 'sprite'

class Player {
  private index = 0
  private timer: Timer | undefined
  /** The band's render instance, set each time the band draws the sprite. */
  site: string | undefined

  constructor(
    private readonly ports: PlayerPorts,
    readonly sprite: Sprite
  ) {}

  get source(): ImageSource {
    const { size, frames } = this.sprite
    return { rgba: frames[this.index]!.base64, width: size, height: size }
  }

  start(): void {
    if (this.sprite.frames.length > 1) this.schedule()
  }

  stop(): void {
    this.timer?.cancel()
    this.timer = undefined
  }

  private schedule(): void {
    const { delayMs } = this.sprite.frames[this.index]!
    this.timer = this.ports.after(delayMs, () => this.advance())
  }

  private advance(): void {
    this.index = (this.index + 1) % this.sprite.frames.length
    if (this.site) this.ports.blit(this.site, this.source)
    this.schedule()
  }
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export const register: Register = on => {
  let player: Player | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (e.surface !== 'terminal') return result

    const source: SourcePorts = {
      now: () => $.clock.now(),
      fetch: (url, init) => $.http.fetch(url, init),
      store: {
        get: key => $.store.get(key),
        set: (key, value) => $.store.set(key, value),
        delete: key => $.store.delete(key),
        keys: () => $.store.keys(),
      },
    }
    const playback: PlayerPorts = {
      after: (ms, fn) => $.clock.after(ms, fn),
      blit: (site, image) => void $.ui.blit({ requestId: site, key: IMAGE_KEY, source: image }),
    }

    // Fetch in the background so the session never waits on GitHub.
    summon(source)
      .then(sprite => {
        player?.stop()
        player = new Player(playback, sprite)
        player.start()
        $.ui.invalidate('ui.render')
      })
      .catch((error: unknown) => $.ui.log(`pokemon-buddy: no sprite (${String(error)})`))
    return result
  })

  on('session.end', async ($, e, next) => {
    player?.stop()
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey || !player) return next(e)

    player.site = e.requestId
    const { Box, Image } = $.ui.resolve(e)
    return (
      <Box width="100%" justifyContent="flex-end">
        <Image
          key={IMAGE_KEY}
          source={player.source}
          columns={CONFIG.rows * CONFIG.cellAspect}
          rows={CONFIG.rows}
          alt=" "
        />
      </Box>
    )
  })
}
