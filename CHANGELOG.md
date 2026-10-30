# Changelog

This project follows [Semantic Versioning](https://semver.org).

## 0.3.1 - 2026-10-30

- Plugin icon: the Sylveon sprite from the README header.
- CI: public hygiene scan, `claude plugin validate --profile directory
  --strict` and the engine tests on every pull request, pinned to Claude Code
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
