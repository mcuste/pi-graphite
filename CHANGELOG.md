# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-19

### Added

- One `graphite` tool with `inspect`, `checkout`, `create`, `modify_commit`, `modify_amend`,
  `squash`, `fold`, `rename`, `move`, `restack`, `delete`, `continue`, and `abort`, each with
  preconditions and postconditions that verify the repository before and after Graphite runs.
- Repository detection with an on-disk cache in Git's administrative directory.
- Deterministic test suites and a real Git and Graphite integration suite.
- Operations, safety, and development documentation under `docs/`.
- Oh My Pi marketplace catalog at `.omp-plugin/marketplace.json`.
- Release workflow publishing through npm trusted publishing (OIDC), with no long-lived token,
  and Dependabot updates for GitHub Actions and development dependencies.

Published manually to create the package on npm, which trusted publishing cannot do. Every later
version is published by the release workflow.
