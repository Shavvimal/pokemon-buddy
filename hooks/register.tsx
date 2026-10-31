/**
 * Pokémon Buddy: one random animated Pokémon per Claude Code session, in the
 * band above the prompt, in one of two styles the user picks:
 * - Sky: a Pokémon Mystery Dungeon: Explorers of Sky style sprite from
 *   PMDCollab/SpriteCollab that walks the band and acts with some character
 *   (the engine is in sky.tsx);
 * - Crystal: a Game Boy Color style sprite at the right end of the band,
 *   from three public repositories gathered into one Pokédex with each
 *   species and form once: Pokémon Crystal's own sprites (PokeAPI/sprites),
 *   Polished Crystal (Rangi42/polishedcrystal) and Pokémon Prism (a
 *   third-party archive, bottlebrushes/pokemon-prism-assets).
 * This mod ships no sprites: it fetches them when a session starts, caches a
 * few for offline sessions, and plays them the way the games do. README.md
 * and NOTICE.md credit the artists and rights holders.
 *
 * Sections, top to bottom: configuration, pic animation, sprite shaping,
 * sprite sources, collection, playback, and hooks. The codecs (base64,
 * inflate, zip, PNG, GIF) are in codecs.ts. Pictures need a terminal with a
 * graphics protocol (Ghostty, kitty, or iTerm2 3.5+); anywhere else the band
 * stays empty.
 */
import type {
  HttpInit,
  HttpResponse,
  ImageSource,
  PluginOptions,
  Register,
  Timer,
} from 'claude-code'
import {
  decodeGif,
  decodePng,
  fromBase64,
  readZip,
  toBase64,
  type Animation,
  type Greyscale,
  type Rgba,
} from './codecs'
import { Actor, buildRig, pickSheets, profileFor, type Rig, type SessionEvent } from './sky'

// ── Configuration ───────────────────────────────────────────────────────────
// The style, and which Crystal sources are on, are per-user settings
// (`userConfig` in plugin.json); the rest is set here.

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
  /**
   * Sprites kept in the store for offline sessions: Crystal-style ones are
   * 2 to 25 KB each, Sky rigs 45 to 130 KB; the store holds 4 MiB in all.
   */
  cacheLimit: { crystal: 40, sky: 12 },
  /** Shows the buddy's name as a button under it; pressing it gets a reaction. */
  petButton: true,
  /** How long `curl` may take to fetch one Sky sprite zip, in ms. */
  downloadTimeoutMs: 25_000,
  /** How long each source's sprite list is kept before it is fetched again, in ms. */
  listMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Polished Crystal folders left out of the draw. */
  exclude: ['egg'],
} as const

// ── Pic animation ───────────────────────────────────────────────────────────
// Plays a Crystal "pic": a vertical strip of square frames, frame 0 the
// resting pose, run by a frame script of `frame N, ticks`, `setrepeat N`,
// `dorepeat COMMAND` and `endanim`, at 60 ticks a second. The four shades
// become white, the palette's light and dark colours, and black; white that
// touches the edge becomes transparent, as the battle background shows it.

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

type SourceId = 'crystal' | 'polished' | 'prism' | 'sky'
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
  post<T>(url: string, body: string): Promise<T>
}

interface SpriteSource {
  readonly id: SourceId
  readonly repo: Repo
  /** Lists every sprite, in as few requests as it can. */
  list(fetcher: Fetcher): Promise<Entry[]>
  /** The files one sprite needs, with its normal or shiny colours. */
  needs(entry: Entry, isShiny: boolean): FileNeed[]
  /**
   * A zip holding every file the sprite needs, tried before `needs`, and
   * text files fetched beside it when it lacks them (a miss is not an error).
   */
  zip?(entry: Entry, isShiny: boolean): {
    url: string
    unpack: (zip: Uint8Array) => Files
    extras?: FileNeed[]
  }
  /** Turns those files into frames: one looping animation, or a rig of clips. */
  animate(files: Files): Animation | Rig
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

const SKY_REPO: Repo = { owner: 'PMDCollab', name: 'SpriteCollab', ref: 'master', dir: 'sprite' }
const SKY_GRAPHQL = 'https://spriteserver.pmdcollab.org/graphql'
const SKY_ZIP = (path: string) => `https://spriteserver.pmdcollab.org/assets/${path}/sprites.zip`
/** Listing query: every species, every form, its sprite phase. */
const SKY_LIST_QUERY = '{ monster { id name forms { path isShiny isFemale sprites { phase } } } }'
/** The sheets fetched one by one when the zip cannot be: the core actions. */
const SKY_CORE = ['Idle', 'Walk', 'Sleep', 'Rotate']

type SkyMonster = {
  id: number
  name: string
  forms: { path: string; isShiny: boolean; isFemale: boolean; sprites: { phase: string | null } }[]
}

/**
 * PMDCollab/SpriteCollab: Explorers of Sky style sprites with walk cycles in
 * eight directions and a set of actions, listed through the project's
 * GraphQL server and fetched as one zip per sprite.
 */
const sky: SpriteSource = {
  id: 'sky',
  repo: SKY_REPO,
  async list(fetcher) {
    const { data } = await fetcher.post<{ data?: { monster?: SkyMonster[] } }>(
      SKY_GRAPHQL,
      JSON.stringify({ query: SKY_LIST_QUERY })
    )
    const monsters = data?.monster ?? []
    if (monsters.length === 0) throw new Error('SpriteCollab listed no sprites')
    return monsters.flatMap(monster => {
      const dex = String(monster.id).padStart(4, '0')
      const isDrawn = (form: SkyMonster['forms'][number]) =>
        form.sprites.phase === 'EXISTS' || form.sprites.phase === 'FULL'
      const shinies = new Set(monster.forms.filter(f => f.isShiny && isDrawn(f)).map(f => f.path))
      return monster.forms
        .filter(form => !form.isShiny && !form.isFemale && isDrawn(form))
        .map(form => {
          const path = form.path ? `${dex}/${form.path}` : dex
          const shinyPath = `${form.path || '0000'}/0001`
          const entry: Entry = {
            source: 'sky',
            name: path,
            species: canonical(monster.name),
            form: canonical(form.path),
            paths: { shiny: shinies.has(shinyPath) ? `${dex}/${shinyPath}` : path, species: monster.name },
          }
          return entry
        })
    })
  },
  zip(entry, isShiny) {
    const path = isShiny ? entry.paths.shiny! : entry.name
    return {
      url: SKY_ZIP(path),
      unpack: bytes => pickSheets(readZip(bytes)),
      // Not every zip carries the credits; the repository always does.
      extras: [{ role: 'credits', path: `${path}/credits.txt`, isBinary: false }],
    }
  },
  needs(entry, isShiny) {
    const path = isShiny ? entry.paths.shiny! : entry.name
    return [
      { role: 'xml', path: `${path}/AnimData.xml`, isBinary: false },
      ...SKY_CORE.flatMap(action =>
        ['Anim', 'Offsets', 'Shadow'].map(kind => ({
          role: `${action}-${kind}`,
          path: `${path}/${action}-${kind}.png`,
          isBinary: true,
        }))
      ),
    ]
  },
  animate: files => buildRig(files, CONFIG),
}

/** Every Crystal-style source, in priority order: the first to have a species and form wins. */
const CRYSTAL_SOURCES: readonly SpriteSource[] = [crystal, polished, prism]

/** The `userConfig` switch in plugin.json for each Crystal-style source. */
const SOURCE_OPTIONS: Partial<Record<SourceId, string>> = {
  crystal: 'crystal',
  polished: 'polishedCrystal',
  prism: 'prism',
}

/**
 * The sources this user's style draws from: the Sky source alone, or the
 * Crystal-style sources left on (a switch left unset counts as on).
 */
function enabledSources(options: PluginOptions): SpriteSource[] {
  if (options.style !== 'crystal') return [sky]
  return CRYSTAL_SOURCES.filter(source => options[SOURCE_OPTIONS[source.id]!] !== false)
}

// ── Collection ──────────────────────────────────────────────────────────────
// Three collaborators, composed by the hooks: an HTTP client for GitHub, a
// cache over the plugin store, and the Pokédex, which gathers the enabled
// sources into one list with each species and form once, picks a sprite and
// loads it. The engine is reached only through the ports passed in.

type SourcePorts = {
  now: () => Promise<number>
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  /** Fetches a binary file through a host command; resolves its bytes. */
  download: (url: string) => Promise<Uint8Array>
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

  async post<T>(url: string, body: string): Promise<T> {
    const headers = { ...HttpClient.USER_AGENT, 'Content-Type': 'application/json' }
    const response = await this.fetch(url, { method: 'POST', headers, body })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return JSON.parse(response.text) as T
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

  /** Stores a sprite and drops the oldest ones of its kind past the cache limit. */
  async saveSprite(entry: Entry, files: Files): Promise<void> {
    await this.store.set(this.spriteKey(entry), { entry, files } satisfies StoredSprite)
    const isSky = entry.source === 'sky'
    const keys = (await this.store.keys()).filter(
      key => key.startsWith(SpriteCache.SPRITE) && key.startsWith(`${SpriteCache.SPRITE}sky:`) === isSky
    )
    const limit = isSky ? CONFIG.cacheLimit.sky : CONFIG.cacheLimit.crystal
    for (const old of keys.slice(0, Math.max(0, keys.length - limit))) {
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
  async summon(): Promise<Summoned> {
    const isShiny = CONFIG.shinyOdds > 0 && randomInt(CONFIG.shinyOdds) === 0
    try {
      const entry = pickEntry(await this.collect())
      if (!entry) throw new Error('no sprites to pick from')
      const source = this.sourceOf(entry.source)!
      return summoned(entry, source.animate(await this.load(source, entry, isShiny)), isShiny)
    } catch (error) {
      const stored = await this.cache.anySprite(this.sources.map(source => source.id))
      const source = stored && this.sourceOf(stored.entry.source)
      if (!stored || !source) throw error
      return summoned(stored.entry, source.animate(stored.files), false)
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
      const files = (await this.loadZip(source, entry, isShiny)) ?? (await this.loadFiles(source, entry, isShiny))
      if (!isShiny) await this.cache.saveSprite(entry, files)
      return files
    } catch (error) {
      if (isShiny) return this.load(source, entry, false)
      throw error
    }
  }

  /** The sprite's zip through the host's `curl`, or undefined when that path fails. */
  private async loadZip(source: SpriteSource, entry: Entry, isShiny: boolean): Promise<Files | undefined> {
    const zip = source.zip?.(entry, isShiny)
    if (!zip) return undefined
    let files: Files
    try {
      files = zip.unpack(await this.ports.download(zip.url))
    } catch {
      return undefined
    }
    for (const extra of zip.extras ?? []) {
      if (files[extra.role] !== undefined) continue
      const text = await this.http.text(github.raw(source.repo, extra.path)).catch(() => undefined)
      if (text !== undefined) files[extra.role] = text
    }
    return files
  }

  /** The sprite's files one by one: binaries through the GitHub contents API. */
  private async loadFiles(source: SpriteSource, entry: Entry, isShiny: boolean): Promise<Files> {
    const needs = source.needs(entry, isShiny)
    const contents = await Promise.all(
      needs.map(need =>
        need.isBinary
          ? this.http.base64(source.repo, need.path)
          : this.http.text(github.raw(source.repo, need.path))
      )
    )
    return Object.fromEntries(needs.map((need, i) => [need.role, contents[i]!]))
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

/** A uniform random number in [0, 1), from the same generator. */
function randomUnit(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296
}

/** What `summon` hands the hooks: a looping sprite, or a rig for the actor. */
type Summoned =
  | { kind: 'loop'; entry: Entry; sprite: Sprite; isShiny: boolean }
  | { kind: 'rig'; entry: Entry; rig: Rig; isShiny: boolean }

function summoned(entry: Entry, animated: Animation | Rig, isShiny: boolean): Summoned {
  if ('kind' in animated && animated.kind === 'rig') return { kind: 'rig', entry, rig: animated, isShiny }
  return { kind: 'loop', entry, sprite: shapeSprite(animated as Animation), isShiny }
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

/** The line the buddy is logged with: its species, style and artists. */
function describe(summon: Summoned): string {
  const species = summon.entry.paths.species ?? summon.entry.species
  const style = summon.kind === 'rig' ? 'Sky' : 'Crystal'
  const shiny = summon.isShiny ? ', shiny' : ''
  const credits = summon.kind === 'rig' ? skyArtists(summon.rig.credits) : ''
  return `${species} (${style}${shiny})${credits ? `, sprites by ${credits}` : ''}`
}

/** The current artists in a SpriteCollab credits.txt: `date<TAB>author<TAB>CUR|OLD<TAB>...`. */
function skyArtists(credits: string | undefined): string {
  if (!credits) return ''
  const names = credits
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts[2] === 'CUR' && parts[1])
    .map(parts => parts[1]!)
  return [...new Set(names)].join(', ')
}

export const register: Register = (on, options) => {
  const sources = enabledSources(options)
  let player: Player | undefined
  let actor: Actor | undefined
  let name = ''

  const notify = (event: SessionEvent) => actor?.notify(event)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (e.surface !== 'terminal') return result

    const ports: SourcePorts = {
      now: () => $.clock.now(),
      fetch: (url, init) => $.http.fetch(url, init),
      download: async url => {
        // The host's fetch hands back text, which would mangle a zip: curl
        // writes it to a file of its own, which is read as bytes and removed.
        const made = await $.process.run(['mktemp'])
        const path = made.stdout.trim()
        if (made.exitCode !== 0 || !path) throw new Error('mktemp failed')
        try {
          const got = await $.process.run(
            ['curl', '-sfL', '--max-time', String(Math.floor(CONFIG.downloadTimeoutMs / 1000)), '-o', path, url],
            { timeoutMs: CONFIG.downloadTimeoutMs + 5000 }
          )
          if (got.exitCode !== 0) throw new Error(`curl exited ${got.exitCode}`)
          const { base64 } = (await $.fs.read(path, { as: 'bytes' })) as { base64: string }
          return fromBase64(base64)
        } finally {
          await $.process.run(['rm', '-f', path]).catch(() => undefined)
        }
      },
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

    // Fetch in the background so the session never waits on the network.
    new Pokedex(ports, sources)
      .summon()
      .then(summon => {
        player?.stop()
        actor?.stop()
        player = undefined
        actor = undefined
        name = summon.entry.paths.species ?? summon.entry.species
        if (summon.kind === 'loop') {
          player = new Player(playback, summon.sprite)
          player.start()
        } else {
          const seed = Number(summon.entry.name.slice(0, 4)) || 1
          actor = new Actor(
            { ...playback, invalidate: () => $.ui.invalidate('ui.render'), random: randomUnit },
            summon.rig,
            profileFor(seed, summon.rig)
          )
          actor.start()
        }
        $.ui.log(describe(summon))
        $.ui.invalidate('ui.render')
      })
      .catch((error: unknown) => $.ui.log(`no sprite (${String(error)})`))
    return result
  })

  on('session.end', async ($, e, next) => {
    player?.stop()
    actor?.stop()
    return next(e)
  })

  // What the buddy notices: a prompt, a turn's start and end. Observers only.
  on('prompt.submit', ($, e, next) => {
    notify({ kind: 'prompt' })
    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) notify({ kind: 'turn-start' })
    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) notify({ kind: 'turn-end', isOk: e.reason === 'answer' })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const { Box, Button, Image } = $.ui.resolve(e)

    if (player) {
      player.site = e.requestId
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
    }
    if (!actor) return next(e)

    actor.setWorking(e.props.isWorking)
    actor.drawn(e.requestId, e.props.bodyColumns)
    return (
      <Box width="100%" height={CONFIG.rows} alignItems="flex-end">
        {CONFIG.petButton ? (
          <Button key="pet" plain dimColor onPress={() => notify({ kind: 'poke' })}>
            {name}
          </Button>
        ) : null}
        <Box position="absolute" left={actor.column} top={0}>
          <Image key={IMAGE_KEY} source={actor.source} columns={actor.columns} rows={CONFIG.rows} alt={name} />
        </Box>
      </Box>
    )
  })
}
