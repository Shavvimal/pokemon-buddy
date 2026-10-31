#!/usr/bin/env node
// This repository is public: no tracked file may name a person's machine, a
// personal email address, or a private project. The patterns below are the
// generic shapes. The names that must never appear are not listed here,
// because listing them would publish them: they live in an untracked file,
// $XDG_CONFIG_HOME/pokemon-buddy/private-terms (one per line, matched without
// case), which this script reads when it exists. CI checks the generic shapes;
// `make check` also checks the private names before a push.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2'])
/** A placeholder user (`/Users/x/`, `/home/alice/`) is documentation, not a person. */
const PLACEHOLDER_USERS = ['x', 'alice', 'bob', 'me', 'you', 'user', 'name', 'example', '<name>']

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const patterns = {
  'a home directory path': new RegExp(
    `(?<![\\w/])/(?:Users|home)/(?!(?:${PLACEHOLDER_USERS.map(escape).join('|')})/)[A-Za-z0-9_.<>-]+/`
  ),
  'a personal email address': /[\w.+-]+@(?:gmail|googlemail|outlook|hotmail|icloud|proton|protonmail|yahoo)\./i,
}

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
const termsFile = join(configHome, 'pokemon-buddy', 'private-terms')
const privateTerms = existsSync(termsFile)
  ? readFileSync(termsFile, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(term => term && !term.startsWith('#'))
  : []
// Each is labelled by its line number in the terms file, never by the term itself.
privateTerms.forEach((term, i) => {
  patterns[`private term ${i + 1}`] = new RegExp(escape(term), 'i')
})

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(file => file && !BINARY.has(extname(file).toLowerCase()) && existsSync(file))

const hits = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const [label, pattern] of Object.entries(patterns)) {
      // A private term's hit is reported by label only, so the log does not publish it.
      if (pattern.test(line)) hits.push(`${file}:${i + 1}: ${label}`)
    }
  })
}

if (hits.length > 0) {
  console.error(`Public hygiene: ${hits.length} problem(s)\n${hits.join('\n')}`)
  process.exit(1)
}
const checked = privateTerms.length > 0 ? 'generic shapes and private terms' : 'generic shapes'
console.log(`Public hygiene: ${files.length} tracked files clean (${checked}).`)
