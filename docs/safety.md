# Safety model

The tool assumes the model may request anything the schema allows, including hostile values. Four
layers stand between a tool call and the repository.

## 1. Closed schema

Parameters are a TypeBox union with `additionalProperties: false` on every variant. Parsing happens
before anything runs and rejects unknown operations, unknown fields, missing fields, NUL bytes,
multi-line subjects, whitespace-only messages, and a `move` whose source and target are the same.

Branch names are length-bounded, must not start with `-`, and are validated with
`git check-ref-format --branch`. Operations that consume an existing branch also confirm its exact
`refs/heads/<branch>` ref. The same parser produces the trunk name used for trunk guards.

## 2. Fixed argument arrays

`git` and `gt` are invoked with argument arrays. No shell command string is ever built, so there is
nothing to quote or escape.

Every argument is either a fixed token from a closed vocabulary of subcommands and flags, or a
`--flag=value` pair built from an already parsed value. Commit text is passed as `--message=<text>`,
so a body starting with `-` stays message content instead of becoming a Graphite option. A final
check before spawning rejects any argument that starts with `-` and is not a known flag.

Every command carries `--no-interactive`, so Graphite never waits on a prompt. `delete` and `abort`
also carry the `--force` that Graphite requires to run non-interactively; both sit behind a verified
precondition and a forced approval prompt.

## 3. Preconditions and postconditions

Every state-changing operation records the current branch, `git status`, staged and unstaged diff
summaries, and the Graphite stack, both before and after the command.

- An operation that starts with a clean worktree must end with one.
- The checked-out branch is preserved unless the operation is meant to change it.
- `create`, `modify_commit`, and `modify_amend` compare the committed tree against the staged tree,
  and confirm that unstaged content and untracked paths are unchanged.
- `squash` and `fold` require branch content to survive unchanged.
- `rename` requires an unchanged commit and worktree.
- `rename`, `fold`, and `delete` confirm the removed branch is gone.

If a check fails, the tool reports an uncertain result. It never retries a mutation.

## 4. Host approval and concurrency

Oh My Pi resolves approval and concurrency from the operation: `inspect` is a shared read,
everything else is an exclusive execute, and `delete` and `abort` force a prompt. Pi has no such
mapping and uses its conservative sequential fallback. Within the extension process, Graphite
operations are serialized per repository, and abort signals terminate child processes.

## Repository detection and cache

The first tool call in a repository resolves the Git worktree and verifies that:

1. The working directory belongs to a Git worktree with absolute repository paths.
2. `gt --version` reports the supported version, 1.8.6.
3. `gt trunk --no-interactive` returns a valid, existing local trunk branch.

On success it writes `<git-dir>/pi-graphite.json` holding `usesGraphite: true`, the repository root,
Graphite CLI version, trunk, and verification time. The file lives in Git's administrative
directory, so no tracked files change.

A cached result is reused only after confirming the recorded trunk still exists locally; a renamed
or deleted trunk forces re-detection. Malformed, version-incompatible, future-dated, and
older-than-24-hours entries are ignored. The in-memory cache expires on the same deadline.

Only success is persisted, so a plain Git repository is rechecked after `gt init` and a missing CLI
starts working right after installation. If Git metadata is read-only, operations still run and the
result notes that the cache could not be written.
