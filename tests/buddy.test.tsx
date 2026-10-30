import { expect, mock, test } from 'claude-code/testing'

// Test data made for this repo, in the format Polished Crystal uses. No
// sprite from the game or the hack is stored here.

/** A 16×16 two-frame pic: a square with a light, then a dark, body. */
const PIC_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAgAgAAAAB0Ur+xAAAAI0lEQVR42mP4DwQMCOIPA4M9w59Vq8giQHqxmhcaShYB1AsACNhN0WM2a8AAAAAASUVORK5CYII='
const ANIM = '\tframe 1, 06\n\tsetrepeat 2\n\tframe 0, 06\n\tframe 1, 06\n\tdorepeat 2\n\tendanim\n'
const NORMAL = '\tRGB 31, 24, 00\n\tRGB 20, 08, 00\n'
const SHINY = '\tRGB 00, 24, 31\n\tRGB 00, 08, 20\n'

const TREE = {
  tree: [
    { path: 'testmon', type: 'tree' },
    { path: 'testmon/front.png', type: 'blob' },
    { path: 'testmon/anim.asm', type: 'blob' },
    { path: 'testmon/normal.pal', type: 'blob' },
    { path: 'testmon/shiny.pal', type: 'blob' },
    { path: 'egg/front.png', type: 'blob' },
    { path: 'egg/normal.pal', type: 'blob' },
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

const reply = (status: number, text: string) => ({
  value: { status, ok: status === 200, headers: {}, text },
})

/** Answers each URL the mod fetches the way GitHub would. */
const github = (url: string) => {
  if (url.includes('/git/trees/')) return reply(200, JSON.stringify(TREE))
  if (url.includes('/contents/') && url.includes('testmon/front.png')) {
    return reply(200, JSON.stringify({ content: PIC_BASE64 }))
  }
  if (url.endsWith('testmon/anim.asm')) return reply(200, ANIM)
  if (url.endsWith('testmon/normal.pal')) return reply(200, NORMAL)
  if (url.endsWith('testmon/shiny.pal')) return reply(200, SHINY)
  return reply(404, 'Not Found')
}

test('draws a fetched Pokémon above the prompt and animates it', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const fetched: string[] = []
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    return github(e.url)
  })
  const blits: string[] = []
  on('ui.blit', (_, e) => {
    blits.push(e.key)
    return { value: {} }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image', key: 'sprite' })
  expect(image?.props.rows).toBe(3)
  expect(image?.props.columns).toBe(6)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()

  // The egg folder is excluded, so only testmon's files are fetched.
  expect(fetched.some(url => url.includes('egg/'))).toBe(false)

  await clock.advance(10_000)
  expect(blits.length).toBeGreaterThan(0)
  expect(blits.every(key => key === 'sprite')).toBe(true)
  await ui.unmount()
})

test('falls back to a cached Pokémon when GitHub fails', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, {
    'pic:testmon': { png: PIC_BASE64, anim: ANIM, normal: NORMAL, shiny: SHINY },
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

test('a cached sprite list is used without a network call', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, {
    index: {
      fetchedAt: 0,
      entries: [{ name: 'testmon', anim: 'testmon/anim.asm', normal: 'testmon/normal.pal', shiny: 'testmon/shiny.pal' }],
    },
    'pic:testmon': { png: PIC_BASE64, anim: ANIM, normal: NORMAL, shiny: SHINY },
  })
  const fetched: string[] = []
  on('http.fetch', (_, e) => {
    fetched.push(e.url)
    return github(e.url)
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
