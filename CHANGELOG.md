# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Both host manifests now point at `src/index.ts`, so installs from npm, git, or a local path work
  without a build step.
- `typebox` moved from `dependencies` to `peerDependencies`; both hosts bundle it.

### Added

- MIT license, npm publication metadata, and a tag-triggered release workflow that publishes
  through npm trusted publishing (OIDC), with no long-lived token.
- Dependabot updates for GitHub Actions and development dependencies.
- Oh My Pi marketplace catalog at `.omp-plugin/marketplace.json`.
- Operations, safety, and development documentation under `docs/`.

## [0.1.0]

### Added

- Initial release: one `graphite` tool with `inspect`, `checkout`, `create`, `modify_commit`,
  `modify_amend`, `squash`, `fold`, `rename`, `move`, `restack`, `delete`, `continue`, and `abort`.
- Repository detection with an on-disk cache in Git's administrative directory.
- Deterministic test suites and a real Git and Graphite integration suite.
