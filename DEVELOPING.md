# Developing

How to work on Pokémon Buddy, try a change, ship it, and update your own
install. `CONTRIBUTING.md` has the rules; this file has the steps.

## The two ways the mod runs

| | Marketplace install | Working copy |
| --- | --- | --- |
| How | `/plugin install pokemon-buddy --marketplace Shavvimal/pokemon-buddy` | `claude --plugin-dir /path/to/pokemon-buddy` |
| Runs | The copy made from GitHub `main` when it was installed or last updated | The folder on disk, uncommitted edits included |
| Lasts | Every session (user scope) | That one session only |
| Picks up a change | After `claude plugin update` and a new session | After `/reload-plugins`, or on its own when a turn ends |

Keep the marketplace install for daily use: it is what other people run. Use
the working copy only to try a change.

## Set up

```bash
git clone https://github.com/Shavvimal/pokemon-buddy.git
cd pokemon-buddy
make check
```

You need Node 22 or later, and Claude Code at the version CI pins
(`CLAUDE_CODE_VERSION` in `.github/workflows/ci.yml`).

For the type check, Claude Code must first write the mod's type declarations
to `.claude-plugin/types/`. It does that the first time an interactive session
loads the folder:

```bash
claude --plugin-dir .
```

Quit that session once it has started. Until then, `make check` skips the
type check and says so. `-p` runs do not write the types. The folder is
gitignored.

## Try a change in one session

The marketplace copy and your working copy are both named `pokemon-buddy`.
Turn the installed one off first, so only your working copy draws:

```bash
claude plugin disable pokemon-buddy@pokemon-buddy
claude --plugin-dir /path/to/pokemon-buddy --debug
```

In that session:

- Your edits to `hooks/register.tsx` reload when a turn ends, or straight away
  with `/reload-plugins`.
- A hook that fails, or a module that does not load, shows one dim line that
  names `pokemon-buddy`. With `--debug`, the debug log has every line that
  starts with `pokemon-buddy:`, such as `pokemon-buddy: no sprite (...)`.
- The sprite appears once the background fetch finishes. A first fetch takes a
  second or two; a cached sprite is immediate.

When you are done, turn the installed copy back on:

```bash
claude plugin enable pokemon-buddy@pokemon-buddy
```

Not yet verified: what Claude Code does if both copies are on at once. Keep
the installed one disabled while you test.

## Check before you push

```bash
make check
```

| Step | What it runs |
| --- | --- |
| `hygiene` | `node scripts/check-hygiene.mjs`: no home paths, personal emails or private names in tracked files |
| `validate` | `claude plugin validate . --profile directory`: manifest, marketplace and hooks module, against the plugin directory's rules |
| `test` | `claude plugin test .`: the engine tests in `tests/` |
| `typecheck` | `tsc -p tsconfig.json`, once `.claude-plugin/types/` exists |

The tests run against the engine itself, with a mocked clock, store and
network. They check what the mod draws, not what a terminal paints, so a change
to drawing or animation also needs a look in a real session (Ghostty, kitty,
or iTerm2 3.5 or later).

## Ship a change

`main` is protected. Every change lands through a pull request, squash-merged,
with the `check` and `version-bump` checks green.

1. Branch: `git switch -c <short-name>`.
2. Make the change, and run `make check`.
3. If you changed anything under `hooks/` or `.claude-plugin/`, raise
   `version` in `.claude-plugin/plugin.json` (semver) and add a
   `## <version> - <date>` section at the top of `CHANGELOG.md`. Docs, tests
   and CI changes need no bump.
4. Push and open a pull request:

   ```bash
   git push -u origin <short-name>
   gh pr create --fill
   ```

5. Wait for the checks (`gh pr checks --watch`), then squash-merge:

   ```bash
   gh pr merge --squash
   ```

   GitHub deletes the branch. Then sync: `git switch main && git pull`.

On the merge, the `release` workflow reads the version. If no release has
that tag yet, it tags `v<version>` and publishes the CHANGELOG section as the
release notes. A merge without a version change publishes nothing.

### Pace GitHub writes

GitHub limits how fast one account can create content: pull requests,
comments, reviews, labels. The limit is shared by every tool that uses your
account, including review bots and other Claude Code sessions. In a burst,
even the web interface refuses with "was submitted too quickly". If that
happens:

- Stop retrying. Requests sent while blocked can extend the block.
- Pause any automation that posts under your account.
- Wait about 30 minutes of quiet, then try once.

Pushes are not affected, so your branch is safe in the meantime.

## Update your own install

Once a change is on `main`:

```bash
claude plugin marketplace update pokemon-buddy
claude plugin update pokemon-buddy@pokemon-buddy
```

Then start a new session: an update applies on restart. Check the version
with `claude plugin list`.

## Settings

The three sources (`crystal`, `polishedCrystal`, `prism`) are per-user
settings, on by default. Change them in the `/config` menu, or see them with:

```bash
claude plugin configure pokemon-buddy@pokemon-buddy
```

Sizes, timings, the shiny odds and the cache limit are in `CONFIG` at the top
of `hooks/register.tsx`. A change there is a code change: it ships through a
pull request and a version bump.

## Change the pinned Claude Code version

CI installs the Claude Code version in `CLAUDE_CODE_VERSION`
(`.github/workflows/ci.yml`). The mod API is early access, so a new Claude
Code release can change it. To move up:

1. Update Claude Code locally and run `make check`.
2. Try the mod in a real session.
3. Change `CLAUDE_CODE_VERSION`, and the version named in `README.md`
   (Requirements).
4. Ship it as a pull request. It needs no version bump unless the mod changed.

## Switch your install between GitHub and a local folder

Both marketplaces are named `pokemon-buddy`, so remove one before you add the
other.

From GitHub to a local folder, where every edit is live:

```bash
claude plugin uninstall pokemon-buddy@pokemon-buddy
claude plugin marketplace remove pokemon-buddy
claude plugin marketplace add /path/to/pokemon-buddy
claude plugin install pokemon-buddy@pokemon-buddy
```

From a local folder back to GitHub:

```bash
claude plugin uninstall pokemon-buddy@pokemon-buddy
claude plugin marketplace remove pokemon-buddy
```

Then, at a Claude Code prompt:

```
/plugin install pokemon-buddy --marketplace Shavvimal/pokemon-buddy
```

A folder marketplace reads the plugin from the folder itself, so a new session
or `/reload-plugins` picks up an edit with no update step.

## Remove it

```bash
claude plugin uninstall pokemon-buddy@pokemon-buddy
claude plugin marketplace remove pokemon-buddy
```
