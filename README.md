# pi-graphite

[![CI](https://github.com/mcuste/pi-graphite/actions/workflows/ci.yml/badge.svg)](https://github.com/mcuste/pi-graphite/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mcuste/pi-graphite)](https://www.npmjs.com/package/@mcuste/pi-graphite)

An extension for the [Pi](https://github.com/earendil-works/pi) and
[Oh My Pi](https://github.com/can1357/oh-my-pi) terminal coding agents. It gives the model one
`graphite` tool that runs a fixed set of [Graphite](https://graphite.com/docs/graphite-cli) stack
operations, instead of letting it type `gt` commands into a shell.

If any of those names are new to you:

- **Graphite** (`gt`) is a Git CLI for stacked branches: many small branches chained on top of each
  other, each becoming its own pull request.
- **Pi** and **Oh My Pi** are terminal coding agents. An **extension** is an npm package they load
  at startup to add tools the model can call.

## Why

An agent with shell access can already run `gt`, but a shell gives it a free-form command string:
it can pass flags nobody intended, trigger interactive prompts that hang, publish branches to the
remote, or leave the repository half-rebased after a failed command.

This extension replaces that with a closed set of operations. Each one accepts only its own typed
fields, builds a fixed argument array, checks the repository before running, and verifies the result
afterwards. There is no shell string anywhere, and remote and history-rewriting commands are simply
not exposed.

## Requirements

- Node.js 22 or newer
- Git
- Graphite CLI (`gt`) 1.8.6 in repositories where the tool is used

The extension loads even without `gt` or outside a Graphite repository. A tool call then fails with
an explanatory error rather than running an unsupported command.

## Install

Pi:

```bash
pi install npm:@mcuste/pi-graphite
```

Oh My Pi:

```bash
omp plugin install @mcuste/pi-graphite
```

Or through the Oh My Pi marketplace:

```text
/marketplace add mcuste/pi-graphite
/marketplace install pi-graphite@pi-graphite
```

From a local checkout:

```bash
pnpm install
pi install /absolute/path/to/pi-graphite
omp plugin link /absolute/path/to/pi-graphite
```

## What the tool does

One tool named `graphite`, selected by an `operation` field:

| Operation | Runs | Purpose |
| --- | --- | --- |
| `inspect` | `gt log`, `gt state`, `gt parent`, `gt children`, `gt trunk`, `gt info` | Read the stack |
| `checkout` | `gt checkout <branch>` | Switch to a named branch |
| `create` | `gt create` | Start a new branch from staged changes |
| `modify_commit` | `gt modify --commit` | Add staged changes as a new commit |
| `modify_amend` | `gt modify` | Amend staged changes into the current commit |
| `squash` | `gt squash` | Collapse a branch into one commit |
| `fold` | `gt fold` | Merge a branch into its parent |
| `rename` | `gt rename <name>` | Rename a branch |
| `move` | `gt move` | Reparent a branch onto another |
| `restack` | `gt restack` | Rebase a branch onto its parent |
| `delete` | `gt delete <branch> --force` | Delete a branch |
| `continue` | `gt continue` | Resume after resolving conflicts |
| `abort` | `gt abort --force` | Cancel an in-progress rebase |

`inspect` is read-only. Everything else changes the repository, and Oh My Pi asks for execute
approval; `delete` and `abort` always prompt. Full per-operation fields and guarantees are in
[docs/operations.md](docs/operations.md).

## What is deliberately missing

- **Remote operations** (`gt get`, `gt sync`, `gt submit`) depend on credentials, remote state, and
  publication intent. Pushing or opening pull requests stays a human decision.
- **Relative navigation** (`gt up`, `gt down`, `gt top`, `gt bottom`) prompts when a branch has
  several children. The model must inspect the stack and ask for an exact branch instead.
- **History-choosing commands** (`gt absorb`, `gt split`, `gt reorder`, `gt undo`) pick commits or
  hunks on the caller's behalf.

For these, the model works through the normal Graphite workflow with the user in the loop.

## Safety

Every operation checks the repository before and after it runs: a clean worktree stays clean, the
checked-out branch is preserved unless the operation is meant to change it, committed content is
compared against what was staged, and deleted branches are confirmed gone. A failed check is
reported as an uncertain result rather than retried.

Arguments are never concatenated into a shell command. Commit text travels as `--message=<text>`, so
a body starting with `-` stays message content. See [docs/safety.md](docs/safety.md).

## Documentation

- [Operations reference](docs/operations.md)
- [Safety model](docs/safety.md)
- [Development and release](docs/development.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
