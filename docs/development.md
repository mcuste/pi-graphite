# Development and release

## Layout

| Path | Contents |
| --- | --- |
| `src/index.ts` | Extension entry point; both hosts load it directly |
| `src/tools.ts` | Tool schema, argument construction, pre- and postcondition checks |
| `src/branch.ts` | Branch name parsing and validation |
| `src/capability.ts` | Repository detection and the on-disk cache |
| `src/process.ts` | Child process execution |
| `test/` | Deterministic suites plus a real Git and Graphite integration suite |

Pi loads TypeScript through [jiti](https://github.com/unjs/jiti) and Oh My Pi runs it natively, so
`package.json` points both `pi.extensions` and `omp.extensions` at `src/index.ts` and no build step
is needed to install from npm, git, or a local path. The `dist/` build exists as a type check and
for anyone importing the package directly.

`typebox` is a peer dependency. Both hosts bundle it, and a second copy would hand the host a schema
it does not recognise.

## Commands

```bash
pnpm check             # Everything below, in one gate; also run by CI
pnpm fix               # Apply safe Biome formatting, import, and lint fixes
pnpm quality           # Check formatting, imports, and lint rules
pnpm test              # Build, then run the deterministic suite
pnpm test:integration  # Build, then run the real Git and Graphite scenario
pnpm deadcode          # Find unused files, exports, and dependencies with Knip
pnpm package:check     # Build and validate the publishable package with publint
pnpm security          # Audit dependencies for high-severity advisories
```

The integration suite creates an isolated Git repository and exercises every inspection target,
exact checkout, staged-only create, commit, amend, squash, fold, rename, delete, move, effective
restacking, conflict abort, and conflict continue. Remote operations are excluded because the
fixture cannot make external state or credentials deterministic.

CI pins Graphite CLI 1.8.6 through `devDependencies` and runs the same `pnpm check` gate.

## Testing against a real host

```bash
pi -e ./src/index.ts
omp -e ./src/index.ts
```

Or install the working copy:

```bash
pi install /absolute/path/to/pi-graphite
omp plugin link /absolute/path/to/pi-graphite
```

## Continuous integration

`.github/workflows/ci.yml` runs the full `pnpm check` gate on every push and pull request, with
Graphite CLI 1.8.6 pinned through `devDependencies`.

## Release

Releases are published by `.github/workflows/release.yml`, triggered by pushing a `v<version>` tag.
It runs as three jobs:

1. **verify** checks that the tag matches the version in `package.json`, then runs `pnpm check`.
2. **publish** publishes to npm. It runs in the `npm-publish` environment, so a protection rule there
   can require manual approval before anything is published.
3. **github-release** creates the GitHub release, using the matching `CHANGELOG.md` section as its
   notes.

To cut a release:

1. Update the version in `package.json` and move the `Unreleased` changelog entries under a
   `## [<version>]` heading.
2. Run `pnpm check`.
3. Commit, then tag `v<version>` and push the tag.

### npm authentication

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers): the job requests
an OIDC token from GitHub and exchanges it with npm for a short-lived credential. There is no
`NPM_TOKEN` secret to store or rotate, and npm attaches a provenance attestation automatically.

Two constraints shape the workflow:

- npm cannot create a package through trusted publishing, so the first version of a new package must
  be published manually with `npm login && pnpm publish --access public`. Configure the trusted
  publisher afterwards, on the package's npm settings page, pointing at this repository, the
  `release.yml` workflow, and the `npm-publish` environment.
- `actions/setup-node` before v7 wrote a placeholder auth token that made npm skip the OIDC exchange,
  so the workflow pins v7.

The publish job holds the OIDC token, so it is kept small: no dependency cache, and
`pnpm install --ignore-scripts` so no dependency lifecycle script runs beside the credential. The
test suite runs in the separate verify job, which has no token.

## Ecosystem listings

Publishing to npm is all either ecosystem needs:

- **Pi** lists any package carrying the `pi-package` keyword in its gallery at
  [pi.dev/packages](https://pi.dev/packages). There is no submission step.
- **Oh My Pi** installs npm packages directly with `omp plugin install`, and reads the catalog at
  `.omp-plugin/marketplace.json` in this repository for `/marketplace add mcuste/pi-graphite`. That
  catalog tracks the `main` branch; point its `ref` at a tag to pin marketplace users to releases.
