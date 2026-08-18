# pi-graphite

`@mcuste/pi-graphite` is an installable extension for Pi and Oh My Pi (OMP). It exposes narrow, model-callable tools for local Graphite stack operations.

## Requirements

- Node.js 22 or newer
- Git
- The Graphite CLI (`gt`) for repositories that use the tools

The extension still loads when `gt` is absent or the current directory is not a Graphite repository. A Graphite tool call then fails with an actionable error instead of spawning an unsupported command.

## Tools

| Tool | Command | Approval | Safety |
| --- | --- | --- | --- |
| `graphite_inspect` | `gt log --stack`, `gt parent`, or `gt trunk` | `read` | Fixed operation enum |
| `graphite_restack` | `gt restack --branch <branch> --no-interactive` | `exec` | Clean worktree required |
| `graphite_create` | `gt create <name> -m <subject> -m <body> --no-interactive` | `exec` | Commits only already-staged changes |
| `graphite_move` | `gt move --source <source> --onto <onto> --no-interactive` | `exec` | Clean worktree required |

`graphite_create.name` is the requested name. Graphite may add the user's configured branch prefix. The result's `after.branch` field reports the actual local branch.

Branch values are checked with `git check-ref-format --branch` and cannot begin with `-`. Every mutation records the current branch, status, staged diff summary, unstaged diff summary, and Graphite stack before running. It verifies the worktree and stack again after success.

The extension invokes `git` and `gt` directly with argument arrays. It never constructs a shell command. Abort signals terminate child processes, and Graphite operations are serialized per repository.

Remote submission, sync, squash, force flags, bulk cleanup, and arbitrary Graphite commands are not exposed.

## Repository detection and cache

Every tool call first resolves the Git worktree. On the first call for a repository, the extension verifies:

1. The working directory belongs to a Git worktree.
2. `gt --version` succeeds.
3. `gt trunk --no-interactive` returns a configured trunk.

After success it writes:

```text
<absolute-git-dir>/pi-graphite.json
```

The file contains `usesGraphite: true`, the repository root, Graphite CLI version, trunk, and verification time. It lives in Git's administrative directory, so it does not modify tracked files. Later processes read this marker and skip the Graphite version and trunk probes. Each running extension instance also keeps an in-memory positive cache.

Only successful detection is persisted. A plain Git repository is checked again after `gt init`, and a missing CLI can start working immediately after installation. If Git metadata is read-only, Graphite operations still work and the tool result reports that the persistent cache could not be written.

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

The integration test creates an isolated Git repository, initializes Graphite, runs all four tools,
and verifies staged-only creation, worktree preservation, parent divergence, restacking, moving,
and the resulting stack.

## References

- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [OMP extension authoring](https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-extensions.md)
- [Graphite CLI](https://graphite.com/docs/graphite-cli)
