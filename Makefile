# One gate for every change: `make check` runs what CI runs, plus the type check
# and the private-term scan, which need files only your machine has.

.PHONY: check hygiene validate test typecheck bench bench-if-fetched

check: hygiene validate test typecheck bench-if-fetched

hygiene:
	node scripts/check-hygiene.mjs

validate:
	claude plugin validate . --profile directory

test:
	claude plugin test .

# Claude Code writes the mod's type declarations to .claude-plugin/types/ the
# first time it loads the folder (`claude --plugin-dir .`). Until then there is
# nothing to check against, so this step says so and passes.
typecheck:
	@if [ -f .claude-plugin/types/tsconfig.json ]; then \
		npx --yes --package typescript@5.9.3 tsc -p tsconfig.json; \
	else \
		echo "typecheck: skipped; run 'claude --plugin-dir .' once to write .claude-plugin/types/"; \
	fi

# The Sky drawing-cost benchmark (scripts/bench-sky.ts): real SpriteCollab
# rigs on a simulated clock, against budgets. `bench` fetches the sprites into
# $XDG_CACHE_HOME/pokemon-buddy/bench (outside the repository) on first use;
# `check` runs it only once they are there. CI does not run it.
BENCH = node --experimental-transform-types --no-warnings scripts/bench-sky.ts

bench:
	$(BENCH) --fetch

bench-if-fetched:
	@$(BENCH)
