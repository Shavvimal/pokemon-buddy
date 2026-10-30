# Pokémon Buddy

A [Claude Code](https://claude.com/claude-code) mod that shows one random,
animated Pokémon in the Game Boy Color style of Pokémon Crystal at the right
end of the row above your prompt. Each new session gets a new Pokémon.

The sprites come from [Polished Crystal](https://github.com/Rangi42/polishedcrystal),
a Pokémon Crystal ROM hack by Rangi42 and its contributors. Its source keeps
each Pokémon in Crystal's own format, so the mod plays the same frames, timing
and palettes the game does. That gives about 290 species, from Bulbasaur to
later relatives such as Sylveon, Annihilape and Dudunsparce, plus regional
forms. About one session in 512 gets a shiny.

**This repository holds no sprites.** The mod fetches each sprite from the
public Polished Crystal repository when a session starts. See
[Attribution](#attribution).

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

- Claude Code with mod (hooks module) support.
- A terminal that can draw pictures: [Ghostty](https://ghostty.org),
  [kitty](https://sw.kovidgoyal.net/kitty/), or iTerm2 3.5 or later. In other
  terminals, the row stays empty.
- Inside tmux, turn on `allow-passthrough` and `focus-events`.
- Network access to `api.github.com` and `raw.githubusercontent.com` for the
  first sessions. After that, cached Pokémon work offline.

## How it works

1. When a session starts, the mod reads the list of sprite folders in Polished
   Crystal through the GitHub API. It keeps the list for 7 days.
2. It picks a species at random, then one of that species' forms, so a species
   with many forms (Unown, Magikarp) is no likelier than any other.
3. It fetches that Pokémon's front pic (a 4-shade PNG strip of frames), its
   frame script and its palettes, and caches them in the plugin's store.
4. It decodes the PNG, colours each frame with the palette, makes the white
   background transparent, and runs the frame script to get the animation.
5. It draws the sprite as a terminal image and swaps frames at the game's
   speed, 60 ticks a second, with a rest between loops.

The fetch runs in the background, so a session never waits on GitHub. If
GitHub cannot be reached, or rate-limits the request, the mod shows a Pokémon
from its cache.

All the logic sits in one file, [`hooks/register.tsx`](hooks/register.tsx).
It has no dependencies: the PNG decoder and the zlib decompressor are part of
the file, because the mod runtime has neither.

## Configuration

Edit `CONFIG` at the top of `hooks/register.tsx`:

| Key | Default | What it does |
| --- | --- | --- |
| `rows` | `3` | Sprite height in terminal rows. Use `6` to see every pixel. |
| `cellAspect` | `2` | Cell height divided by cell width. Keeps the sprite square. |
| `pixelScale` | `2` | Nearest-neighbour upscale, so pixels stay sharp. |
| `loopPauseMs` | `3000` | Rest between animation loops. `0` loops without a break. |
| `shinyOdds` | `512` | One session in this many gets the shiny palette. `0` turns shinies off. |
| `cacheLimit` | `60` | Pokémon kept for offline sessions, about 3 KB each. |
| `indexMaxAgeMs` | 7 days | How long the sprite list is kept before it is fetched again. |
| `exclude` | `['egg']` | Sprite folders left out of the draw. |
| `repo` | Polished Crystal | The repository, branch and folder the sprites come from. |

## Network and privacy

Each session makes at most these requests, all to GitHub:

| Request | When |
| --- | --- |
| `GET api.github.com/repos/Rangi42/polishedcrystal/git/trees/...` | Once every 7 days, for the sprite list |
| `GET api.github.com/repos/Rangi42/polishedcrystal/contents/.../front.png` | Once per Pokémon not yet cached |
| `GET raw.githubusercontent.com/Rangi42/polishedcrystal/...` | Up to 3 small text files per Pokémon not yet cached |

The requests carry no token and no data about you, only a `User-Agent` that
names this mod. GitHub allows 60 unauthenticated API requests an hour, and a
session uses at most 2.

## Development

```bash
claude plugin validate .   # manifest and hooks module checks
claude plugin test .       # engine tests in tests/
```

To run your working copy, add the folder as a marketplace and install from it:

```bash
claude plugin marketplace add /path/to/pokemon-buddy
claude plugin install pokemon-buddy@pokemon-buddy
```

After an edit, run `/reload-plugins` in a session. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Remove

```bash
claude plugin uninstall pokemon-buddy@pokemon-buddy
claude plugin marketplace remove pokemon-buddy
```

## Attribution

- **Sprites, frame scripts and palettes:**
  [Polished Crystal](https://github.com/Rangi42/polishedcrystal) by Rangi42
  and contributors. Its [CREDITS.md](https://github.com/Rangi42/polishedcrystal/blob/master/CREDITS.md)
  names the artists who drew and animated the sprites, including many of the
  later-generation Pokémon and regional forms.
- **Pokémon Crystal disassembly:** [pret/pokecrystal](https://github.com/pret/pokecrystal),
  which Polished Crystal is built on and whose pic animation format this mod reads.
- **Pokémon:** Pokémon and Pokémon character names are trademarks of Nintendo,
  Creatures Inc. and GAME FREAK inc. The original Pokémon Crystal artwork is
  © Nintendo, Creatures Inc. and GAME FREAK inc.

Polished Crystal publishes no licence for its assets, so this repository does
not copy, bundle or redistribute any of them. Each user's Claude Code fetches
them straight from the public Polished Crystal repository. The MIT licence of
this repository covers only its own code.

[NOTICE.md](NOTICE.md) has the full notice.

This is an unofficial fan project. It is not affiliated with, endorsed by, or
sponsored by Nintendo, Creatures Inc., GAME FREAK inc., The Pokémon Company,
Anthropic, or the Polished Crystal project.

## Licence

The code is under the [MIT licence](LICENSE). It does not cover the sprites
or any Pokémon trademark.
