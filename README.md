# pi-graphite

`@mcuste/pi-graphite` is an installable extension for Pi and Oh My Pi (OMP). It exposes one typed, model-callable `graphite` tool with fixed Graphite operations.

## Requirements

- Node.js 22 or newer
- Git
- Graphite CLI (`gt`) 1.8.6 for repositories that use the tool

The extension still loads when `gt` is absent or the current directory is not a Graphite repository. A Graphite tool call then fails with an actionable error instead of spawning an unsupported command.

## Tool

The `graphite` tool uses a closed TypeBox union. Each `operation` accepts only its own fields and
maps to one fixed argument array.

| Operation | Graphite command | OMP approval | Guard |
| --- | --- | --- | --- |
| `inspect` | `gt log --stack`, `gt log short`, `gt state`, `gt parent`, `gt children`, `gt trunk`, or `gt info` | `read` | Fixed target enum |
| `checkout` | `gt checkout <branch>` | `exec` | Existing local branch, clean worktree, exact checkout verified |
| `create` | `gt create <name> --message=<subject> --message=<body>` | `exec` | Staged tree committed exactly |
| `modify_commit` | `gt modify --commit --message=<subject> --message=<body>` | `exec` | Staged tree committed exactly |
| `modify_amend` | `gt modify` | `exec` | Staged tree amended exactly |
| `squash` | `gt squash --message=<subject> --message=<body>` | `exec` | Non-trunk branch, clean worktree, branch content unchanged, exactly one commit above the parent |
| `fold` | `gt fold` | `exec` | Non-trunk branch and parent, clean worktree, parent checked out with unchanged content, folded branch gone |
| `rename` | `gt rename <name>` | `exec` | Non-trunk branch, requested name reached, commit and worktree unchanged, old branch gone |
| `move` | `gt move --source=<source> --onto=<parent>` | `exec` | Existing branches, clean worktree, ancestry and checkout verified |
| `restack` | `gt restack --branch=<branch>` | `exec` | Existing branch, clean worktree and checkout preserved |
| `delete` | `gt delete <branch> --force` | forced prompt | Existing branch that is neither trunk nor checked out, clean worktree, checkout preserved, branch gone |
| `continue` | `gt continue` | `exec` | Active rebase, no unresolved paths, attached checkout afterward |
| `abort` | `gt abort --force` | forced prompt | Active rebase and attached checkout afterward |

All commands add `--no-interactive`. `abort` and `delete` add the `--force` that Graphite requires
to run those commands non-interactively, but only behind a verified precondition, a forced OMP
approval prompt, and an explicit confirmation. Callers cannot request publication, cleanup, remote
access, or arbitrary arguments.

Every argument the extension passes to `gt` is either a fixed token from a closed vocabulary of
subcommands and flags or a `--flag=value` pair built from an already parsed value. Commit text
travels as `--message=<text>`, so a body that starts with `-` stays message content instead of
turning into Graphite options. A final check before spawning rejects any argument that starts with
`-` and is not a known flag.

OMP resolves approval and concurrency from the operation. Inspection is read-only and shared; every
other operation is executable and exclusive. Pi uses the conservative sequential execution fallback.

Ambiguous navigation and remote commands are intentionally outside the tool. `gt up`, `gt down`,
`gt top`, and `gt bottom` depend on the current position and prompt when a branch has several
children, so the model must inspect the stack and request an exact `checkout` branch. `gt get`,
`gt sync`, and `gt submit` depend on remote state, credentials, cleanup choices, or publication
authorization. `gt absorb`, `gt split`, `gt reorder`, and `gt undo` choose commits, hunks, or
history for the caller. The LLM must handle those through the Graphite workflow after reviewing
repository state and obtaining any required user approval.

Branch values are bounded, checked with `git check-ref-format --branch`, and cannot begin with `-`.
Operations that consume an existing branch also verify its exact `refs/heads/<branch>` ref, and the
same parser produces the trunk name used for capability detection and trunk guards. Runtime parsing
rejects unknown variants, extra fields, NUL values, multi-line subjects, whitespace-only commit
messages, and same-source moves before Graphite executes.

Every state-changing operation records the current branch, status, staged diff summary, unstaged
diff summary, and Graphite stack before and after execution. Clean operations must remain clean and
must preserve the checkout unless the requested operation changes it. Create and modify compare the
committed tree with the staged tree and verify that unstaged content and untracked paths remain
unchanged. Squash and fold require the branch content to survive unchanged, rename requires an
unchanged commit and worktree, and rename, fold, and delete confirm that the removed branch is gone.
A failed postcondition reports uncertain success rather than retrying a mutation.

The extension invokes `git` and `gt` directly with argument arrays. It never constructs a shell
command. Abort signals terminate child processes, and Graphite operations are serialized per
repository inside the extension process.

## Repository detection and cache

Every tool call first resolves the Git worktree. On the first call for a repository, the extension verifies:

1. The working directory belongs to a Git worktree with absolute repository paths.
2. `gt --version` returns the supported version, 1.8.6.
3. `gt trunk --no-interactive` returns a valid, existing local trunk branch.

A cached capability is reused only after the recorded trunk is confirmed to still exist locally; a
renamed or deleted trunk makes detection run again. After success it writes:

```text
<absolute-git-dir>/pi-graphite.json
```

The file contains `usesGraphite: true`, the repository root, Graphite CLI version, trunk, and
verification time. It lives in Git's administrative directory, so it does not modify tracked files.
Malformed, incompatible, future-dated, and older-than-24-hours data is ignored and detected again.
The in-memory positive cache expires at the same deadline.

Only successful detection is persisted. A plain Git repository is checked again after `gt init`,
and a missing CLI can start working immediately after installation. If Git metadata is read-only,
Graphite operations still work and the tool result reports that the persistent cache could not be
written.

## Install

Local development:

```bash
pnpm install
pnpm build
pi install /absolute/path/to/pi-graphite
omp plugin link /absolute/path/to/pi-graphite
```

Published package:

```bash
pi install npm:@mcuste/pi-graphite
omp plugin install @mcuste/pi-graphite
```

The package ships one compiled ESM entry point and declares it in both manifests:

```json
{
  "omp": {
    "extensions": ["./dist/index.js"]
  },
  "pi": {
    "extensions": ["./dist/index.js"]
  }
}
```

Tool schemas use TypeBox, which both hosts accept. The compiled extension has no runtime import from either host's differently named TypeScript API package.

## Develop and verify

Run the complete local gate:

```bash
pnpm check
```

It runs Biome formatting and lint checks, builds and validates the published package, executes the
deterministic suite and the real Git and Graphite integration suite, finds unused code and
dependencies with Knip, and audits dependencies for high-severity advisories. CI runs the same gate
with Graphite CLI 1.8.6 pinned in `devDependencies`.

Use the focused commands while developing:

```bash
pnpm fix               # Apply safe Biome formatting, import, and lint fixes
pnpm quality           # Check formatting, imports, and lint rules
pnpm test              # Build, then run the deterministic suite
pnpm test:integration  # Build, then run the real Git and Graphite scenario
pnpm deadcode          # Find unused files, exports, and dependencies
pnpm package:check     # Build and validate the publishable package
pnpm security          # Audit dependencies for high-severity advisories
```

The integration test creates an isolated Git repository and exercises every inspection target,
exact checkout, staged-only create, commit, amend, squash, fold, rename, delete, move, effective
restacking, conflict abort, and conflict continue.
Remote operations are deliberately excluded from the tool because the fixture cannot make external
state or credentials deterministic.

## References

- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [OMP extension authoring](https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md)
- [Graphite CLI](https://graphite.com/docs/graphite-cli)
