# SpriteCollab: the data, verified

Reference for the PMD Sky style sprites at
[PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab). Every
statement below was checked on 2026-10-31 against the repository, the
official sprite guide, SpriteBot's source, the GraphQL server, and Pikachu's
(`0025`) files decoded by hand. Where a number is Pikachu's, it says so.

## Licence and credit

- The repository is **CC BY-NC 4.0** (`LICENSE.md`). The README's submission
  policy: anyone may copy, remix and redistribute for non-commercial use with
  credit.
- Credit is per sprite: `sprite/<dex>/credits.txt` (one line per
  contribution: date, author id, `CUR`/`OLD`, licence, actions), and
  `credit_names.txt` at the root maps author ids to display names. The
  GraphQL API returns `creditPrimary { id name }` per form, which is simpler.
- Chunsoft's original Explorers of Sky sprites are in the collection too
  (author `CHUNSOFT`): those stay the property of Spike Chunsoft, Nintendo
  and The Pokémon Company, as the Crystal sprites do for this mod.
- This mod's "no game assets" rule holds: fetch at run time, commit nothing.
  Attribution goes in `README.md` and `NOTICE.md` like the other sources.

## Repository layout

```
sprite/<dex>/AnimData.xml           one XML per form folder
sprite/<dex>/<Action>-Anim.png      the frames
sprite/<dex>/<Action>-Offsets.png   body-part anchors, same size as Anim
sprite/<dex>/<Action>-Shadow.png    shadow anchors, same size as Anim
sprite/<dex>/credits.txt
sprite/<dex>/<form>/…               alternate forms (0025/0006 = Libre)
sprite/<dex>/<form>/0001/…          shiny of that form (0025/0000/0001)
sprite/<dex>/<form>/<shiny>/<g>/…   gender variant one level deeper
```

`<dex>` is four digits (`0025`). The base form's files sit directly in the
species folder; its own "form 0000" has no folder of its own, only its
shiny/gender sub-folders. The repo-level `tracker.json` (10.5 MB) mirrors
this tree with status fields; do not fetch it at run time.

## AnimData.xml

One `<Anim>` per action, under `<AnimData><Anims>`, plus a `<ShadowSize>`
(0 small, 1 normal, 2 large). Per `<Anim>` (from the official guide):

| Tag | Meaning |
| --- | --- |
| `Name` | the action name; unique; from the fixed action list |
| `Index` | SkyTemple's internal slot; ignore |
| `CopyOf` | this action reuses another action's three PNGs; no chaining; none of the tags below may appear with it |
| `FrameWidth`, `FrameHeight` | frame size in pixels, even numbers |
| `Durations` / `Duration` | one per frame, **in 60 fps ticks** (1 unit = 1/60 s = 16.67 ms) |
| `RushFrame`, `HitFrame`, `ReturnFrame` | attack phase markers; a pet does not need them |

The 60 fps convention matches this mod's `CONFIG.stripFrameMs`
(`7 * (1000 / 60)`). Beware: at least one downstream project
(`lxsmnsyc/overwander`) plays sheets at 24 fps; that is its own choice, not
the format's.

Pikachu's actions (`0025/AnimData.xml`, 35 anims, no `CopyOf`):

| Action | Frame | Frames | Ticks per loop | Seconds | Rows |
| --- | --- | --- | --- | --- | --- |
| Walk | 32×40 | 4 | 36 | 0.60 | 8 |
| Idle | 40×56 | 6 | 53 | 0.88 | 8 |
| Sleep | 32×40 | 2 | 65 | 1.08 | **1** |
| Rotate | 32×40 | 9 | 18 | 0.30 | 8 |
| Charge | 40×40 | 10 | 20 | 0.33 | 8 |
| Attack | 80×80 | 10 | 21 | 0.35 | 8 |
| Wake | 40×40 | 5 | 42 | 0.70 | 8 |
| Pose | 32×40 | 3 | 22 | 0.37 | 8 |
| Nod | 32×48 | 3 | 20 | 0.33 | 8 |
| Laying | 24×32 | 1 | 12 | 0.20 | 8 |
| Pull | 32×40 | 7 | 76 | 1.27 | 8 |
| DeepBreath | 24×48 | 9 | 62 | 1.03 | 8 |
| Eat | 24×48 | 4 | 28 | 0.47 | **1** |
| Sit | 32×40 | 3 | 24 | 0.40 | **1** |
| LookUp | 32×40 | 3 | 18 | 0.30 | **1** |
| Tumble | 24×40 | 8 | 24 | 0.40 | **1** |
| Cringe | 24×64 | 2 | 10 | 0.17 | **1** |
| LostBalance | 32×40 | 2 | 16 | 0.27 | **1** |
| Hop | 40×88 | 10 | 24 | 0.40 | 8 |
| Hurt | 48×64 | 2 | 10 | 0.17 | 8 |

Rows were read off the PNG sizes (height / FrameHeight). The row count is
not in the XML: a loader must divide the sheet height by `FrameHeight`, and
`deskimon` learned that the hard way ("hardcoding 8 made the background math
read past the real image"). Idle at 40×56 is taller than Walk at 32×40
because of the ear flick; this is why frames must be anchored, not just
cropped (see Offsets).

## Sheet geometry

- `width = frames × FrameWidth`, `height = rows × FrameHeight`.
- `rows` is 8 or 1. SpriteBot's verifier refuses anything else.
- Frames run left to right in play order. Rows are directions, in this fixed
  order (SpriteBot `Constants.DIRECTIONS`, confirmed by eye on
  `Walk-Anim.png`):

```
row 0 Down        (faces the viewer)
row 1 DownRight
row 2 Right
row 3 UpRight
row 4 Up          (back to the viewer)
row 5 UpLeft
row 6 Left
row 7 DownLeft
```

- A one-row sheet is drawn facing **Down**. Sleep, Sit, Eat, LookUp, Tumble,
  Cringe and LostBalance are one-row for Pikachu and, by convention, for most
  sprites. A loader must handle both, per action, from the sheet size.
- Frames contain transparent padding; the "same size as Anim" rule exists so
  Offsets and Shadow overlay pixel for pixel.

## Rotate, decoded

`Rotate` is nine frames per row. Comparing each frame with `Walk` frame 0 of
every direction (pixel-exact match) gives:

```
row d, frame i  shows direction  (d − i) mod 8;   frame 8 == frame 0
```

So from `Right` (row 2): Right, DownRight, Down, DownLeft, Left, UpLeft, Up,
UpRight, Right. The spin goes Down → DownLeft → Left → … (anticlockwise as
seen from above). Two consequences for the engine:

1. **A turn-around clip exists for every species that has Walk**, because
   Rotate frames are exactly Walk frame 0 of each direction. If Rotate is
   missing, synthesise the same turn from Walk frame 0 of the intermediate
   rows.
2. **Turning through the front** (passing Down, so the viewer sees the face):
   from Right, play row 2 frames 0..4; from Left, play row 6 frames 8..4
   backwards (Left, DownLeft, Down, DownRight, Right). Turning through the
   back is the other half. Each frame is 2 ticks (33 ms); five frames is a
   170 ms turn, which reads as a snap; hold each frame 2 to 3 times longer
   for a deliberate turn.

## Offsets.png and Shadow.png

From the official guide, matching SpriteBot's `getOffsetFromRGB`:

| Sheet | Pixel | Meaning |
| --- | --- | --- |
| Offsets | green | centre of the body |
| Offsets | black | head (used for status icons); absent → centre |
| Offsets | red | the entity's left hand |
| Offsets | blue | the entity's right hand |
| Shadow | white | centre of the sprite on the ground (where the shadow goes) |
| Shadow | green / red / blue component | area of a small / normal / large shadow |

Overlapping markers combine their colours (a white pixel in Offsets is
centre + head + both hands at one point). Each frame has exactly one of each
marker; SpriteBot rejects duplicates.

The engine needs two anchors per frame: **centre** (green, Offsets) and
**ground** (white, Shadow). Aligning every frame of every action on its
ground point, with the centre as the horizontal reference, is what makes an
Idle → Walk → Sit → Idle sequence hold still instead of hopping by the
difference in frame sizes.

## Coverage, from the GraphQL server (2026-10-31)

| Measure | Count |
| --- | --- |
| Species (monsters) | 1026 |
| Forms in all (base, alternates, shinies, genders) | 4460 |
| Forms with a sprite: phase EXISTS | 2548 |
| Forms with a sprite: phase FULL | 689 |
| Species whose **base** form is EXISTS | 760 |
| Species whose **base** form is FULL | 203 |

Phases (`sprite_config.json`, `completion_actions`):

- **INCOMPLETE**: at most Idle. Do not use.
- **EXISTS**: Idle, Walk, Sleep, Hurt, Attack, Charge, Swing, Double, Rotate,
  Hop (and usually Shoot, Strike). All 963 usable species have Idle, Walk,
  Sleep and Rotate.
- **FULL**: EXISTS plus EventSleep, Wake, Eat, Tumble, Pose, Pull, Pain,
  Float, DeepBreath, Nod, Sit, LookUp, Sink, Trip, Laying, LeapForth, Head,
  Cringe, LostBalance, TumbleBack, HitGround, Faint. Checked on Gengar,
  Eevee, Umbreon and Lucario: 36 anims each, 1 to 2 `CopyOf` (Lick, Appeal,
  Emit, SpAttack), so the personality clips are real art, not aliases.
  (`tracker.json`'s `sprite_files` flags are stale for most FULL entries;
  trust the XML, not the tracker.)

Shiny forms exist as sub-forms (`0025/0000/0001` is FULL, credited to a
different artist). Many alternate forms (Pikachu's caps) are INCOMPLETE.

## The GraphQL API

`https://spriteserver.pmdcollab.org/graphql`, POST JSON `{ query }`. Source:
[PMDCollab/spritecollab-srv](https://github.com/PMDCollab/spritecollab-srv)
(Rust). Root fields: `monster(filter: [Int])`, `searchMonster(monsterName)`,
`credit`, `searchCredit(query)`, `config`, `meta`.

Listing query (660 KB for all 1026 species with every form's phase; keep
only what the mod needs):

```graphql
{ monster { id name forms { path isShiny isFemale sprites { phase } } } }
```

Per-sprite query:

```graphql
{ monster(filter: [25]) { id name forms { path fullPath fullName isShiny
    sprites { phase animDataXml zipUrl creditPrimary { id name }
      actions { ... on Sprite { action animUrl offsetsUrl shadowsUrl locked }
                ... on CopyOf { action copyOf } } } } } }
```

`animUrl` and friends point at `raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite/<path>/<Action>-Anim.png`,
`animDataXml` at the XML, `zipUrl` at
`https://spriteserver.pmdcollab.org/assets/<dex>/sprites.zip`. The zip for
Pikachu is 264 KB, 106 entries, all deflate (method 8). A HEAD on it answers
404; GET works. `raw.githubusercontent.com` answers with `cache-control:
max-age=300` and no rate-limit headers; the GitHub REST API (which this mod
uses for binaries today) allows 60 unauthenticated calls an hour.

## Sizes that matter (Pikachu)

| Set | Files | PNG bytes | base64 text |
| --- | --- | --- | --- |
| Core: Idle, Walk, Sleep, Rotate (Anim + Offsets) | 8 | 33 KB | 45 KB |
| Whitelist of 18 actions (Anim + Offsets) | 36 | 86 KB | 115 KB |
| Whole zip (35 actions × 3 sheets) | 106 | 264 KB | 353 KB |

Decoded, the Idle sheet is 240×448 RGBA = 430 KB in memory; the engine keeps
only the rows it uses (Down, Right, Left) after decoding.

## Sources

- Repository, README and licence: https://github.com/PMDCollab/SpriteCollab
- Official sprite guide (format, offsets, 60 fps durations):
  https://docs.google.com/document/d/1EceEEjyeoFwoKXdNj4vpXdoYRWp8CID64e-ZqY954_Q
- SpriteBot (`Constants.DIRECTIONS`, `SpriteUtils.py`, `utils.py`):
  https://github.com/PMDCollab/SpriteBot
- GraphQL server: https://github.com/PMDCollab/spritecollab-srv, live at
  https://spriteserver.pmdcollab.org/graphql
- Official viewer: https://sprites.pmdcollab.org
