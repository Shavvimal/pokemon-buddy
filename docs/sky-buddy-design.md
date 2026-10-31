# Sky buddy: a Pokémon with character in the band

Design for the fourth sprite source and the engine that gives it behaviour.
Data facts are in `spritecollab-format.md`; implementation strategy, options
and the delivery order are in `spritecollab-plan.md`. This file is the
design: what the Pokémon does, how clips stitch, how it chooses, how it is
drawn.

## 1. What it should feel like

One Pokémon lives in the band above the prompt. It walks the full width,
left and right, at its own pace. It stops, looks around, sits, eats, naps,
and notices the session: it watches while Claude works, perks up when a turn
ends, and falls asleep when nothing happens for a while. Two sessions with
the same species feel like the same character; two species feel different.
It never jitters, never snaps between poses, never faces the wrong way, and
never costs the terminal more than a few small image swaps a second.

What it must never do: play Hurt, Pain, Double, Swing, RearUp, Shoot, Hop,
Sink, Trip, LeapForth, Head, TumbleBack, HitGround or Faint (the author's
list; the last four imply injury). Allowed: Idle, Walk, Sleep, Rotate,
Charge, Attack, Wake, Eat, Tumble, Pose, Pull, Nod, Sit, LookUp, Laying,
Cringe, LostBalance, DeepBreath, EventSleep (as a Sleep variant), Float (as
an Idle variant for species whose Idle is a hover).

## 2. The rig: clips anchored on the ground

```ts
type Facing = 'right' | 'left' | 'down'
type Row = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

type Clip = {
  name: string
  rows: 1 | 8
  frameW: number
  frameH: number
  /** per frame: delay in ms (ticks × 1000/60) */
  delays: number[]
  /** per row, per frame: RGBA frameW×frameH */
  pixels: Uint8Array[][]
  /** per row, per frame: green pixel of Offsets.png, in frame coords */
  centre: { x: number; y: number }[][]
  /** per row, per frame: white pixel of Shadow.png, in frame coords */
  ground: { x: number; y: number }[][]
}

type Rig = {
  species: string
  form: string
  credit: string
  clips: Map<string, Clip>
  /** the fixed canvas every frame is painted into (section 2.2) */
  canvas: { w: number; h: number; groundX: number; groundY: number }
  /** which whitelisted clips are real (not CopyOf, not missing) */
  repertoire: Set<string>
}
```

### 2.1 Which rows to decode

Only rows 0 (Down), 2 (Right) and 6 (Left) are kept for 8-row clips; a
one-row clip keeps row 0. Decoding the whole sheet is unavoidable (PNG
rows are sequential), but the kept pixels are a third of it. The walk is
side-on (decided 2026-10-31): the band is a horizontal strip, so Right and
Left are the natural read, and the 3/4 rows (DownRight, DownLeft) are not
decoded. Up-facing rows are never used: a Pokémon showing its back to the
user looks lost.

### 2.2 Anchoring, so clips cut cleanly

Different clips have different frame sizes (Idle 40×56 vs Walk 32×40 for
Pikachu). `shapeSprite` today crops to the content box of one animation and
sits it on the bottom edge. That cannot work across clips: the content box
of Attack is twice Idle's, and sitting on the bottom edge makes a Pokémon
whose ground point moves between frames bob.

Instead, every frame is painted into one fixed canvas such that its ground
point lands on `(groundX, groundY)`:

```
canvas.w = max over kept frames of (frameW + |centre.x − ground.x| spread)
canvas.h = max over kept frames of (ground.y + (frameH − ground.y))
paint(frame) at (groundX − ground.x, groundY − ground.y)
```

In practice: compute, over every kept frame of every kept clip, the extents
relative to the ground point (`left = ground.x`, `right = frameW − ground.x`,
`up = ground.y`, `down = frameH − ground.y`), take the maxima, and that is the
canvas with `groundX = maxLeft`, `groundY = maxUp`. Attack's lunge widens the
canvas; that is fine, the canvas is square-padded and scaled to the same
cells anyway, and the pet spends 99 % of its time in Idle-sized frames. If
Attack and Charge make the canvas so large that Idle shrinks below legible,
drop them from the canvas calculation and clip them to it instead (they are
rare and brief).

After anchoring, the existing path applies unchanged: square up, `pixelScale`
upscale, merge identical consecutive frames, base64 once per frame.

Note the horizontal: use the **ground** point for x as well. The green centre
is the body's centre and drifts with the pose (a lunge moves it); the shadow
point is where the feet are, and feet are what must not slide.

## 3. Facing and stitching

The actor owns one `facing`. Every clip is drawn through `row(clip, facing)`:

```ts
function row(clip: Clip, facing: Facing): Row {
  if (clip.rows === 1) return 0
  return facing === 'right' ? 2 : facing === 'left' ? 6 : 0
}
```

Three rules make every cut look intended:

1. **Walk and Idle share facing.** Walking left is Walk row 6; stopping cuts
   to Idle row 6 on Idle's first frame. Because both are anchored on the
   ground point, the body does not move at the cut. Start Idle on its long
   first frame (40 ticks for Pikachu) so the stop reads as a pause before the
   fidget, not as a twitch.
2. **A one-row clip forces `down`.** Before Sleep, Sit, Eat, LookUp, Tumble,
   Cringe or LostBalance, the actor turns to face the viewer: Rotate through
   the front (from Right: row 2 frames 0..2; from Left: row 6 frames 8..6),
   then the clip. After it, Idle row 0 for one loop, then a turn to the next
   walking direction. Wake is 8-row, so the sleep sequence is
   `turn → Sleep(row 0) → Wake(row 0) → Idle(row 0) → turn → Walk`.
3. **A turn is a clip, never a flip.** Rotate row `d` frame `i` shows
   direction `(d − i) mod 8`. A half turn Right → Left through the front is
   row 2 frames 0, 1, 2, 3, 4 (Right, DownRight, Down, DownLeft, Left); Left
   → Right through the front is row 6 frames 8, 7, 6, 5, 4. Hold each frame
   50 to 80 ms (the sheet says 33 ms; that is a battle spin). Never mirror a
   row: tails, held items and asymmetric markings would flip, and the
   collection has a real Left row for every 8-row clip.

If a species has no Rotate (none of the 963 usable ones lacks it, but a
loader must not assume), the turn is Walk frame 0 of rows 2, 1, 0, 7, 6,
which is pixel-identical to Rotate for Pikachu and close for the rest.

Charge, Attack, Pose, Nod, Laying, Pull, DeepBreath and Wake are 8-row and
play in the current facing. Charge → Attack chains well; `RushFrame` and
`HitFrame` are not needed. Attack moves the body forward within its frame;
the ground anchor keeps the feet planted, and the lunge is the body leaning,
which is what the game shows too.

## 4. Behaviour: three layers

### 4.1 The state machine (what is legal)

```
                 ┌──────────── edge reached / change of mind ─────────┐
                 ▼                                                    │
  idle ──► turn ──► walk ──► idle                                     │
   │                                                                  │
   ├──► act(8-row clip) ──► idle          Pose Nod Charge Attack Pull  │
   │                                      DeepBreath Laying            │
   ├──► turn-down ──► act(1-row clip) ──► idle(row 0) ──► turn ──► walk
   │                                      Sit Eat LookUp Tumble        │
   │                                      Cringe LostBalance           │
   └──► turn-down ──► sleep ──► wake ──► idle(row 0) ──► turn ─────────┘
```

Each state has an exit condition: a clip ends (act, turn, wake), a dwell
timer ends (idle, sleep, sit held for N loops), an edge is reached (walk), or
a session event pre-empts (section 4.4). vscode-pets uses exactly this shape:
each state lists its possible next states and holds for a `holdTime`
(`src/panel/states.ts`, `basepettype.ts: chooseNextState`). SpriteWander,
which already wanders SpriteCollab sprites on a desktop, is the same again
with Idle → {Walk 50 %, Sleep 40 %, Pose 5 %, Eat 5 %} and a `TurnRandom`
that prefers small turns (`entity/Entity.cs`).

### 4.2 Constrained randomness (what is likely)

The 1997 Petz paper ("Catz: a user perception based approach") names the
balance: too much randomness reads as disconnected, too little as a robot.
The tools, each a few lines:

- **Dwell from ranges.** idle 2–9 s, walk 1–6 s or to an edge, sleep 20–90 s,
  sit 2–5 loops, laying 3–8 s. Sample uniformly inside the range; never a
  constant.
- **Weighted transitions from idle**, as integers summing to roughly 100:

  | Next | Weight | Needs |
  | --- | --- | --- |
  | walk | 40 | Walk |
  | idle again (one more loop) | 18 | — |
  | sit | 9 | Sit |
  | look up | 7 | LookUp |
  | nod | 5 | Nod |
  | pose | 4 | Pose |
  | eat | 4 | Eat |
  | deep breath | 3 | DeepBreath |
  | sleep | 3 | Sleep |
  | charge (→ attack 50 %) | 2 | Charge, Attack |
  | tumble | 2 | Tumble |
  | pull | 1 | Pull |
  | lost balance → cringe | 1 | LostBalance, Cringe |
  | laying | 1 | Laying |

  A row whose clip is not in `repertoire` is dropped before the draw (an
  EXISTS species gets walk, idle, sleep, charge, attack only), and the
  weights renormalise by themselves.
- **Short memory.** Keep the last three actions; an extra that is in memory
  has its weight halved, twice if it is the last one. No "sit, sit, sit".
- **Chains that foreshadow.** Sleep is reached through LookUp or DeepBreath
  first (yawn, then nap) with probability 0.7; Attack only follows Charge;
  Cringe only follows LostBalance or Tumble. A one-step lookahead table, not
  a planner.
- **Two drives**, numbers in 0..1, updated per tick:
  - `energy`: −0.004/s walking, −0.01/s acting, +0.02/s sleeping, +0.006/s
    sitting or laying. Sleep weight × `(1 − energy) × 3`; walk weight ×
    `(0.5 + energy)`.
  - `restlessness`: +0.03/s idle or sitting, reset to 0 on walk. Walk weight ×
    `(1 + restlessness)`.

  This is the whole "utility" system. It makes a pet that has just walked
  the band twice sit down, and one that has sat through a long turn get up.

### 4.3 Personality (why this one is different)

A profile per species, derived with a seeded PRNG (mulberry32 seeded by the
dex number, so the same species always gets the same character) and a few
rules from what the sprite has:

```ts
type Profile = {
  pace: number          // walk cycles per second multiplier, 0.7..1.4
  stride: number        // columns per walk cycle, 2..4 (bigger species: more)
  sleepiness: number    // 0.5..2  multiplies the sleep weight
  curiosity: number     // 0.5..2  LookUp, Nod, Pose
  temper: number        // 0..2    Charge, Attack (0 for a FULL species that
                        //         has gentler clips to use instead)
  attachment: number    // 0.3..1  how often it walks to the prompt end and
                        //         watches while Claude works
  restless: number      // 0.5..2  idle → walk
}
```

Rules on top of the seed: a species whose Sleep sheet is also its EventSleep
gets `sleepiness` nudged up; one with Float as Idle gets `pace` down and
`stride` up (it glides); a FULL species gets `temper` halved because it has
Pose and Nod to express itself. The profile is computed once at summon and
logged (`$.ui.log`) with the credit line, so a user can see "Snorlax:
sleepy 1.8, curious 0.6".

Do not fetch species data (height, base speed) for this. The seed and the
sprite are enough, and the mod's network contract stays small.

### 4.4 Noticing the session

The band's `ui.render` props carry `isWorking` (a model turn is running), and
the mod API offers `turn.start`, `turn.complete` (with `e.reason`),
`turn.abort`, `prompt.submit`, `tool.call` and `prompt.change`. Reactions,
each a weight nudge or a one-off pre-emption, never a hard script:

| Event | Reaction |
| --- | --- |
| `prompt.submit` | if asleep: Wake; else LookUp or Nod, then walk toward the prompt end (right) with probability `attachment` |
| `isWorking` true for > 8 s | `curiosity` × 2; prefer idle facing down at the right end ("watching") |
| `turn.complete`, reason normal, turn > 30 s | Pose (FULL) or Nod, once |
| `turn.abort` / `tool.call` denied | Cringe (FULL) or LostBalance; else Idle |
| no render for 10 min | sleep, through the yawn chain |
| `prompt.change` after a long quiet | Wake if asleep |
| `session.compact` | Tumble (FULL) once; then idle |

The pi-tools `pokemon-buddy` extension maps agent events to moods the same
way (`working → Attack/Walk`, `happy → Hop`, `sad → Pain/Hurt`,
`confused → Idle`); this design keeps the mapping but swaps every injury clip
for a gentler one, per the whitelist.

Reactions pre-empt the current state only at a clean cut: a walking Pokémon
finishes its step to a frame 0 (feet together) before turning; an acting
one finishes the clip. Sleep is the exception: Wake can interrupt it at any
frame.

### 4.5 A tiny optional interaction

The `Image` is a leaf with no `onPress`, but a `Button` beside it (the
species name, dim) raises `ui.press`. Pressing it could play Pose or Nod.
Parked (2026-10-31): not in the first release. If it comes back, it stays
off by default behind a config switch so the band stays quiet.

## 5. Drawing: walking the width of the band

### 5.1 Geometry

`e.props.bodyColumns` is the band's width in cells. The sprite is
`CONFIG.rows` tall and `rows × cellAspect` wide. `rows` stays 3 (decided
2026-10-31), so the sprite is 6 columns wide, as today.
Position is a column `x` in `[0, bodyColumns − spriteColumns]`, plus a
sub-column pixel offset.

### 5.2 Two update paths with very different costs

- **Frame swap**: `$.ui.blit` on the keyed `Image`. Folded to the frame rate,
  120 taken and about 60 shown per second. One small command per swap.
- **Move by a column**: a re-render. `$.ui.invalidate('ui.render')` is capped
  at 10 a second (30 for an expanded band). Each re-render re-emits the tree,
  the `Image` included.

So: the walk moves by whole columns through re-render at most 10 times a
second, and everything else (frames, sub-column shifts) through blit.

### 5.3 Sub-column smoothing

Pad the sprite canvas by one column's worth of pixels (`canvasPx / columns`
per column: for an 80 px canvas in 6 columns, 13 px). The sprite is painted
at pixel offset `fx` in `[0, 13)` inside the padded canvas; the `Image` is
one column wider. Position = `x` columns + `fx` pixels. A move advances `fx`;
when it wraps, `x += 1` and the band re-renders. At 4 columns a second that
is 4 re-renders and about 50 blits a second, both inside the limits, and the
motion is pixel-smooth.

Layout: `<Box width="100%"><Box position="absolute" left={x}><Image
key="sprite" columns={spriteColumns + 1} rows={rows} … /></Box></Box>`.
`position: "absolute"` with `left` is in the Box props; a move "moves nothing"
else in the tree. (`marginLeft` works too; absolute is cleaner.)

### 5.4 Pace without foot-sliding

Distance per walk cycle is fixed at `profile.stride` columns (the sprite's
own stride, about 0.6 of its width); personality changes how fast the cycle
plays (`profile.pace` scales the Walk delays), not how far a cycle carries.
That is the standard fix for sliding feet: speed and animation rate move
together.

Walk delays are 8/10/8/10 ticks for Pikachu (0.6 s a cycle). At pace 1 and
stride 3 columns, the band's 74 free columns take 15 s to cross. Right.

### 5.5 Edges, resize, collapse

- At an edge, finish the step, then `turn` (section 3), then walk back. With
  probability 0.3 the Pokémon turns before reaching an edge (change of mind),
  never twice within 3 s.
- On a `bodyColumns` change, clamp `x`; if the sprite would overlap the
  engine's `[-]` mark, step left.
- When `hasSurvey` is true the hook passes (as today); the actor keeps time
  but blits nothing, like `Player` does when the band is not drawn.
- `isWorking` does not pause the pet; the pet watches (section 4.4).

### 5.6 Rendering budget

| Thing | Rate | Bytes |
| --- | --- | --- |
| Frame or sub-column blit | ≤ 60/s shown, usually 2–10/s | 93×80 RGBA = 30 KB raw, 40 KB base64 |
| Column re-render | ≤ 10/s, usually ≤ 4/s | the band tree + one image |
| Band-wide image (rejected) | would be 10/s | 1067×80 RGBA = 340 KB raw per frame |

The rejected option is the one to avoid: one wide image blitted every frame
would push 3 to 4 MB/s of base64 through the engine and tmux.

## 6. Timing

One driver: `$.clock.after` chained, as `Player` does today, with the next
delay taken from the current clip's frame or the actor's dwell timer,
whichever is sooner. No `$.clock.every` at 60 Hz: an idle Pokémon on its
40-tick first frame should cost one timer in 0.67 s, not 40.

Ticks to ms: `delayMs = ticks * 1000 / 60`, then `/ profile.pace` for Walk
only. Merge identical consecutive frames as `shapeSprite` does (Sleep's two
frames stay two).

## 7. Testing the engine without a terminal

The existing tests mock the clock, store and network and assert what is
drawn. Add, with a hand-drawn 2-frame, 8-row 8×8 sheet and a 1-row sheet
drawn for the tests (no game art):

- row selection by facing, including the 1-row override;
- anchoring: two clips with different frame sizes and ground points paint
  the ground pixel at the same canvas coordinate;
- the turn sequence from Right and from Left yields the expected row and
  frame indices;
- a one-row clip is always entered facing down and left facing down;
- weights drop clips outside the repertoire and renormalise;
- the seeded profile is deterministic for a dex number;
- the walk reaches the right edge, turns, and reaches the left edge, with
  `x` never outside `[0, bodyColumns − columns]`;
- a `prompt.submit` while asleep produces Wake, not a cut to Idle;
- the memory rule: the same extra is not drawn three times running over a
  long seeded run (statistical, seeded).

## Sources

- vscode-pets state machine: https://github.com/tonybaloney/vscode-pets
  (`src/panel/states.ts`, `src/panel/basepettype.ts`)
- SpriteWander, a SpriteCollab desktop wanderer in C#:
  https://github.com/zerustu/SpriteWander (`SpriteWander/entity/Entity.cs`)
- deskimon, a Tauri desktop pet on SpriteCollab sheets:
  https://github.com/verdoxOP/deskimon (`src/sprites.ts`, `src/main.ts`)
- pi-tools `pokemon-buddy` extension (moods from agent events, same API):
  https://github.com/Nachompiras/pi-tools (`extensions/pokemon-buddy/index.ts`)
- Shimeji-EE behaviour XML (weighted `Frequency`, `Condition`,
  `NextBehaviorList`): https://github.com/LavenderSnek/ShimejiEE-cross-platform
  (`ext-resources/conf/behaviors.xml`)
- Petz, "constrained randomness":
  https://alumni.media.mit.edu/~benres/verbiage/Catz%20A%20User%20Perception%20Based%20Approach.htm
- Weighted idle machine example:
  https://python-statemachine.readthedocs.io/en/stable/auto_examples/weighted_idle_machine.html
- Claude Code mod API: `.claude-plugin/types/claude-code/index.d.ts` as
  written by Claude Code 2.1.314 (`BoxProps`, `ImageProps`, `ImageSource`,
  `$.ui.blit`, `$.ui.invalidate`, `AbovePrompt` props, `HttpResponse`,
  `$.process.run`, `$.fs.read`, `$.store`).
