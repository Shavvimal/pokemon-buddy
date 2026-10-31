# Pokémon Buddy

[![ci](https://github.com/Shavvimal/pokemon-buddy/actions/workflows/ci.yml/badge.svg)](https://github.com/Shavvimal/pokemon-buddy/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/Shavvimal/pokemon-buddy)](https://github.com/Shavvimal/pokemon-buddy/releases)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

<p align="center">
  <img src="docs/header-sky.gif?v=2" alt="A Claude Code session in a terminal. In the row above the prompt an animated Pikachu walks from left to right, turns around, walks back, looks up, sits down, falls asleep, wakes, strikes a pose and walks off again" width="960">
</p>

A little desktop pet for your terminal. Pokémon Buddy gives every
[Claude Code](https://claude.com/claude-code) session one random Pokémon
that lives in the row above your prompt: it wanders the full width of the
row, turns at the edges, stops to look around, sits down, eats, naps, and
plays around to entertain you while you code. It notices you too: it wakes
when you type, watches while Claude works, and poses when a long turn ends
well. Each species has a character of its own.

You pick one of two styles in `/config`:

- **Sky** (the default): a Pokémon Mystery Dungeon: Explorers of Sky style
  sprite from [PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab)
  that walks the full width of the row, turns at the edges, stops to look
  around, sits, eats, naps, and notices what you and Claude are doing. 963
  species have the walk, idle, sleep and turn clips; 203 have the whole
  repertoire. It has a character of its own, seeded by its species, so Snorlax
  is always sleepier than Pikachu. See [How the buddy behaves](#how-the-buddy-behaves).
- **Crystal**: a Game Boy Color style sprite at the right end of the row, as
  the mod drew it before 0.4.0, from three public sources gathered into one
  Pokédex (about 480 sprites across about 380 species):

  | Source | What it adds | Sprites kept |
  | --- | --- | --- |
  | [Pokémon Crystal](https://github.com/PokeAPI/sprites), from PokeAPI | The original animated sprites, #1 to #251, and the 26 Unown letters | 277 |
  | [Polished Crystal](https://github.com/Rangi42/polishedcrystal) | Later relatives (Sylveon, Annihilape, Dudunsparce…) and regional forms, in Crystal's own format | about 117 |
  | [Pokémon Prism](https://github.com/bottlebrushes/pokemon-prism-assets), from a third-party archive | Gen 3 and 4 Pokémon (Gardevoir, Lucario, Garchomp, Rayquaza…) | about 89 |

  Where two sources have the same species and form, the earlier source in the
  table wins. You can turn each source off (see [Sources](#sources)).

About one session in 512 gets a shiny, in either style.

**The mod ships no sprites.** It fetches each one from its public source
when a session starts. The two exceptions in this repository are the header
animation above and the plugin icon, which each show one sprite to
illustrate the mod. See [Attribution](#attribution).

## Install

At the prompt of a Claude Code session in your terminal, type:

```
/plugin install pokemon-buddy --marketplace Shavvimal/pokemon-buddy
```

Answer `y` to add the marketplace, then choose a scope. The user scope gives
every session a buddy. The mod runs from the next session you start.

From a shell, the same install is:

```bash
claude plugin marketplace add Shavvimal/pokemon-buddy
claude plugin install pokemon-buddy@pokemon-buddy
```

## Requirements

- Claude Code with mod (hooks module) support. CI tests against the version
  in `.github/workflows/ci.yml` (2.1.314 now). The mod API is early access and
  can change between Claude Code releases.
- A terminal that can draw pictures: [Ghostty](https://ghostty.org),
  [kitty](https://sw.kovidgoyal.net/kitty/), or iTerm2 3.5 or later. In other
  terminals, the row stays empty.
- Inside tmux, turn on `allow-passthrough` and `focus-events`.
- For the Sky style: `curl` on your machine (macOS and most Linux have it),
  and network access to `spriteserver.pmdcollab.org`. Without `curl` the mod
  fetches only the four core clips of each Sky sprite, through GitHub's API,
  slowly.
- For the Crystal style: network access to `api.github.com`,
  `raw.githubusercontent.com` and `pokeapi.co` for the first sessions.
- After the first sessions, cached Pokémon work offline in either style.

## Style and sources

The `style` setting picks the buddy, in the `/config` menu or with
`claude plugin configure pokemon-buddy@pokemon-buddy`:

| `style` | What you get |
| --- | --- |
| `sky` (default) | A Mystery Dungeon style Pokémon that walks the row and acts with character |
| `crystal` | A Game Boy Color style sprite at the right end, from the sources below |

Under `crystal`, each source is a setting of its own, on by default:

| Setting | Source |
| --- | --- |
| `crystal` | Pokémon Crystal sprites from PokeAPI |
| `polishedCrystal` | Polished Crystal sprites |
| `prism` | Pokémon Prism sprites from the third-party archive |

**A note on Prism.** The Prism sprites come from
[bottlebrushes/pokemon-prism-assets](https://github.com/bottlebrushes/pokemon-prism-assets),
an unofficial archive of graphics extracted from Pokémon Prism. The Prism team
(Koolboyman and RainbowDevs) did not publish that archive, and it has no
licence. The source is on by default. If you would rather not use it, set
`prism` to off.

## How it works

1. When a session starts, the mod reads the sprite list of your style's
   source or sources. It keeps each list for 7 days. The Sky list comes from
   SpriteCollab's GraphQL server; the Crystal lists from GitHub and PokeAPI.
2. It keeps one sprite per species and form, and picks a species at random,
   then one of its forms. A species with many forms (Unown, Magikarp) is no
   likelier than any other.
3. It fetches that sprite's files and caches them in the plugin's store. A
   Sky sprite is one zip from the sprite server, fetched by `curl` because
   the mod runtime's own fetch returns text; the mod reads the zip with a
   reader of its own.
4. It decodes them into frames:
   - **Sky:** `AnimData.xml` and one sheet per action (Idle, Walk, Sleep,
     Rotate, Wake, Charge, Attack, Pose, Nod, Sit, LookUp, Eat, Laying, Pull,
     DeepBreath, Tumble, Cringe, LostBalance, Float), eight direction rows
     each, with the frame's centre and ground markers read from the Offsets
     and Shadow sheets.
   - **Crystal:** a GIF.
   - **Polished Crystal:** a 4-shade PNG strip, coloured with its palette and
     played by its frame script, as the game does.
   - **Prism:** a coloured PNG strip, played in order.
5. It draws the sprite as a terminal image and swaps frames at the sprite's
   own speed (SpriteCollab's durations are 60 fps ticks, Crystal's are the
   game's). A Crystal sprite rests between loops at the right end; a Sky
   buddy is run by the actor described below.

The fetch runs in the background, so a session never waits on the network.
If a source cannot be reached, or GitHub rate-limits the request, the mod
uses the other sources, and then its cache.

## How the buddy behaves

The Sky buddy is a small desktop pet in the tradition of
[Shimeji](https://github.com/LavenderSnek/ShimejiEE-cross-platform), the
wandering mascots whose behaviour files are weighted lists of what to do
next, and of the Pokémon's own idle habits in Explorers of Sky. Its engine
lives in [`hooks/sky.tsx`](hooks/sky.tsx) and does four things.

**It stitches clips so nothing jumps.** Every SpriteCollab sheet marks, per
frame, where the body's centre is and where the feet touch the ground.
The mod anchors every frame of every clip on that ground point inside one
fixed box, so a 40×56 Idle frame cuts to a 32×40 Walk frame and a 24×48 Eat
frame without the Pokémon hopping. Attack, whose lunge is twice the size, is
clipped to the box rather than shrinking everything else.

**It always faces the right way.** Walk, Idle, Pose, Nod and the rest have
eight direction rows; the buddy walks side-on (the Right and Left rows) and
never mirrors a frame, because tails and held items are drawn on one side.
Sleep, Sit, Eat, LookUp, Tumble, Cringe and LostBalance exist in one row
only, facing you, so before any of them the buddy turns to face the front,
and turns back afterwards. The turn is a real clip: SpriteCollab's Rotate
sheet holds a full spin per starting direction (row *d*, frame *i* shows
direction *d − i* mod 8), and the mod plays the frames that pass through
the front, held a little longer than the battle spin. A sprite without
Rotate turns through Walk's standing frames of the quarter directions
instead.

**It chooses with constrained randomness.** A 1997 paper on Petz put it
plainly: too much randomness reads as disconnected, too little as a robot.
So the buddy picks its next act from a weighted table (walk 40, idle again
18, sit 9, look up 7, nod 5, pose 4, eat 4, deep breath 3, sleep 3, float 2,
charge 2, tumble 2, pull 1, lose balance 1, lie down 1) that only lists
clips the sprite really has; holds each act for a random span inside a
range; keeps a memory of its last three acts and halves the odds of a
repeat; chains the things that belong together (a look up or a deep breath
before a nap, a charge before an attack, a stumble before a cringe); and
drifts two drives, energy and restlessness, that make a buddy that has
walked the row twice sit down and one that has sat through a long turn get
up. It never plays Hurt, Pain, Hop, Shoot, Trip, Sink or any clip that
implies injury.

**It has a character and it notices you.** Each species gets a profile from
a seeded generator (pace, stride, sleepiness, curiosity, temper, attachment,
restlessness), so the same species behaves the same way every session and
two species feel different. While Claude works, a buddy with high
attachment walks to the prompt end and watches. When you submit a prompt, a
sleeping buddy wakes (with the Wake clip) and an awake one looks up or
nods. A long turn that ends well earns a pose; a turn that errors or is
interrupted earns a cringe. Ten quiet minutes make it sleepy. The dim ✦
under the sprite is a button: press it for a pose.

The band moves the sprite by whole columns through a redraw (ten a second
at most) and everything finer, frames and sub-column shifts, through an
in-place image swap, so a walking buddy costs the terminal a few small image
writes a second. The design record is in
[`docs/sky-buddy-design.md`](docs/sky-buddy-design.md), the sheet format in
[`docs/spritecollab-format.md`](docs/spritecollab-format.md), and the
decisions in [`docs/spritecollab-plan.md`](docs/spritecollab-plan.md).

The code is three files with no dependencies:
[`hooks/register.tsx`](hooks/register.tsx) (sources, Pokédex, cache, the
Crystal player and the hooks), [`hooks/sky.tsx`](hooks/sky.tsx) (sheets,
rig, painting, the actor) and [`hooks/codecs.ts`](hooks/codecs.ts) (base64,
inflate, zip, PNG and GIF, because the mod runtime has none of them). Each
source is a small strategy object behind one `SpriteSource` interface, and a
`Pokedex` composes the sources with an HTTP client and a cache. To add a
source, write one more strategy.

## Configuration

Edit `CONFIG` at the top of `hooks/register.tsx`:

| Key | Default | What it does |
| --- | --- | --- |
| `rows` | `3` | Sprite height in terminal rows. Use `6` to see every pixel. |
| `cellAspect` | `2` | Cell height divided by cell width. Keeps the sprite square. |
| `pixelScale` | `2` | Nearest-neighbour upscale, so pixels stay sharp. |
| `loopPauseMs` | `3000` | Rest between animation loops. `0` loops without a break. |
| `stripFrameMs` | about 117 | Time per frame for Prism strips, which have no timings of their own. |
| `shinyOdds` | `512` | One session in this many gets the shiny colours. `0` turns shinies off. |
| `cacheLimit` | `{ crystal: 40, sky: 12 }` | Sprites kept for offline sessions: Crystal-style ones are 2 to 25 KB, Sky rigs 45 to 130 KB, and the store holds 4 MiB. |
| `petButton` | `true` | Draws a dim ✦ under the buddy as a button; pressing it gets a pose. |
| `downloadTimeoutMs` | `25000` | How long `curl` may take to fetch one Sky sprite zip. |
| `listMaxAgeMs` | 7 days | How long each source's list is kept before it is fetched again. |
| `exclude` | `['egg']` | Polished Crystal folders left out of the draw. |

## Network and privacy

| Request | When |
| --- | --- |
| `POST spriteserver.pmdcollab.org/graphql` | Once every 7 days, for the Sky list (Sky style) |
| `curl spriteserver.pmdcollab.org/assets/…/sprites.zip` | Once per Sky sprite not yet cached, about 250 KB (Sky style) |
| `GET api.github.com/repos/…/git/trees/…` | Once every 7 days per GitHub-listed source (Crystal, Polished Crystal) |
| `GET pokeapi.co/api/v2/pokemon-species` | Once every 7 days, for the names of #1 to #251 |
| `GET raw.githubusercontent.com/bottlebrushes/pokemon-prism-assets/main/manifest.json` | Once every 7 days, for the Prism list |
| `GET api.github.com/repos/…/contents/…` | Once per sprite image not yet cached |
| `GET raw.githubusercontent.com/Rangi42/polishedcrystal/…` | Up to 2 small text files per Polished Crystal sprite not yet cached |

The requests carry no token and no data about you, only a `User-Agent` that
names this mod. GitHub allows 60 unauthenticated API requests an hour. A
session uses at most 3.

## Development

```bash
make check   # hygiene scan, plugin validation, engine tests, type check
```

`make check` runs:

| Step | Command |
| --- | --- |
| Public hygiene | `node scripts/check-hygiene.mjs` |
| Manifest and hooks module | `claude plugin validate . --profile directory` |
| Engine tests | `claude plugin test .` |
| Type check | `tsc -p tsconfig.json`, once Claude Code has written `.claude-plugin/types/` (run `claude --plugin-dir .` once) |

CI runs the first three on every pull request, and `main` takes changes only
through squash-merged pull requests with green checks. A change under `hooks/`
or `.claude-plugin/` must raise the version in `.claude-plugin/plugin.json`
and add a `CHANGELOG.md` section. The release workflow then tags it and
publishes a GitHub release.

To run your working copy, add the folder as a marketplace and install from it:

```bash
claude plugin marketplace add /path/to/pokemon-buddy
claude plugin install pokemon-buddy@pokemon-buddy
```

After an edit, run `/reload-plugins` in a session.
[DEVELOPING.md](DEVELOPING.md) has the full workflow: trying a change in one
session while the marketplace version is installed, shipping it, and updating
your install. [CONTRIBUTING.md](CONTRIBUTING.md) has the rules.

## Remove

```bash
claude plugin uninstall pokemon-buddy@pokemon-buddy
claude plugin marketplace remove pokemon-buddy
```

## Attribution

- **Explorers of Sky style sprites:** [PMDCollab/SpriteCollab](https://github.com/PMDCollab/SpriteCollab),
  a community project that draws Pokémon Mystery Dungeon sprites and
  portraits for every species, under
  [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Each
  sprite's artists are named in its `credits.txt`, and the mod writes them to
  Claude Code's debug log when it draws the buddy (`Pikachu (Sky), sprites
  by …`). The
  originals from Explorers of Sky, credited to CHUNSOFT, stay the property of
  Spike Chunsoft, Nintendo, Creatures Inc., GAME FREAK inc. and The Pokémon
  Company. The sprites, their lists and their zips come from the project's
  GraphQL server at `spriteserver.pmdcollab.org`.
- **Pokémon Crystal sprites:** hosted by [PokeAPI/sprites](https://github.com/PokeAPI/sprites).
  PokeAPI's own work there is under CC0 1.0. The images are copyright The
  Pokémon Company, Nintendo, Creatures Inc. and GAME FREAK inc.
- **Polished Crystal sprites, frame scripts and palettes:**
  [Polished Crystal](https://github.com/Rangi42/polishedcrystal) by Rangi42
  and contributors. Its [CREDITS.md](https://github.com/Rangi42/polishedcrystal/blob/master/CREDITS.md)
  names the artists who drew and animated the sprites, including many of the
  later-generation Pokémon and regional forms. It publishes no licence.
- **Pokémon Prism sprites:** made by Koolboyman, the
  [RainbowDevs](https://rainbowdevs.com) team, and sprite artists including
  SourApple. They are fetched from the unofficial archive
  [bottlebrushes/pokemon-prism-assets](https://github.com/bottlebrushes/pokemon-prism-assets),
  which extracted them from the game. Neither the archive nor Prism publishes
  a licence, and the Prism team did not publish the archive.
- **Pokémon Crystal disassembly:** [pret/pokecrystal](https://github.com/pret/pokecrystal),
  whose pic animation format this mod reads.
- **Pokémon:** Pokémon and Pokémon character names are trademarks of Nintendo,
  Creatures Inc. and GAME FREAK inc.

The mod does not copy, bundle or redistribute any sprite. Each user's Claude
Code fetches them from the public repositories above. Using a source is the
user's own choice, and each one can be turned off. The MIT licence of this
repository covers only its own code.

The header animation, `docs/header-sky.gif`, shows SpriteCollab's Pikachu
sprite (its Explorers of Sky original, credited to CHUNSOFT) walking a
mocked-up band, and the plugin icon, `.claude-plugin/icon.png`, shows Pokémon
Crystal's Charizard sprite (from PokeAPI/sprites), both drawn to illustrate
what the mod does. Neither sprite is covered by the MIT licence. They stay the
property of Spike Chunsoft, Nintendo, Creatures Inc., GAME FREAK inc. and The
Pokémon Company, and both images will be removed on request.

[NOTICE.md](NOTICE.md) has the full notice. If you made one of these sprites
and want this mod to stop fetching it, open an issue.

This is an unofficial fan project. It is not affiliated with, endorsed by, or
sponsored by Nintendo, Creatures Inc., GAME FREAK inc., The Pokémon Company,
Spike Chunsoft, Anthropic, PMDCollab, PokeAPI, the Polished Crystal project,
or the Prism team.

## Licence

The code is under the [MIT licence](LICENSE). It does not cover the sprites
or any Pokémon trademark.
