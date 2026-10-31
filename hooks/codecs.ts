/**
 * Codecs the mod carries, because the hooks runtime has none of them:
 * base64, inflate (zlib and raw deflate), a zip reader, a PNG decoder and
 * encoder, and a GIF decoder. Shared by `register.tsx` (the Crystal-style
 * sources) and `sky.tsx` (the SpriteCollab source). No game asset is stored
 * here.
 */

/** One frame of a decoded animation, RGBA, with its delay. */
export type Frame = { rgba: Uint8Array; delayMs: number }
export type Animation = { width: number; height: number; frames: Frame[] }

// ── Base64 ──────────────────────────────────────────────────────────────────
// The hooks runtime has the native Uint8Array base64 methods; TypeScript's
// standard lib declares them only from 6.0, so they are typed here.

export const fromBase64 = (base64: string): Uint8Array =>
  (Uint8Array as unknown as { fromBase64(text: string): Uint8Array }).fromBase64(base64)

export const toBase64 = (bytes: Uint8Array): string =>
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
export function inflateZlib(data: Uint8Array): Uint8Array {
  if (((data[0] ?? 0) & 0x0f) !== 8) throw new Error('not a zlib deflate stream')
  return inflateRaw(data.subarray(2))
}

/** Decompresses a raw deflate stream (RFC 1951), as a zip member holds it. */
export function inflateRaw(data: Uint8Array): Uint8Array {
  const reader = new BitReader(data)
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

// ── Zip reading ─────────────────────────────────────────────────────────────
// Reads a plain zip (stored or deflated members, no zip64, no encryption)
// through its central directory, which is where the member sizes are
// reliable; the SpriteCollab server's per-sprite zips are this shape.

const ZIP_END = 0x06054b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_LOCAL = 0x04034b50

/** Every member of a zip, by name, decompressed on demand. */
export function readZip(bytes: Uint8Array): Map<string, () => Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) {
    if (view.getUint32(at, true) === ZIP_END) {
      end = at
      break
    }
  }
  if (end < 0) throw new Error('not a zip: no end of central directory')
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)

  const members = new Map<string, () => Uint8Array>()
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== ZIP_CENTRAL) throw new Error('zip central directory is corrupt')
    const method = view.getUint16(at + 10, true)
    const compressedSize = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localAt = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength

    members.set(name, () => {
      if (view.getUint32(localAt, true) !== ZIP_LOCAL) throw new Error(`zip member ${name} is corrupt`)
      const dataAt =
        localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true)
      const data = bytes.subarray(dataAt, dataAt + compressedSize)
      if (method === 0) return data
      if (method === 8) return inflateRaw(data)
      throw new Error(`zip member ${name} uses compression method ${method}`)
    })
  }
  return members
}

// ── PNG decoding ────────────────────────────────────────────────────────────
// Reads the PNG kinds the sources use, all non-interlaced: greyscale (colour
// type 0, 1 to 8 bits), where each pixel becomes a Game Boy shade from 0
// (black) to 3 (white); 8-bit RGBA (colour type 6); 8-bit RGB (colour type
// 2); and 8-bit palette (colour type 3, with its tRNS transparency), which
// come back as RGBA.

export type Greyscale = { kind: 'shades'; width: number; height: number; shades: Uint8Array }
export type Rgba = { kind: 'rgba'; width: number; height: number; rgba: Uint8Array }

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export function decodePng(bytes: Uint8Array): Greyscale | Rgba {
  if (PNG_SIGNATURE.some((value, i) => bytes[i] !== value)) throw new Error('not a PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let width = 0
  let height = 0
  let depth = 0
  let colourType = -1
  let palette: Uint8Array | undefined
  let alphas: Uint8Array | undefined
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
        body[12] === 0 &&
        ((colourType === 0 && depth <= 8) || ([2, 3, 6].includes(colourType) && depth === 8))
      if (!isSupported) throw new Error('PNG is not greyscale, 8-bit RGB, RGBA or palette')
    } else if (type === 'PLTE') {
      palette = body
    } else if (type === 'tRNS') {
      alphas = body
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
  if (colourType === 2) {
    const rgb = unfilter(raw, width * 3, height, 3)
    const rgba = new Uint8Array(width * height * 4).fill(255)
    for (let p = 0; p < width * height; p++) rgba.set(rgb.subarray(p * 3, p * 3 + 3), p * 4)
    return { kind: 'rgba', width, height, rgba }
  }
  if (colourType === 3) {
    if (!palette) throw new Error('palette PNG has no PLTE')
    const indices = unfilter(raw, width, height, 1)
    const rgba = new Uint8Array(width * height * 4)
    for (let p = 0; p < width * height; p++) {
      const index = indices[p]!
      rgba.set(palette.subarray(index * 3, index * 3 + 3), p * 4)
      rgba[p * 4 + 3] = alphas && index < alphas.length ? alphas[index]! : 255
    }
    return { kind: 'rgba', width, height, rgba }
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

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return joined
}

// ── PNG encoding ────────────────────────────────────────────────────────────
// An 8-bit RGBA PNG for the pictures the mod paints: rows unfiltered, then
// deflate with fixed Huffman codes and a greedy LZ77 match. A painted sprite
// is mostly transparent and upscaled, so its pixels repeat along a row and
// row on row; a 105×70 sprite picture comes to about 1 KB, from 29 KB raw.

class BitWriter {
  private bytes = new Uint8Array(1024)
  private length = 0
  private buffer = 0
  private count = 0

  /** Writes the low `width` bits of `value`, least significant first. */
  bits(value: number, width: number): void {
    this.buffer |= value << this.count
    this.count += width
    while (this.count >= 8) {
      this.push(this.buffer & 0xff)
      this.buffer >>>= 8
      this.count -= 8
    }
  }

  /** Writes a Huffman code, which deflate packs most significant bit first. */
  code(code: number, width: number): void {
    let reversed = 0
    for (let i = 0; i < width; i++) reversed |= ((code >> i) & 1) << (width - 1 - i)
    this.bits(reversed, width)
  }

  finish(): Uint8Array {
    if (this.count > 0) this.push(this.buffer & 0xff)
    this.buffer = 0
    this.count = 0
    return this.bytes.subarray(0, this.length)
  }

  private push(byte: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2)
      grown.set(this.bytes)
      this.bytes = grown
    }
    this.bytes[this.length++] = byte
  }
}

/** A literal or length symbol in deflate's fixed code (RFC 1951, 3.2.6). */
function fixedLiteral(out: BitWriter, symbol: number): void {
  if (symbol < 144) out.code(0x30 + symbol, 8)
  else if (symbol < 256) out.code(0x190 + symbol - 144, 9)
  else if (symbol < 280) out.code(symbol - 256, 7)
  else out.code(0xc0 + symbol - 280, 8)
}

/** The index into LENGTH_BASE and DISTANCE_BASE for a match's length and distance. */
function baseIndex(bases: readonly number[], value: number): number {
  let index = bases.length - 1
  while (bases[index]! > value) index--
  return index
}

const MATCH_MIN = 3
const MATCH_MAX = 258
const WINDOW = 32768
const CHAIN_LIMIT = 16

/** Deflates `data` into one fixed-Huffman block, as a zlib stream. */
export function deflateZlib(data: Uint8Array): Uint8Array {
  const out = new BitWriter()
  out.bits(0x78, 8)
  out.bits(0x01, 8)
  out.bits(1, 1) // the last block
  out.bits(1, 2) // fixed Huffman codes

  const hashSize = 1 << 15
  const head = new Int32Array(hashSize).fill(-1)
  const previous = new Int32Array(data.length)
  const hashAt = (at: number) => ((data[at]! << 10) ^ (data[at + 1]! << 5) ^ data[at + 2]!) & (hashSize - 1)
  const insert = (at: number) => {
    if (at + MATCH_MIN > data.length) return
    const hash = hashAt(at)
    previous[at] = head[hash]!
    head[hash] = at
  }

  for (let at = 0; at < data.length; ) {
    let bestLength = 0
    let bestDistance = 0
    if (at + MATCH_MIN <= data.length) {
      const limit = Math.min(MATCH_MAX, data.length - at)
      let candidate = head[hashAt(at)]!
      for (let chain = 0; candidate >= 0 && at - candidate <= WINDOW && chain < CHAIN_LIMIT; chain++) {
        let length = 0
        while (length < limit && data[candidate + length] === data[at + length]) length++
        if (length > bestLength) {
          bestLength = length
          bestDistance = at - candidate
          if (length === limit) break
        }
        candidate = previous[candidate]!
      }
    }
    if (bestLength >= MATCH_MIN) {
      const lengthIndex = baseIndex(LENGTH_BASE, bestLength)
      fixedLiteral(out, 257 + lengthIndex)
      out.bits(bestLength - LENGTH_BASE[lengthIndex]!, LENGTH_EXTRA[lengthIndex]!)
      const distanceIndex = baseIndex(DISTANCE_BASE, bestDistance)
      out.code(distanceIndex, 5)
      out.bits(bestDistance - DISTANCE_BASE[distanceIndex]!, DISTANCE_EXTRA[distanceIndex]!)
      for (let i = 0; i < bestLength; i++) insert(at + i)
      at += bestLength
    } else {
      fixedLiteral(out, data[at]!)
      insert(at)
      at++
    }
  }
  fixedLiteral(out, 256)
  const body = out.finish()

  const zlib = new Uint8Array(body.length + 4)
  zlib.set(body)
  new DataView(zlib.buffer).setUint32(body.length, adler32(data))
  return zlib
}

function adler32(data: Uint8Array): number {
  let a = 1
  let b = 0
  for (let at = 0; at < data.length; ) {
    // 5552 bytes is the most that can be summed before the modulo overflows.
    const end = Math.min(data.length, at + 5552)
    for (; at < end; at++) {
      a += data[at]!
      b += a
    }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}

let crcTable: Uint32Array | undefined

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(body.length + 12)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(body, 8)
  view.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)))
  return chunk
}

/** An 8-bit RGBA PNG file of `width * height` pixels. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width * 4
  const raw = new Uint8Array((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    // Filter byte 0 (none) leads each row; it is already zero.
    raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1)
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8 // bits per sample
  header[9] = 6 // RGBA
  return concatBytes([
    Uint8Array.from(PNG_SIGNATURE),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateZlib(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ])
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

export function decodeGif(bytes: Uint8Array): Animation {
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

