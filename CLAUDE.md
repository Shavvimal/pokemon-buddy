# pokemon-buddy: repository rules

This repository is public. Every file, commit message, PR title and PR body is
published the moment it is pushed, and a force push does not take it back.

## What this is

A Claude Code mod (a hooks module). Its logic is in `hooks/register.tsx` (sources,
Pokédex, cache, the Crystal player, the hooks), `hooks/sky.tsx` (the Sky buddy:
sheets, rig, painting, actor) and `hooks/codecs.ts` (base64, inflate, zip, PNG,
GIF);
`.claude-plugin/plugin.json` is the manifest, `.claude-plugin/marketplace.json`
makes the repository installable, and `tests/` holds the engine tests.

## No game assets

- Never commit a sprite, palette, frame script, ROM or ROM extract. The mod
  fetches sprites at run time from the sources credited in `README.md` and
  `NOTICE.md`.
- Test data is drawn for this repository (the shaded squares in
  `tests/buddy.test.tsx` and the zip of them in `tests/sky-zip.ts`). `docs/header-sky.gif` and `.claude-plugin/icon.png`
  are the two documented exceptions (see `NOTICE.md`); add no more.
- A new source gets a `SpriteSource` strategy, a `userConfig` switch in
  `plugin.json`, and an entry in both the README's Attribution and `NOTICE.md`.

## Public-repo hygiene

- Never write a private project name, a client or employer name, an absolute
  home directory path (`/Users/<name>/...`, `/home/<name>/...`), a personal
  email, or an account id into a tracked file, a commit message or a PR.
- `scripts/check-hygiene.mjs` scans every tracked file for those shapes in CI,
  and for the names in the untracked file
  `$XDG_CONFIG_HOME/pokemon-buddy/private-terms` (one per line) locally. Add a
  private name to that file, never to a tracked one.

## Design record

`docs/spritecollab-format.md` (the SpriteCollab data, verified),
`docs/sky-buddy-design.md` (the actor's design) and `docs/spritecollab-plan.md`
(decisions and delivery) are the record for the Sky style. Keep them true
when the behaviour changes.

## Developing

`DEVELOPING.md` has the workflow: one-session testing with `--plugin-dir`
while the marketplace copy is disabled, the pull request and release flow, and
updating an install. Keep it accurate when a step changes.

## Gate

`make check` runs the hygiene scan, `claude plugin validate --profile directory`, the engine tests, `tsc` when Claude Code has written the types
(`claude --plugin-dir .` once), and the Sky drawing-cost bench
(`scripts/bench-sky.ts`) once `make bench` has fetched its sprites outside the
repository. CI runs the first three on every pull request.

- `main` is protected: changes land through a pull request, squash-merged,
  with the `check` and `version-bump` checks green.
- A change under `hooks/` or `.claude-plugin/` raises `version` in
  `.claude-plugin/plugin.json` and adds a `CHANGELOG.md` section; the release
  workflow then tags and publishes it.
- Commits carry no attribution trailer.
