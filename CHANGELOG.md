# Changelog

This project follows [Semantic Versioning](https://semver.org).

## 0.4.0 - 2026-10-31

- A `style` setting, a select in `/config`: `sky` (the new default) or
  `crystal` (the mod as it was). The three Crystal source switches apply
  under `crystal`.
- Sky style: a Pokémon Mystery Dungeon: Explorers of Sky sprite from
  PMDCollab/SpriteCollab, listed through the project's GraphQL server and
  fetched as one zip per sprite through the host's `curl` (the GitHub
  contents API stands in for the core clips when `curl` fails). 963 species
  with the core clips, 203 with the full repertoire; shinies as before.
- The buddy walks the width of the band, turns through the front with the
  Rotate clip at the edges (or through Walk's quarter-direction frames when
  a sprite has no Rotate), and plays Idle, Sleep, Wake, Charge, Attack,
  Pose, Nod, Sit, LookUp, Eat, Laying, Pull, DeepBreath, Tumble, Cringe,
  LostBalance and Float, every frame anchored on its ground marker so clips
  cut without a jump. Front-only clips are entered facing the viewer.
- Weighted choices with a three-act memory, chains (a yawn before a nap, a
  charge before an attack), energy and restlessness drives, and a profile
  per species seeded by its dex number.
- The buddy notices the session: a prompt wakes it or makes it look up; a
  long turn that ends well gets a pose, an aborted or failed one a cringe;
  while Claude works it walks to the prompt end and watches; ten quiet
  minutes make it sleepy. A dim ✦ under the sprite is a button: a press gets
  a pose. The species and its artists go to the debug log, not the screen.
- The codecs moved to `hooks/codecs.ts` (now also raw deflate, a zip reader,
  and palette and RGB PNGs); the Sky engine is `hooks/sky.tsx`.
- The cache limit is per style (`{ crystal: 40, sky: 12 }`), as the store
  holds 4 MiB.
- README header: an animation of the Sky buddy walking a mocked-up band
  (`docs/header.gif`, SpriteCollab's Pikachu), in place of the Charizard still.

## 0.3.1 - 2026-10-30

- Plugin icon and README header: Pokémon Crystal's Charizard.
- CI: public hygiene scan, `claude plugin validate --profile directory`
  and the engine tests on every pull request, pinned to Claude Code
  2.1.314; a version-bump gate; tagged GitHub releases from this changelog.
- `make check`, `tsconfig.json`, `CLAUDE.md`, CODEOWNERS, Dependabot for
  workflow actions, and issue forms.

## 0.3.0 - 2026-10-30

- Three sources in one Pokédex: Pokémon Crystal (PokeAPI), Polished Crystal
  and Pokémon Prism (third-party archive), with each species and form once:
  about 480 sprites across about 380 species.
- Each source is a per-user setting (`crystal`, `polishedCrystal`, `prism`),
  all on by default.
- Sources are strategies behind one `SpriteSource` interface; a `Pokedex`
  composes them with an HTTP client and a cache.
- The PNG decoder reads 8-bit RGBA as well as greyscale; the GIF decoder is
  back, for the Crystal sprites.

## 0.2.0 - 2026-10-30

- Sprites now come from Polished Crystal: about 290 species in Pokémon Crystal's
  own format, including later relatives such as Sylveon and Annihilape, and
  regional forms.
- The mod plays each sprite with its own frame script and palette.
- Shiny palette in one session out of 512.
- Built-in PNG decoder and zlib decompressor; the GIF decoder is gone.
- Species are drawn evenly, whatever their number of forms.

## 0.1.0 - 2026-10-30

- First version: animated Pokémon Crystal sprites from PokeAPI/sprites.
