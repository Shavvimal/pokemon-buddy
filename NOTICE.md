# Notice

Pokémon Buddy is an unofficial fan project. It is not affiliated with,
endorsed by, or sponsored by Nintendo, Creatures Inc., GAME FREAK inc.,
The Pokémon Company, Anthropic, or the Polished Crystal project.

## What this repository contains

Original code and documentation, under the MIT licence in
[LICENSE](LICENSE). The test sprite in `tests/buddy.test.tsx` is a plain
shaded square made for this repository.

One exception: `docs/header.png`, the README header, is a mockup of a
terminal session that shows one frame of Polished Crystal's Sylveon sprite,
drawn through this mod, to illustrate what the mod does. That sprite is not
covered by the MIT licence. It stays the work of its artists (see the Polished
Crystal credits below) and of the Pokémon rights holders. It will be removed
on request: open an issue.

## What this repository does not contain

No other sprite, and no palette, frame script or other asset from Pokémon
Crystal, Polished Crystal, or any other game or ROM hack. The mod fetches
those at run time, on the user's machine, from the public repository named
below, and keeps a small cache in the user's own Claude Code plugin store.
Nothing is re-hosted.

## Third-party sources

### Polished Crystal

- Repository: <https://github.com/Rangi42/polishedcrystal>
- Used: `gfx/pokemon/*/front.png`, `anim.asm`, `normal.pal` and `shiny.pal`,
  fetched at run time.
- Authors: Rangi42 and the contributors named in
  [CREDITS.md](https://github.com/Rangi42/polishedcrystal/blob/master/CREDITS.md),
  including the artists of the Pokémon sprites and animations added after
  Generation II.
- Licence: the repository publishes no licence. Its assets are therefore not
  copied here. If the Polished Crystal maintainers object to this use, open an
  issue and the default source will change.

### pret/pokecrystal

- Repository: <https://github.com/pret/pokecrystal>
- Used: the pic animation format (`frame`, `setrepeat`, `dorepeat`,
  `endanim`) that the mod's player reads. No code is copied.

### zlib `puff.c`

- Source: <https://github.com/madler/zlib/blob/develop/contrib/puff/puff.c>,
  by Mark Adler, under the zlib licence.
- Used: the structure of the decompressor in `hooks/register.tsx` follows
  `puff.c`. The TypeScript is original.

## Trademarks

Pokémon and Pokémon character names are trademarks of Nintendo,
Creatures Inc. and GAME FREAK inc. Pokémon Crystal and its artwork are
© 2000–2001 Nintendo, Creatures Inc. and GAME FREAK inc. Claude and Claude
Code are trademarks of Anthropic, PBC. Ghostty, kitty and iTerm2 are named
only to describe compatibility.
