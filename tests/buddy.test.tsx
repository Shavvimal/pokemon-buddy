import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Test data made for this repository, in each source's format: a shaded
// square drawn for these tests. No sprite from any game or ROM hack is
// stored here.

/** Polished Crystal format: a 16×16 two-frame greyscale pic. */
const PIC =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAgAgAAAAB0Ur+xAAAAI0lEQVR42mP4DwQMCOIPA4M9w59V'
  + 'q8giQHqxmhcaShYB1AsACNhN0WM2a8AAAAAASUVORK5CYII='
const ANIM = '\tframe 1, 06\n\tsetrepeat 2\n\tframe 0, 06\n\tframe 1, 06\n\tdorepeat 2\n\tendanim\n'
const NORMAL = '\tRGB 31, 24, 00\n\tRGB 20, 08, 00\n'
const SHINY = '\tRGB 00, 24, 31\n\tRGB 00, 08, 20\n'

/** Prism format: the same square as a coloured RGBA strip. */
const STRIP =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAgCAYAAAAbifjMAAAAMklEQVR42mNgGHbgP5EYtwE/DuDH'
  + 'owaMGjBEDKA0L4yWB0DJBQ748agBowYMEQNIzQsAmFTnTCr64PQAAAAASUVORK5CYII='

/** Pokémon Crystal (PokeAPI) format: the same square as an animated GIF. */
const GIF =
  'R0lGODlhEAAQAPEAAAAAAKBAAPjAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQJDAADACwAAAAA'
  + 'EAAQAAACkdy4cePGjRs3bty4cePGjRs3bty4cePGjRs3btw4ECBAgAAxbtw4UKJEiRIxbtw4UKJE'
  + 'iRIxbtw4UKJEiRIxbtw4UKJEiRIxbtw4UKJEiRIxbtw4UKJEiRIxbtw4UKJEiRIxbtw4UKJEiRIx'
  + 'btw4UKJEiRIxbtw4UKJEiRIxbtw4UKJEiRIxbtw4ECBAgAAxbgUAIfkECQwAAwAsAAAAABAAEAAA'
  + 'ApHcuHHjxo0bN27cuHHjxo0bN27cuHHjxo0bN27cOBAgQIAAMW7cODBhwoQJMW7cODBhwoQJMW7c'
  + 'ODBhwoQJMW7cODBhwoQJMW7cODBhwoQJMW7cODBhwoQJMW7cODBhwoQJMW7cODBhwoQJMW7cODBh'
  + 'woQJMW7cODBhwoQJMW7cODBhwoQJMW7cOBAgQIAAMW4FADs='

const CRYSTAL_TREE = { tree: [{ path: '1.gif', type: 'blob' }, { path: 'shiny/1.gif', type: 'blob' }] }
const SPECIES = { results: [{ name: 'testmon' }] }
const POLISHED_TREE = {
  tree: [
    { path: 'testmon_plain/front.png', type: 'blob' },
    { path: 'testmon_plain/anim.asm', type: 'blob' },
    { path: 'testmon_alolan/front.png', type: 'blob' },
    { path: 'testmon_alolan/anim.asm', type: 'blob' },
    { path: 'testmon/normal.pal', type: 'blob' },
    { path: 'testmon/shiny.pal', type: 'blob' },
    { path: 'egg/front.png', type: 'blob' },
    { path: 'egg/normal.pal', type: 'blob' },
  ],
}
const PRISM_MANIFEST = {
  assets: [
    { type: 'pokemon', slug: 'testmon', path: 'pokemon/testmon', has_shiny: false },
    { type: 'pokemon', slug: 'othermon', path: 'pokemon/othermon', has_shiny: false },
    { type: 'overworld', slug: 'overworld_testmon', path: 'overworld/testmon' },
  ],
}

const BAND = {
  plugin: 'pokemon-buddy',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const ONLY = {
  crystal: { crystal: true, polishedCrystal: false, prism: false },
  polished: { crystal: false, polishedCrystal: true, prism: false },
  prism: { crystal: false, polishedCrystal: false, prism: true },
} as const

const reply = (status: number, text: string) => ({
  value: { status, ok: status === 200, headers: {}, text },
})
const json = (body: unknown) => reply(200, JSON.stringify(body))
const contents = (base64: string) => json({ content: base64 })

/** Answers each URL the mod fetches the way GitHub and PokeAPI would. */
function internet(url: string) {
  if (url.includes('PokeAPI/sprites/git/trees/')) return json(CRYSTAL_TREE)
  if (url.startsWith('https://pokeapi.co/')) return json(SPECIES)
  if (url.includes('PokeAPI/sprites/contents/')) return contents(GIF)
  if (url.includes('polishedcrystal/git/trees/')) return json(POLISHED_TREE)
  if (url.includes('polishedcrystal/contents/')) return contents(PIC)
  if (url.endsWith('/anim.asm')) return reply(200, ANIM)
  if (url.endsWith('/normal.pal')) return reply(200, NORMAL)
  if (url.endsWith('/shiny.pal')) return reply(200, SHINY)
  if (url.endsWith('pokemon-prism-assets/main/manifest.json')) return json(PRISM_MANIFEST)
  if (url.includes('pokemon-prism-assets/contents/')) return contents(STRIP)
  return reply(404, 'Not Found')
}

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

/** Starts a terminal session with the mocked internet, and records each URL fetched. */
async function startSession($: Engine, on: On) {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: string[] = []
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    return internet(e.url)
  })
  const blits: string[] = []
  on('ui.blit', (_, e) => {
    blits.push(e.key)
    return { value: {} }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, fetched, blits }
}

for (const [source, options] of Object.entries(ONLY)) {
  test(`draws and animates a sprite from ${source} alone`, { options }, async ($, on) => {
    const { clock, blits } = await startSession($, on)

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const image = await ui.find({ type: 'Image', key: 'sprite' })
    expect(image?.props.rows).toBe(3)
    expect(image?.props.columns).toBe(6)
    expect(await ui.find({ type: 'Text' })).toBeUndefined()

    await clock.advance(10_000)
    expect(blits.length).toBeGreaterThan(0)
    expect(blits.every(key => key === 'sprite')).toBe(true)
    await ui.unmount()
  })
}

test('keeps one sprite per species and form, in source order', async ($, on) => {
  // Crystal has testmon; Polished Crystal has plain and Alolan testmon;
  // Prism has testmon and othermon. Plain testmon must come from Crystal.
  const { fetched } = await startSession($, on)
  const images = fetched.filter(url => url.includes('/contents/'))
  expect(images.length).toBe(1)
  expect(images.some(url => url.includes('testmon_plain') || url.includes('pokemon/testmon/'))).toBe(false)
  expect(fetched.some(url => url.includes('egg/'))).toBe(false)
})

test('falls back to a cached sprite when the network fails', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, {
    'sprite:polished:testmon_plain': {
      entry: { source: 'polished', name: 'testmon_plain', species: 'testmon', form: '', paths: {} },
      files: { pic: PIC, anim: ANIM, palette: NORMAL },
    },
  })
  on('http.fetch', () => reply(403, '{"message":"API rate limit exceeded"}'))
  on('ui.blit', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Image', key: 'sprite' })).toBeDefined()
  await ui.unmount()
})

test('uses cached lists and sprites without a network call', { options: ONLY.prism }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const entry = {
    source: 'prism',
    name: 'testmon',
    species: 'testmon',
    form: '',
    paths: { image: 'pokemon/testmon/front.png', shiny: 'pokemon/testmon/front.png' },
  }
  mock.store(on, {
    'list:prism': { fetchedAt: 0, entries: [entry] },
    'sprite:prism:testmon': { entry, files: { image: STRIP } },
  })
  const fetched: string[] = []
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    return internet(e.url)
  })
  on('ui.blit', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  expect(fetched).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Image', key: 'sprite' })).toBeDefined()
  await ui.unmount()
})
