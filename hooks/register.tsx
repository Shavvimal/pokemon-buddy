/**
 * Pokémon Buddy: one random animated Pokémon per Claude Code session, drawn
 * in the Game Boy Color style of Pokémon Crystal at the right end of the band
 * above the prompt.
 *
 * The sprites come from three public repositories, gathered into one Pokédex
 * with each species and form once:
 * - Pokémon Crystal's own animated sprites, from PokeAPI/sprites;
 * - Polished Crystal (Rangi42/polishedcrystal), a Crystal ROM hack that adds
 *   later relatives and regional forms in Crystal's own format;
 * - Pokémon Prism, from a third-party archive of its extracted graphics
 *   (bottlebrushes/pokemon-prism-assets); off unless the user switches it on.
 * This mod ships no sprites: it fetches them when a session starts, caches a
 * few for offline sessions, and plays them the way the games do. README.md
 * and NOTICE.md credit the artists and rights holders.
 *
 * Sections, top to bottom: configuration, base64, inflate, PNG decoding,
 * GIF decoding, pic animation, sprite shaping, sprite sources, collection,
 * playback, and hooks. Pictures need a terminal with a graphics protocol
 * (Ghostty, kitty, or iTerm2 3.5+); anywhere else the band stays empty.
 */
import type {
  HttpInit,
  HttpResponse,
  ImageSource,
  PluginOptions,
  Register,
  Timer,
} from 'claude-code'

// ── Configuration ───────────────────────────────────────────────────────────
// Which sources are on is a per-user setting (`userConfig` in plugin.json);
// the rest is set here.

const CONFIG = {
  /** Sprite height in terminal rows: 3 is small, 6 shows every pixel. */
  rows: 3,
  /** Terminal cell height divided by its width; keeps the sprite square. */
  cellAspect: 2,
  /** Nearest-neighbour upscale before the terminal scales, so pixels stay sharp. */
  pixelScale: 2,
  /** Rest between animation loops, in ms; 0 loops without a break. */
  loopPauseMs: 3000,
  /** Time per frame for sprites kept as plain frame strips (Prism), in ms. */
  stripFrameMs: 7 * (1000 / 60),
  /** One session in this many gets the shiny colours; 0 turns shinies off. */
  shinyOdds: 512,
  /** Sprites kept in the store for offline sessions, 2 to 25 KB each. */
  cacheLimit: 60,
  /** How long each source's sprite list is kept before it is fetched again, in ms. */
  listMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Polished Crystal folders left out of the draw. */
  exclude: ['egg'],
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
// Reads the two PNG kinds the sources use, both non-interlaced: greyscale
// (colour type 0, 1 to 8 bits), where each pixel becomes a Game Boy shade
// from 0 (black) to 3 (white), and 8-bit RGBA (colour type 6).

type Greyscale = { kind: 'shades'; width: number; height: number; shades: Uint8Array }
type Rgba = { kind: 'rgba'; width: number; height: number; rgba: Uint8Array }

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function decodePng(bytes: Uint8Array): Greyscale | Rgba {
  if (PNG_SIGNATURE.some((value, i) => bytes[i] !== value)) throw new Error('not a PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let width = 0
  let height = 0
  let depth = 0
  let colourType = -1
  const data: Uint8Array[] = []
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      depth = body[8]!
      colourType = body[9]!
      const isSupported =
        body[12] === 0 && ((colourType === 0 && depth <= 8) || (colourType === 6 && depth === 8))
      if (!isSupported) throw new Error('PNG is neither plain greyscale nor 8-bit RGBA')
    } else if (type === 'IDAT') {
      data.push(body)
    } else if (type === 'IEND') {
      break
    }
    at += length + 12
  }
  if (width === 0 || data.length === 0) throw new Error('PNG has no image data')

  const raw = inflateZlib(concatBytes(data))
  if (colourType === 6) {
    return { kind: 'rgba', width, height, rgba: unfilter(raw, width * 4, height, 4) }
  }

  const rowBytes = Math.ceil((width * depth) / 8)
  const rows = unfilter(raw, rowBytes, height, 1)
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
  return { kind: 'shades', width, height, shades }
}

/**
 * Undoes PNG's per-row filters. `stride` is the bytes per pixel the filters
 * look back by: 1 for greyscale up to 8 bits, 4 for 8-bit RGBA.
 */
function unfilter(raw: Uint8Array, rowBytes: number, height: number, stride: number): Uint8Array {
  const rows = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]
    const line = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1))
    const at = y * rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= stride ? rows[at + x - stride]! : 0
      const up = y > 0 ? rows[at + x - rowBytes]! : 0
      const upLeft = x >= stride && y > 0 ? rows[at + x - rowBytes - stride]! : 0
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

// ── GIF decoding ────────────────────────────────────────────────────────────
// A GIF89a decoder covering what animated sprites use: global and local
// colour tables, transparency, interlacing, and disposal methods 0 to 3.

type GraphicControl = { delayMs: number; disposal: number; transparent: number }

const DEFAULT_CONTROL: GraphicControl = { delayMs: 100, disposal: 0, transparent: -1 }
/** Browsers treat a delay under 20 ms as 100 ms; so does this decoder. */
const MIN_DELAY_MS = 20

class ByteReader {
  private offset = 0

  constructor(private readonly data: Uint8Array) {}

  u8(): number {
    if (this.offset >= this.data.length) throw new Error('GIF ends early')
    return this.data[this.offset++]!
  }

  u16(): number {
    return this.u8() | (this.u8() << 8)
  }

  take(length: number): Uint8Array {
    if (this.offset + length > this.data.length) throw new Error('GIF ends early')
    const slice = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return slice
  }

  /** Reads a run of length-prefixed sub-blocks into one array. */
  subBlocks(): Uint8Array {
    const parts: Uint8Array[] = []
    let total = 0
    for (let size = this.u8(); size > 0; size = this.u8()) {
      parts.push(this.take(size))
      total += size
    }
    const joined = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
      joined.set(part, at)
      at += part.length
    }
    return joined
  }
}

function decodeGif(bytes: Uint8Array): Animation {
  const reader = new ByteReader(bytes)
  const signature = String.fromCharCode(...reader.take(6))
  if (!signature.startsWith('GIF')) throw new Error('not a GIF')

  const width = reader.u16()
  const height = reader.u16()
  const screen = reader.u8()
  reader.take(2) // background colour index and pixel aspect: unused
  const globalTable = screen & 0x80 ? reader.take(3 * (2 << (screen & 7))) : undefined

  const canvas = new Uint8Array(width * height * 4)
  const frames: Frame[] = []
  let control = DEFAULT_CONTROL

  for (;;) {
    const block = reader.u8()
    if (block === 0x3b) break // trailer

    if (block === 0x21) {
      const label = reader.u8()
      if (label === 0xf9) {
        control = readGraphicControl(reader)
      } else {
        reader.subBlocks() // comments, application data: skipped
      }
      continue
    }

    if (block !== 0x2c) throw new Error(`unknown GIF block 0x${block.toString(16)}`)

    const left = reader.u16()
    const top = reader.u16()
    const frameWidth = reader.u16()
    const frameHeight = reader.u16()
    const image = reader.u8()
    const table = image & 0x80 ? reader.take(3 * (2 << (image & 7))) : globalTable
    if (!table) throw new Error('GIF frame has no colour table')

    const minCodeSize = reader.u8()
    const indices = lzwDecode(reader.subBlocks(), minCodeSize, frameWidth * frameHeight)
    const rowOrder = image & 0x40 ? interlacedRows(frameHeight) : undefined
    const saved = control.disposal === 3 ? canvas.slice() : undefined

    for (let y = 0; y < frameHeight; y++) {
      const canvasY = top + (rowOrder ? rowOrder[y]! : y)
      if (canvasY >= height) continue
      for (let x = 0; x < frameWidth; x++) {
        const index = indices[y * frameWidth + x]!
        const canvasX = left + x
        if (index === control.transparent || canvasX >= width) continue
        const pixel = (canvasY * width + canvasX) * 4
        canvas[pixel] = table[index * 3]!
        canvas[pixel + 1] = table[index * 3 + 1]!
        canvas[pixel + 2] = table[index * 3 + 2]!
        canvas[pixel + 3] = 255
      }
    }

    frames.push({ rgba: canvas.slice(), delayMs: control.delayMs })

    if (control.disposal === 2) {
      clearRect(canvas, width, left, top, frameWidth, frameHeight)
    } else if (saved) {
      canvas.set(saved)
    }
    control = DEFAULT_CONTROL
  }

  if (frames.length === 0) throw new Error('GIF has no frames')
  return { width, height, frames }
}

function readGraphicControl(reader: ByteReader): GraphicControl {
  reader.u8() // block size, always 4
  const packed = reader.u8()
  const delayCs = reader.u16()
  const transparentIndex = reader.u8()
  reader.u8() // block terminator
  const delayMs = delayCs * 10
  return {
    delayMs: delayMs < MIN_DELAY_MS ? 100 : delayMs,
    disposal: (packed >> 2) & 7,
    transparent: packed & 1 ? transparentIndex : -1,
  }
}

/** Variable-width LZW, as GIF packs it: least significant bit first. */
function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount)
  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1
  const prefix = new Uint16Array(4096)
  const suffix = new Uint8Array(4096)
  const stack = new Uint8Array(4097)

  let codeSize = minCodeSize + 1
  let nextCode = endCode + 1
  let previous = -1
  let firstByte = 0
  let buffer = 0
  let bits = 0
  let written = 0
  let at = 0

  while (written < pixelCount) {
    while (bits < codeSize && at < data.length) {
      buffer |= data[at++]! << bits
      bits += 8
    }
    if (bits < codeSize) break

    const code = buffer & ((1 << codeSize) - 1)
    buffer >>>= codeSize
    bits -= codeSize

    if (code === clearCode) {
      codeSize = minCodeSize + 1
      nextCode = endCode + 1
      previous = -1
      continue
    }
    if (code === endCode) break

    if (previous === -1) {
      out[written++] = code
      previous = code
      firstByte = code
      continue
    }

    // Unwind the code's string onto the stack, last byte first. A code not
    // yet in the table is the previous string plus its own first byte.
    let depth = 0
    let current = code
    if (code >= nextCode) {
      stack[depth++] = firstByte
      current = previous
    }
    while (current >= clearCode) {
      stack[depth++] = suffix[current]!
      current = prefix[current]!
    }
    firstByte = current
    stack[depth++] = current
    while (depth > 0 && written < pixelCount) out[written++] = stack[--depth]!

    if (nextCode < 4096) {
      prefix[nextCode] = previous
      suffix[nextCode] = firstByte
      nextCode++
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize++
    }
    previous = code
  }

  return out
}

/** Maps each stored row to its place on screen for an interlaced frame. */
function interlacedRows(height: number): number[] {
  const order: number[] = []
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) {
    for (let row = start; row < height; row += step) order.push(row)
  }
  return order
}

function clearRect(
  canvas: Uint8Array,
  width: number,
  left: number,
  top: number,
  rectWidth: number,
  rectHeight: number
): void {
  const height = canvas.length / 4 / width
  for (let y = top; y < Math.min(top + rectHeight, height); y++) {
    const start = (y * width + left) * 4
    const end = (y * width + Math.min(left + rectWidth, width)) * 4
    canvas.fill(0, start, end)
  }
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

/**
 * Plays an RGBA strip of square frames in order, each for `frameMs`: the
 * Prism archive keeps animations unrolled this way, without timings.
 */
function animateStrip(strip: Rgba, frameMs: number): Animation {
  const size = strip.width
  const count = Math.max(1, Math.floor(strip.height / size))
  const frameBytes = size * size * 4
  const frames = Array.from({ length: count }, (_, i) =>
    strip.rgba.slice(i * frameBytes, (i + 1) * frameBytes)
  )
  return {
    width: size,
    height: size,
    frames: [
      ...frames.map(rgba => ({ rgba, delayMs: frameMs })),
      { rgba: frames[0]!, delayMs: 0 }, // back to rest; the loop pause is added later
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

// ── Sprite sources ──────────────────────────────────────────────────────────
// Each public repository is a strategy: how to list its sprites, which files
// one sprite needs, and how those files become an animation. Sources share no
// base class; each is a plain object that meets `SpriteSource`, and the
// Pokédex below composes them. None of their files is stored in this mod's
// repository: each is fetched at run time.

type SourceId = 'crystal' | 'polished' | 'prism'
type Repo = { owner: string; name: string; ref: string; dir: string }

/** One sprite in one source, with its species and form for de-duplication. */
type Entry = {
  source: SourceId
  name: string
  species: string
  form: string
  /** Paths relative to the source's `repo.dir`, by role. */
  paths: Record<string, string>
}

/** A file one sprite needs: binary files arrive as base64, text as text. */
type FileNeed = { role: string; path: string; isBinary: boolean }
type Files = Record<string, string>

/** What a source may use to list its sprites. */
interface Fetcher {
  json<T>(url: string): Promise<T>
}

interface SpriteSource {
  readonly id: SourceId
  readonly repo: Repo
  /** Lists every sprite, in as few requests as it can. */
  list(fetcher: Fetcher): Promise<Entry[]>
  /** The files one sprite needs, with its normal or shiny colours. */
  needs(entry: Entry, isShiny: boolean): FileNeed[]
  /** Turns those files into frames. */
  animate(files: Files): Animation
}

const github = {
  tree: (repo: Repo) =>
    `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${repo.ref}:${repo.dir}?recursive=1`,
  contents: (repo: Repo, path: string) =>
    `https://api.github.com/repos/${repo.owner}/${repo.name}/contents/${joinPath(repo.dir, path)}?ref=${repo.ref}`,
  raw: (repo: Repo, path: string) =>
    `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.ref}/${joinPath(repo.dir, path)}`,
}

const joinPath = (dir: string, path: string) => (dir ? `${dir}/${path}` : path)

async function listFiles(fetcher: Fetcher, repo: Repo): Promise<string[]> {
  const { tree } = await fetcher.json<{ tree: { path: string; type: string }[] }>(github.tree(repo))
  return tree.filter(item => item.type === 'blob').map(item => item.path)
}

/** Species whose folder names hold an underscore of their own. */
const UNDERSCORE_SPECIES = [
  'mr__mime', 'mr__rime', 'mime_jr_', 'porygon_z', 'ho_oh',
  'nidoran_f', 'nidoran_m', 'farfetch_d', 'sirfetch_d',
]

const canonical = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Splits a folder name into species and form: `raichu_alolan` is Raichu in
 * its Alolan form, and `pikachu_plain` is plain Pikachu.
 */
function splitName(name: string): { species: string; form: string } {
  const lower = name.toLowerCase()
  const special = UNDERSCORE_SPECIES.find(s => lower === s || lower.startsWith(`${s}_`))
  const species = special ?? lower.split('_')[0] ?? lower
  const form = canonical(lower.slice(species.length))
  return { species: canonical(species), form: form === 'plain' ? '' : form }
}

/** One binary image, normal or shiny: the shape of two of the sources. */
const imageNeeds = (entry: Entry, isShiny: boolean): FileNeed[] => [
  { role: 'image', path: (isShiny ? entry.paths.shiny : entry.paths.image)!, isBinary: true },
]

const CRYSTAL_REPO: Repo = {
  owner: 'PokeAPI',
  name: 'sprites',
  ref: 'master',
  dir: 'sprites/pokemon/versions/generation-ii/crystal/animated',
}
const SPECIES_NAMES_URL = 'https://pokeapi.co/api/v2/pokemon-species?limit=251'

/** Pokémon Crystal's own sprites, as animated GIFs, from PokeAPI. */
const crystal: SpriteSource = {
  id: 'crystal',
  repo: CRYSTAL_REPO,
  async list(fetcher) {
    const [paths, { results }] = await Promise.all([
      listFiles(fetcher, CRYSTAL_REPO),
      fetcher.json<{ results: { name: string }[] }>(SPECIES_NAMES_URL),
    ])
    const files = new Set(paths)
    return paths.flatMap(path => {
      const match = /^(\d+)(?:-(\w+))?\.gif$/.exec(path)
      const species = match && results[Number(match[1]) - 1]?.name
      if (!match || !species) return []
      const shiny = `shiny/${path}`
      const entry: Entry = {
        source: 'crystal',
        name: path.replace('.gif', ''),
        species: canonical(species),
        form: canonical(match[2] ?? ''),
        paths: { image: path, shiny: files.has(shiny) ? shiny : path },
      }
      return [entry]
    })
  },
  needs: imageNeeds,
  animate: files => decodeGif(fromBase64(files.image!)),
}

const POLISHED_REPO: Repo = { owner: 'Rangi42', name: 'polishedcrystal', ref: 'master', dir: 'gfx/pokemon' }

/** Polished Crystal's pics, frame scripts and palettes. */
const polished: SpriteSource = {
  id: 'polished',
  repo: POLISHED_REPO,
  async list(fetcher) {
    const paths = await listFiles(fetcher, POLISHED_REPO)
    const files = new Set(paths)
    const excluded = new Set<string>(CONFIG.exclude)
    // A form without palettes of its own uses its species' palettes.
    const findUp = (name: string, file: string): string | undefined => {
      for (const parts = name.split('_'); parts.length > 0; parts.pop()) {
        const path = `${parts.join('_')}/${file}`
        if (files.has(path)) return path
      }
      return undefined
    }
    return paths.flatMap(path => {
      const name = /^([^/]+)\/front\.png$/.exec(path)?.[1]
      const normal = name && !excluded.has(name) ? findUp(name, 'normal.pal') : undefined
      if (!name || !normal) return []
      const anim = `${name}/anim.asm`
      const entry: Entry = {
        source: 'polished',
        name,
        ...splitName(name),
        paths: {
          pic: path,
          normal,
          shiny: findUp(name, 'shiny.pal') ?? normal,
          ...(files.has(anim) ? { anim } : {}),
        },
      }
      return [entry]
    })
  },
  needs: (entry, isShiny) => [
    { role: 'pic', path: entry.paths.pic!, isBinary: true },
    ...(entry.paths.anim ? [{ role: 'anim', path: entry.paths.anim, isBinary: false }] : []),
    { role: 'palette', path: (isShiny ? entry.paths.shiny : entry.paths.normal)!, isBinary: false },
  ],
  animate(files) {
    const pic = decodePng(fromBase64(files.pic!))
    if (pic.kind !== 'shades') throw new Error('Polished Crystal pic is not greyscale')
    return animatePic(pic, files.anim ?? null, parsePalette(files.palette!))
  },
}

const PRISM_REPO: Repo = { owner: 'bottlebrushes', name: 'pokemon-prism-assets', ref: 'main', dir: '' }

/** Pokémon Prism's sprites, from a third-party archive of its extracted graphics. */
const prism: SpriteSource = {
  id: 'prism',
  repo: PRISM_REPO,
  async list(fetcher) {
    type Asset = { type: string; slug: string; path: string; has_shiny?: boolean }
    const { assets } = await fetcher.json<{ assets: Asset[] }>(github.raw(PRISM_REPO, 'manifest.json'))
    return assets
      .filter(asset => asset.type === 'pokemon')
      .map(asset => {
        const image = `${asset.path}/front.png`
        const entry: Entry = {
          source: 'prism',
          name: asset.slug,
          ...splitName(asset.slug),
          paths: { image, shiny: asset.has_shiny ? `${asset.path}/shiny.png` : image },
        }
        return entry
      })
  },
  needs: imageNeeds,
  animate(files) {
    const strip = decodePng(fromBase64(files.image!))
    if (strip.kind !== 'rgba') throw new Error('Prism strip is not RGBA')
    return animateStrip(strip, CONFIG.stripFrameMs)
  },
}

/** Every source, in priority order: the first to have a species and form wins. */
const SOURCES: readonly SpriteSource[] = [crystal, polished, prism]

/** The `userConfig` switch in plugin.json for each source. */
const SOURCE_OPTIONS: Record<SourceId, string> = {
  crystal: 'crystal',
  polished: 'polishedCrystal',
  prism: 'prism',
}

/** The sources this user has on; a switch left unset counts as on. */
function enabledSources(options: PluginOptions): SpriteSource[] {
  return SOURCES.filter(source => options[SOURCE_OPTIONS[source.id]] !== false)
}

// ── Collection ──────────────────────────────────────────────────────────────
// Three collaborators, composed by the hooks: an HTTP client for GitHub, a
// cache over the plugin store, and the Pokédex, which gathers the enabled
// sources into one list with each species and form once, picks a sprite and
// loads it. The engine is reached only through the ports passed in.

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

class HttpClient implements Fetcher {
  private static readonly USER_AGENT = { 'User-Agent': 'pokemon-buddy (Claude Code mod)' }
  private static readonly GITHUB_API = {
    ...HttpClient.USER_AGENT,
    Accept: 'application/vnd.github+json',
  }

  constructor(private readonly fetch: SourcePorts['fetch']) {}

  async text(url: string): Promise<string> {
    const isGitHubApi = url.startsWith('https://api.github.com/')
    const headers = isGitHubApi ? HttpClient.GITHUB_API : HttpClient.USER_AGENT
    const response = await this.fetch(url, { headers })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return response.text
  }

  async json<T>(url: string): Promise<T> {
    return JSON.parse(await this.text(url)) as T
  }

  /**
   * Fetches a binary file through the GitHub contents API, which sends it as
   * base64 JSON: the host's fetch hands back text, which would mangle bytes.
   */
  async base64(repo: Repo, path: string): Promise<string> {
    const { content } = await this.json<{ content?: string }>(github.contents(repo, path))
    if (!content) throw new Error(`${path} came back empty`)
    return content.replace(/\s/g, '')
  }
}

type StoredList = { fetchedAt: number; entries: Entry[] }
type StoredSprite = { entry: Entry; files: Files }

class SpriteCache {
  private static readonly LIST = 'list:'
  private static readonly SPRITE = 'sprite:'
  /** Keys an earlier version of the mod wrote. */
  private static readonly LEGACY = (key: string) =>
    key === 'index' || key.startsWith('gif:') || key.startsWith('pic:')

  constructor(private readonly store: SourcePorts['store']) {}

  async list(source: SourceId): Promise<StoredList | undefined> {
    return (await this.store.get(`${SpriteCache.LIST}${source}`)) as StoredList | undefined
  }

  async saveList(source: SourceId, list: StoredList): Promise<void> {
    await this.store.set(`${SpriteCache.LIST}${source}`, list)
  }

  async sprite(entry: Entry): Promise<Files | undefined> {
    const stored = (await this.store.get(this.spriteKey(entry))) as StoredSprite | undefined
    return stored?.files
  }

  /** Stores a sprite and drops the oldest ones past the cache limit. */
  async saveSprite(entry: Entry, files: Files): Promise<void> {
    await this.store.set(this.spriteKey(entry), { entry, files } satisfies StoredSprite)
    const keys = (await this.store.keys()).filter(key => key.startsWith(SpriteCache.SPRITE))
    for (const old of keys.slice(0, Math.max(0, keys.length - CONFIG.cacheLimit))) {
      await this.store.delete(old)
    }
  }

  /** A random cached sprite from one of `sources`, if there is one. */
  async anySprite(sources: readonly SourceId[]): Promise<StoredSprite | undefined> {
    const prefixes = sources.map(source => `${SpriteCache.SPRITE}${source}:`)
    const keys = (await this.store.keys()).filter(key => prefixes.some(p => key.startsWith(p)))
    const key = keys[randomInt(keys.length)]
    return key ? ((await this.store.get(key)) as StoredSprite | undefined) : undefined
  }

  async dropLegacy(): Promise<void> {
    for (const key of await this.store.keys()) {
      if (SpriteCache.LEGACY(key)) await this.store.delete(key)
    }
  }

  private spriteKey(entry: Entry): string {
    return `${SpriteCache.SPRITE}${entry.source}:${entry.name}`
  }
}

class Pokedex {
  private readonly http: HttpClient
  private readonly cache: SpriteCache

  constructor(
    private readonly ports: SourcePorts,
    private readonly sources: readonly SpriteSource[]
  ) {
    this.http = new HttpClient(ports.fetch)
    this.cache = new SpriteCache(ports.store)
  }

  /**
   * One random sprite, ready to draw. When the network fails, a sprite
   * cached by an earlier session stands in.
   */
  async summon(): Promise<Sprite> {
    const isShiny = CONFIG.shinyOdds > 0 && randomInt(CONFIG.shinyOdds) === 0
    try {
      const entry = pickEntry(await this.collect())
      if (!entry) throw new Error('no sprites to pick from')
      const source = this.sourceOf(entry.source)!
      return shapeSprite(source.animate(await this.load(source, entry, isShiny)))
    } catch (error) {
      const stored = await this.cache.anySprite(this.sources.map(source => source.id))
      const source = stored && this.sourceOf(stored.entry.source)
      if (!stored || !source) throw error
      return shapeSprite(source.animate(stored.files))
    }
  }

  /** Every enabled source's sprites, one per species and form. */
  async collect(): Promise<Entry[]> {
    const lists = await Promise.all(
      this.sources.map(source => this.list(source).catch((): Entry[] => []))
    )
    return dedupe(lists.flat())
  }

  /** A source's list, fetched again once it is older than `listMaxAgeMs`. */
  private async list(source: SpriteSource): Promise<Entry[]> {
    const now = await this.ports.now()
    const stored = await this.cache.list(source.id)
    if (stored && now - stored.fetchedAt < CONFIG.listMaxAgeMs) return stored.entries

    try {
      const entries = await source.list(this.http)
      await this.cache.saveList(source.id, { fetchedAt: now, entries })
      await this.cache.dropLegacy()
      return entries
    } catch (error) {
      if (stored) return stored.entries
      throw error
    }
  }

  /**
   * Fetches one sprite's files. Normal colours are cached; a shiny is fetched
   * each time, and falls back to normal colours when it cannot be.
   */
  private async load(source: SpriteSource, entry: Entry, isShiny: boolean): Promise<Files> {
    const cached = isShiny ? undefined : await this.cache.sprite(entry)
    if (cached) return cached

    try {
      const needs = source.needs(entry, isShiny)
      const contents = await Promise.all(
        needs.map(need =>
          need.isBinary
            ? this.http.base64(source.repo, need.path)
            : this.http.text(github.raw(source.repo, need.path))
        )
      )
      const files: Files = Object.fromEntries(needs.map((need, i) => [need.role, contents[i]!]))
      if (!isShiny) await this.cache.saveSprite(entry, files)
      return files
    } catch (error) {
      if (isShiny) return this.load(source, entry, false)
      throw error
    }
  }

  private sourceOf(id: SourceId): SpriteSource | undefined {
    return this.sources.find(source => source.id === id)
  }
}

/** Keeps the first entry of each species and form, so source order is priority. */
function dedupe(entries: readonly Entry[]): Entry[] {
  const seen = new Set<string>()
  return entries.filter(entry => {
    const key = `${entry.species}/${entry.form}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Picks a species first, then one of its forms, so a species with many
 * forms (Unown, Magikarp) is no likelier than one with a single form.
 */
function pickEntry(entries: readonly Entry[]): Entry | undefined {
  const bySpecies = new Map<string, Entry[]>()
  for (const entry of entries) {
    bySpecies.set(entry.species, [...(bySpecies.get(entry.species) ?? []), entry])
  }
  const forms = [...bySpecies.values()][randomInt(bySpecies.size)] ?? []
  return forms[randomInt(forms.length)]
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

export const register: Register = (on, options) => {
  const sources = enabledSources(options)
  let player: Player | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (e.surface !== 'terminal') return result

    const ports: SourcePorts = {
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
    new Pokedex(ports, sources)
      .summon()
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
