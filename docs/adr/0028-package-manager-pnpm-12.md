# ADR-0028: Pin pnpm 12.x via `packageManager`

- Status: Proposed
- Date: 2026-11-24
- Supersedes: [ADR-0002](./0002-package-manager-pnpm-pinned.md)

## Context

ADR-0002 pinned pnpm to the 10.x line. Every other repository on the
maintainer's machine now pins pnpm 12.18.0. pnpm keeps one content-addressable
store per store version, so mixed pnpm majors mean duplicate stores and
duplicate downloads. Aligning on one pnpm version lets every repository share
one store.

Moving from pnpm 10 to 12 changes how the project is configured:

- pnpm 11+ no longer reads settings from the `pnpm` field of `package.json`.
  The `overrides` that lived there would be silently dropped, and the lockfile
  would resolve `esbuild` and `vite` to newer versions.
- pnpm 11+ replaced `onlyBuiltDependencies` / `ignoredBuiltDependencies` with
  `allowBuilds`, and fails the install (`ERR_PNPM_IGNORED_BUILDS`) when a
  dependency has a build script that is neither allowed nor denied.
- pnpm 12 writes a leading "env lockfile" YAML document to `pnpm-lock.yaml`
  that records the pinned pnpm (`packageManagerDependencies`). The file is now
  a two-document YAML stream; `--frozen-lockfile` fails if that document is
  missing or stale.
- pnpm 11+ applies a built-in, non-strict `minimumReleaseAge` of 1440 minutes
  (ADR-0002's main reason for staying on 10.x).

## Decision

Pin `packageManager` to `pnpm@12.18.0` plus its integrity hash. CI still
derives pnpm from this field (`pnpm/action-setup` with no `version:`).

- `overrides` move to `pnpm-workspace.yaml`, unchanged.
- `allowBuilds` in `pnpm-workspace.yaml` denies `esbuild` (its postinstall only
  fetches the platform binary its `@esbuild/*` optional dependency already
  provides; pnpm 10 skipped it too) and keeps the old `unrs-resolver` denial.
- The `minimumReleaseAge` default is left as pnpm ships it.
- The dependency section of the lockfile (`lockfileVersion: 9.0`) is unchanged
  by the upgrade; only the env lockfile document is added in front of it.

## Consequences

- One pnpm version and one store across the maintainer's repositories.
- Lockfile tooling that parses `pnpm-lock.yaml` must accept a multi-document
  YAML stream. `scripts/check-lockfile.sh` does; the shared
  `kornsour/gh-automation` lockfile checks must too.
- Running pnpm 10 against this repository no longer works; use
  `corepack enable` so local pnpm matches the pin.
- Fresh releases younger than a day are subject to pnpm's non-strict cooldown.
  If that gets in Dependabot's way, set `minimumReleaseAge` explicitly in a
  follow-up.
