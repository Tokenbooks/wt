# Env path isolation

How `wt` keeps filesystem paths inside seeded env files pointing at the worktree
that owns them, and why an unpatched absolute path is dangerous.

## The failure mode

`wt new` and `wt setup` build a worktree's env files in three passes:

1. Copy each configured env file verbatim from the main worktree.
2. Fill in vars missing from the file using the committed `.env.example`.
3. Patch the vars enumerated in `wt.config.json` (database, ports, URLs, branch).

Pass 3 only touches keys the config names. Every other line survives the copy
untouched, including any value that is an absolute filesystem path.

A developer's env file often holds such a path. The committed example may use the
correct relative form, but a local file that was hand-edited once keeps whatever
was typed. Copied into a worktree, that value still addresses the main checkout.

This is worse than a stale setting because it is silent:

- The path resolves, so nothing errors.
- The artifact behind it is real and executable, so process spawns succeed and
  health checks pass.
- Port isolation still works. A service started from the wrong binary listens on
  exactly the port the worktree allocated, so every observable signal looks right.

The result inverts the point of the worktree: code changed in the worktree is not
the code that runs, and local verification of that component proves nothing.

The concrete report that motivated this
([wt#18](https://github.com/Tokenbooks/wt/issues/18)) was a Rust engine fix
verified in a worktree whose server had been spawning the main checkout's release
binary the whole time, because `server/.env` carried
`ACCOUNTING_RUST_RUNNER_BIN=/abs/path/to/main-checkout/...`.

## The rule

For every value in a seeded env file that is an absolute path (leading `/`, or
`~/` which is expanded first), `wt` locates the git working tree that encloses it
by walking up the directory chain for a `.git` entry. A primary checkout has a
`.git` directory, a linked worktree has a `.git` file, so both are found. The path
itself does not need to exist.

| Enclosing checkout | Action |
| --- | --- |
| None | Leave alone. `/usr/bin/node` and `/tmp/cache` are deliberately shared. |
| This worktree | Leave alone. Already correct. |
| The main worktree, or another worktree of it | Rewrite to the same relative location inside this worktree, and report it. |
| Any other checkout | Leave alone and warn, naming the file and key. |

Rewriting means replacing the enclosing checkout's root with this worktree's root
and keeping the rest of the path. It is an absolute path in, absolute path out;
nothing is made relative, so nothing depends on the working directory a consumer
happens to run from.

Rewriting is not conditional on the target existing. A worktree that has not built
an artifact yet gets a path to where that artifact belongs, and the consumer fails
loudly instead of silently reaching into another checkout.

Only the path token is touched. Quoting, an inline comment, trailing whitespace,
and a CRLF line ending are all written back byte-for-byte. Checkout roots are
compared by their physical location, so a symlinked spelling of the main worktree
is still recognised as the main worktree.

## What you see

`wt new` and `wt setup` print each rewrite and each warning to stderr. Both also
appear in `--json` output under a single `envPathEscapes` array, where an entry
that could be repointed carries a `rewritten` field and a warning does not.

```
wt: rewrote 1 env value that pointed outside this worktree
  server/.env ACCOUNTING_RUST_RUNNER_BIN
    was /home/dev/proj/apps/runner/target/release/runner
    now /home/dev/proj/.worktrees/my-branch/apps/runner/target/release/runner
```

## Repairing an existing worktree

Worktrees created before this behaviour existed still hold the escaped values.
Re-running `wt setup` in the worktree re-copies and re-patches every configured
env file, which applies the rule and prints what it changed. Note that
`wt setup --repair` short-circuits when there is nothing to repair, so use plain
`wt setup`.

## Limits

- Only keys inside files listed in `wt.config.json` under `envFiles` are examined.
  A path in a file `wt` does not manage is invisible to it.
- A value that packs several paths into one string, shell-`PATH` style, is not
  parsed and is left alone. Any value containing a colon is skipped for this
  reason, as is a value whose opening quote is never closed.
- A path into an unrelated checkout is reported, never rewritten. There is no way
  to know what the equivalent location in this worktree would be.
- `wt env seed` only fills in missing defaults. It does not sweep paths, because
  it has no worktree to repoint them at. Use `wt setup` for that.
- The nearest enclosing `.git` wins, so a path inside a submodule or a nested
  repository is judged against that inner checkout, not the main worktree.
