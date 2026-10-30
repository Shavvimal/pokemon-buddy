# Contributing

Thanks for helping. Bug reports, fixes and small features are welcome.

## Ground rules

- **No game assets in this repository.** Never commit a sprite, palette, frame
  script, ROM or ROM extract, from any game or ROM hack. The mod fetches assets
  at run time. Test data must be made for this repository, like the shaded
  square in `tests/buddy.test.tsx`. The README header, `docs/header.png`, is
  the one exception, and `NOTICE.md` explains it. Do not add more.
- **Credit every source.** If a change reads from a new source, add it to the
  Attribution section of `README.md` and to `NOTICE.md`, with its licence and
  where its files come from. Give it a setting, so users can turn it off.
- **One file of logic.** The mod lives in `hooks/register.tsx`. Keep it free of
  dependencies, and keep the sections in order: configuration, base64, inflate,
  PNG decoding, GIF decoding, pic animation, sprite shaping, sprite sources,
  collection, playback, hooks.
- **Composition, not inheritance.** A new source is one more object that meets
  the `SpriteSource` interface (list, needs, animate), added to `SOURCES` in
  priority order, with a setting in `plugin.json`. It shares no base class.
- **Only the hooks touch the engine.** Every other part gets what it needs
  through constructor arguments or small functions, so it can be tested on its
  own.

## Before you open a pull request

```bash
claude plugin validate .
claude plugin test .
```

Both must pass. For a change to drawing or animation, also try it in a real
session in Ghostty, kitty or iTerm2 3.5 or later, and say which terminal you
used in the pull request.

## Reporting a bug

Open an issue with your terminal, your Claude Code version, and any line that
starts with `pokemon-buddy:` from a session run with `claude --debug`.

By contributing, you agree that your contribution is licensed under the MIT
licence in [LICENSE](LICENSE), and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
