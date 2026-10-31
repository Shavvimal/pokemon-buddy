# Plan: the SpriteCollab source and the Sky buddy

Status: implemented on the `sky` branch, 2026-10-31 (0.4.0): steps 1 to 5 of
§9 are in `hooks/sky.tsx`, `hooks/codecs.ts` and `hooks/register.tsx`, with
the press button included (the author asked for it) and the cache limit per
style. The rest of this file is the plan as decided before coding; where the
code differs, the code wins.
Companion files: `spritecollab-format.md` (the data, verified) and
`sky-buddy-design.md` (the behaviour and drawing design). This file holds
the implementation strategy: the choices, why, the order, the risks.

## 1. Scope

Add a fourth source, PMDCollab/SpriteCollab, and an actor that walks the
band and acts with personality. The three Crystal-style sources keep the
current `Player` (one front-facing loop at the right end): they have no walk
cycle, and the actor engine does not apply to them.

**One plugin, two styles (decided 2026-10-31).** The user picks a style, not
a mix: a `style` setting in `plugin.json`'s `userConfig`, a string with
`options: ["sky", "crystal"]`, which `/config` draws as a select and
`claude plugin configure pokemon-buddy@pokemon-buddy` sets. `sky` is the
walker from SpriteCollab; `crystal` is today's behaviour, and the three
existing booleans (`crystal`, `polishedCrystal`, `prism`) apply under it
only. Default `sky` once it ships (a 0.4.0 CHANGELOG entry says so), with
`crystal` one setting away. A separate plugin was considered and rejected:
the two styles share the PNG decoder, inflate, HTTP client, cache, hooks,
tests, CI, hygiene scan and release flow, and a second repository would
carry all of that twice for one `if`.

## 2. Facts that shaped the strategy

From the verified data and the mod API types (`.claude-plugin/types/`):

1. `$.http.fetch` returns **text only**. A PNG through it is lossy. That is
   why the mod fetches binaries through the GitHub contents API (base64 JSON)
   today, at one API call per file against a budget of 60 an hour.
2. A Sky rig needs AnimData.xml plus, per clip, Anim and Offsets (and Shadow
   for the ground point): core (Idle, Walk, Sleep, Rotate) is 12 files; the
   whitelist of 18 clips is 54 files. The contents API cannot carry that.
3. The GraphQL server serves one **zip per sprite** (`zipUrl`, 264 KB for
   Pikachu, deflate), and `raw.githubusercontent.com` has no rate limit.
4. `$.process.run(argv)` runs a host command with a 4 MiB stdout cap, and
   `$.fs.read(path, { as: 'bytes' })` reads a file under 4 MiB as base64.
   The mod already carries an inflate; a zip reader on top is about 60
   lines (local file headers, deflate or stored, no zip64 needed).
5. `$.store` is one JSON file capped at **4 MiB in all**. A core rig is 45 KB
   of base64; the whitelist rig is 115 KB; the Crystal caches already use up
   to 60 × 25 KB. The cache must be budgeted in bytes, not count.
6. A redraw is capped at 10 a second (30 for an expanded band); a blit at
   120 taken, about 60 shown.
7. 963 species have the core; 203 have the FULL personality set as real art.
   `tracker.json` is 10.5 MB and stale; the GraphQL listing is 660 KB and
   current.

## 3. Fetch strategy: three options, one chosen

| | A. Contents API, trimmed | B. Zip through `curl` | C. Raw PNGs through `curl` |
| --- | --- | --- | --- |
| Requests per sprite | 1 + 12 (core) | 1 | 1 + 2 per clip |
| Rate limit | 60/h shared with the other sources: **two Sky sprites an hour** | none | none |
| Host dependency | none | `curl` on the host | `curl` on the host |
| New code | none | zip reader (~60 lines) | none |
| Extras (Sit, Eat, Pose…) | lazily, one API call every few minutes | all at once | lazily, no limit |
| Offline later | cache | cache | cache |

**Chosen: B, with A as the fallback.** One `curl` to a temp file, one
`$.fs.read` as bytes, one pass of the zip reader, then the same PNG decoder
the mod has. If `curl` is absent or fails (`exitCode ≠ 0`), fall back to A
for the core only, and log it. The host-command dependency is new for this
mod and is the one thing to call out in the README ("Sky buddies need
`curl`; without it the mod fetches only the core clips, slowly").

Why not C: it is B without the zip reader but with 36 to 54 `curl` calls,
each a `$.process.run` with a 30 s default timeout and a process spawn;
B is one.

Why not a shell pipe (`sh -c 'curl … | base64'`) into stdout: it works and
avoids the temp file, but it adds a shell to the path, and the repository's
hygiene rules prefer argv over shell strings.

Temp file: `$.process.run(['mktemp'])` gives a path; `curl -sfL <zipUrl> -o
<path>`; read; then `$.process.run(['rm', '-f', path])`. The path never
enters a tracked file or a log line.

Decoding cost: Idle 240×448 and the other kept sheets inflate to about 2 MB
of pixels per rig, done once per summon in the background, as now. Keep the
`for … of` pixel loops typed-array based, as the current decoders are.

## 4. Listing strategy

Once every `listMaxAgeMs` (7 days), POST the GraphQL listing query and keep:

```ts
type SkyEntry = {
  source: 'sky'
  species: string   // name
  form: string      // path, '' for base, '0006' for Libre
  dex: number
  phase: 'EXISTS' | 'FULL'
  hasShiny: boolean // a sub-form <form>/0001 with a phase
}
```

That is about 3200 rows, under 200 KB as JSON; store only base forms plus
named alternates (skip gender duplicates), which halves it. The `dedupe` by
`species/form` across sources then applies as today, with the Sky source
placed **first** in the source list when it is on, so a species that exists
in Crystal and in SpriteCollab is drawn from SpriteCollab.

Shiny: `CONFIG.shinyOdds` as today; the shiny path is `<form>/0001` and has
its own zip. Fall back to normal colours if the shiny zip fails, as `load`
does for the other sources.

Fallback when the GraphQL server is down: the stored list; if there is none,
the other sources; if those fail, `anySprite` from the cache.

## 5. Cache strategy

Replace `cacheLimit` (a count) with `cacheBytes` (default 2.5 MiB of base64
text across all sources) and evict oldest first, as `saveSprite` does now.
A Sky rig stores the raw PNG bytes of the kept clips (Anim, Offsets, Shadow
for the whitelist), not decoded pixels: 115 KB for a FULL species, 45 KB for
an EXISTS one. About 20 Sky rigs fit beside the Crystal cache. The decoded
rig lives in memory for the session only.

Store keys: `sprite:sky:<dex>/<form>` for the files, `list:sky` for the list,
`profile:sky:<dex>` is **not** stored (it is a pure function of the seed).

## 6. Code layout inside `hooks/register.tsx`

The mod's rule is one file, no dependencies. Sections to add, in the file's
existing order:

```
Zip reading       (after Inflate)        readZip(bytes) → Map<name, bytes>
XML reading       (with Sprite sources)  parseAnimData(text) → AnimMeta[]
Sheet decoding    (after Sprite shaping) sheetToClip(meta, anim, offsets, shadow)
Rig               (after Sprite shaping) anchor frames into one canvas
SpriteCollabSource (with Sprite sources) list via GraphQL, needs = zip, animate = rig
Actor             (after Playback)       facing, x, state, weights, drives, profile
Band render       (in Hooks)             absolute Box + keyed Image, blit vs invalidate
```

`parseAnimData` is a regex pass over the XML (the format is flat and
machine-written; no XML parser is needed), with `CopyOf` resolved to the
source clip's sheets and the copy marked so the repertoire excludes it.

The `SpriteSource` interface gains nothing: `list`, `needs`, `animate` stay,
but the Sky source's `animate` returns a `Rig`, not an `Animation`. Make
`summon` return a discriminated union (`{ kind: 'loop', sprite }` or
`{ kind: 'rig', rig }`) and let the hooks pick `Player` or `Actor`.

Line budget: the file is 1333 lines; this adds roughly 600 (zip 60, XML 40,
sheet and rig 150, source 80, actor 220, render 50). If it crosses 2000,
split the Sky parts into `hooks/sky.tsx` and import it, which the hooks
module allows (one entry, local imports), and update the "all the logic sits
in one file" line in the README.

## 7. Behaviour engine: implementation notes

See `sky-buddy-design.md` §4 for the design. Implementation choices:

- One `Actor` class with `tick()` driven by chained `$.clock.after`, like
  `Player.schedule`. The next wake-up is `min(frameDelay, dwellLeft,
  nextMoveStep)`.
- States as a small discriminated union, not classes per state: `{ kind:
  'walk', dir, until } | { kind: 'idle', loopsLeft } | { kind: 'act', clip,
  frame } | { kind: 'turn', frames: [row, index][], at } | { kind: 'sleep',
  until } | { kind: 'wake' }`.
- The weight table is a plain array of `{ next, weight, needs }`; the draw
  multiplies weights by drives, memory and profile, drops rows whose `needs`
  are not in the repertoire, then samples. Use the existing `randomInt` for
  run-time draws and a seeded `mulberry32` only for the profile.
- Session events reach the actor through a small `notify(event)` method:
  `on('prompt.submit', …)`, `on('turn.complete', …)`, `on('turn.abort', …)`
  observe and call it, always returning `next(e)`. Each registration gets
  `.catch` so a failed hook never blocks a prompt.
- Quiet-session sleep uses `$.clock.now()` at each render to track the last
  activity; the actor compares against it on its own ticks.

## 8. Rendering: implementation notes

See `sky-buddy-design.md` §5. Choices:

- The `Image` is `columns = rows × cellAspect + SLACK_COLUMNS` (3), canvas
  padded by three columns of pixels for sub-column shifts, so a walk
  re-renders once every three columns (0.4.2; it was `+ 1`). Default `rows` stays 3; at 3 rows
  the Pokémon is 6 columns wide and legible, and `rows: 4` is the knob for a
  larger pet.
- A column move is `$.ui.invalidate('ui.render')`; the render hook reads
  `actor.x` and `actor.source`. A frame or sub-column change is a blit on
  the same key.
- Resize: the render hook passes `e.props.bodyColumns` to the actor on every
  render; the actor clamps.
- Alt text: the species name (useful in a terminal without pictures, where
  the band shows the alt dim).

Measure first in Ghostty, kitty and iTerm2: a re-render at 4 a second with
one 93×80 image; blits at 10 a second. Then inside tmux with
`allow-passthrough`. If iTerm2 shows tearing on re-render, drop sub-column
smoothing and move by whole columns at 10 a second (the sprite is 6 columns
wide, so a column is a sixth of its width; at 3 columns a second that reads
as a brisk walk, not a stutter).

## 9. Delivery order

Each step ships behind the `style` setting (`crystal` stays the default
until step 5 flips it to `sky`) and keeps `make check` green.

1. **Source and listing.** `SpriteCollabSource.list` via GraphQL; `needs`
   returns the zip; `$.process.run` + `$.fs.read` + `readZip`; `parseAnimData`;
   decode Idle only; draw Idle row 0 at the right end through the existing
   `Player`. Tests: a hand-drawn 8-row sheet in a tiny stored zip.
   README: attribution, the `curl` note, the `style` setting. Version bump.
2. **Rig and anchoring.** Decode Walk, Sleep, Rotate and the whitelist;
   offsets and shadow anchors; one canvas; row selection. Test: ground pixel
   lands on the same canvas coordinate across clips.
3. **Actor, walk and turn.** `x`, edges, Rotate turns, idle ↔ walk, absolute
   placement, blit vs invalidate, seeded `pace` and `stride`. Try in three
   terminals and tmux; write the numbers into this file.
4. **Down-facing clips and sleep.** Turn-down, Sit/Eat/LookUp/…, Sleep →
   Wake, quiet-session sleep.
5. **Weights, drives, memory, profile, session reactions.** `style` default
   flips to `sky`. CHANGELOG, README "Sky buddies" section with the profile
   line.
6. **Polish.** Cache budgeting across sources and the Prism/Crystal
   `cacheLimit` migration to bytes. The press button stays parked (§11).

Estimates, if the fetch path works on the first try in step 1: steps 1–3 a
day, 4–5 a day, 6 half a day. Add half a day if `curl` is not acceptable and
option A has to carry the core with lazy extras.

## 10. Risks and their answers

| Risk | Answer |
| --- | --- |
| `curl` missing or blocked | fallback A (contents API, core only), logged once |
| GraphQL server down | stored list, else other sources, else cache |
| `$.store` 4 MiB cap hit by a user with all sources on | byte budget with eviction; Sky rigs store PNG bytes, not pixels |
| A species' sheets break an assumption (rows not 1 or 8, missing Shadow) | loader rejects the rig, `summon` falls back to the cache, log names the dex |
| Re-render tearing in one terminal | whole-column moves only; a `CONFIG.subColumn` switch |
| The band is collapsed or a survey is up | actor keeps time, blits nothing, as `Player` does |
| A weekly engine API change (mod API is early access) | CI pins the Claude Code version; types regenerate with `claude --plugin-dir .` |
| Licence | CC BY-NC, non-commercial mod, credit per sprite in the log and README; sprites never committed |

## 11. Decisions from the author (2026-10-31)

1. **`rows` stays 3**, as today: the Pokémon is 6 columns wide.
2. **Side view while walking**: rows Right (2) and Left (6). The band is a
   horizontal strip, so a side-on walk is the natural read; the 3/4 rows are
   not decoded.
3. **One plugin, a `style` select** (`sky` or `crystal`), not a mix and not
   a second plugin. See §1.
4. **Press button: parked.** Not in the first release; revisit after step 5
   if the band wants an interaction.
