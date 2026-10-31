# Notice

Pokémon Buddy is an unofficial fan project. It is not affiliated with,
endorsed by, or sponsored by Nintendo, Creatures Inc., GAME FREAK inc.,
The Pokémon Company, Spike Chunsoft, Anthropic, PMDCollab, PokeAPI, the
Polished Crystal project, or the Pokémon Prism team.

## What this repository contains

Original code and documentation, under the MIT licence in
[LICENSE](LICENSE). The test sprites in `tests/buddy.test.tsx` and
`tests/sky-zip.ts` are plain shaded squares made for this repository.

Two exceptions each show one sprite, to illustrate what the mod does:

- `docs/header-sky.gif`, the README header: a mockup of a terminal session in
  which SpriteCollab's Pikachu sprite (the Explorers of Sky original,
  credited to CHUNSOFT in `sprite/0025/credits.txt`) walks the band.
- `.claude-plugin/icon.png`, the plugin icon: one frame of Pokémon Crystal's
  Charizard sprite (from PokeAPI/sprites).

Neither sprite is covered by the MIT licence. They stay the property of
Spike Chunsoft, Nintendo, Creatures Inc., GAME FREAK inc. and The Pokémon
Company. Both images will be removed on request: open an issue.

## What this repository does not contain

No other sprite, and no palette, frame script or other asset from any game or
ROM hack. The mod fetches those at run time, on the user's machine, from the
public repositories named below, and keeps a small cache in the user's own
Claude Code plugin store. Nothing is re-hosted. Each source is a setting the
user can turn off.

## Third-party sources

### SpriteCollab (Pokémon Mystery Dungeon: Explorers of Sky style)

- Repository: <https://github.com/PMDCollab/SpriteCollab>, with its GraphQL
  server at <https://spriteserver.pmdcollab.org> (source:
  <https://github.com/PMDCollab/spritecollab-srv>).
- Used: the server's sprite list, and per sprite its zip of `AnimData.xml`,
  `credits.txt` and the `*-Anim.png`, `*-Offsets.png` and `*-Shadow.png`
  sheets, fetched at run time. The mod keeps the sheets of the actions it
  plays and the credits, and logs the credited artists when it draws a buddy.
- Authors: the PMDCollab community, named per sprite in `credits.txt` and
  in the repository's `credit_names.txt`. Sprites credited to `CHUNSOFT` are
  the originals from Explorers of Sky.
- Licence: the repository is published under
  [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). This mod
  is non-commercial and credits each sprite. The originals stay the property
  of Spike Chunsoft, Nintendo, Creatures Inc., GAME FREAK inc. and The
  Pokémon Company.

### Pokémon Crystal sprites, through PokeAPI

- Repository: <https://github.com/PokeAPI/sprites>
- Used: `sprites/pokemon/versions/generation-ii/crystal/animated/*.gif` and
  `shiny/*.gif`, fetched at run time. Species names come from the PokeAPI web
  API (<https://pokeapi.co>).
- Licence: PokeAPI distributes its repository under CC0 1.0 and states that
  all image contents are copyright The Pokémon Company.

### Polished Crystal

- Repository: <https://github.com/Rangi42/polishedcrystal>
- Used: `gfx/pokemon/*/front.png`, `anim.asm`, `normal.pal` and `shiny.pal`,
  fetched at run time.
- Authors: Rangi42 and the contributors named in
  [CREDITS.md](https://github.com/Rangi42/polishedcrystal/blob/master/CREDITS.md),
  including the artists of the Pokémon sprites and animations added after
  Generation II.
- Licence: the repository publishes no licence.

### Pokémon Prism, through a third-party archive

- Archive: <https://github.com/bottlebrushes/pokemon-prism-assets>, an
  unofficial collection of graphics extracted from Pokémon Prism.
- Used: `manifest.json`, and `pokemon/*/front.png` and `shiny.png`, fetched at
  run time.
- Authors: Pokémon Prism is by Koolboyman and the RainbowDevs team
  (<https://rainbowdevs.com/title/prism/>), with sprites and animations by
  artists including SourApple.
- Licence: neither Prism nor the archive publishes a licence, and the Prism
  team did not publish the archive. The source is on by default. A user who
  prefers not to use it can set the `prism` setting to off.

If you made any of these sprites, or maintain one of these repositories, and
want this mod to stop fetching from you, open an issue and the source will be
removed.

### pret/pokecrystal

- Repository: <https://github.com/pret/pokecrystal>
- Used: the pic animation format (`frame`, `setrepeat`, `dorepeat`,
  `endanim`) that the mod's player reads. No code is copied.

### zlib `puff.c`

- Source: <https://github.com/madler/zlib/blob/develop/contrib/puff/puff.c>,
  by Mark Adler, under the zlib licence.
- Used: the structure of the decompressor in `hooks/codecs.ts` follows
  `puff.c`. The TypeScript is original.

### Shimeji-EE

- Repository: <https://github.com/LavenderSnek/ShimejiEE-cross-platform>
- Used: the shape of its behaviour file (weighted next behaviours and
  conditions) informed the buddy's weighted choices. No code or asset is
  copied.

## Trademarks

Pokémon and Pokémon character names are trademarks of Nintendo,
Creatures Inc. and GAME FREAK inc. Pokémon Crystal and its artwork are
© 2000–2001 Nintendo, Creatures Inc. and GAME FREAK inc. Pokémon Mystery
Dungeon: Explorers of Sky and its artwork are © 2009 Spike Chunsoft,
Nintendo, Creatures Inc. and GAME FREAK inc. Claude and Claude Code are
trademarks of Anthropic, PBC. Ghostty, kitty and iTerm2 are named only to
describe compatibility.
