# Contributing to Arachnodex

Thanks for taking the time to improve Arachnodex. This repo is a small npm-workspace monorepo, so most contributions should stay focused on one package unless the change truly crosses package boundaries.

## Repository Layout

Arachnodex packages live under `packages/`:

- `packages/core` - crawler runtime, shared APIs, and the `arachnodex` CLI.
- `packages/create` - initializer used by `npm create @arachnodex`.
- `packages/job-link-issues` - link issue reporting job.
- `packages/job-sitemap` - sitemap generation job.
- `packages/bot-protection-heuristics` - reusable bot/WAF challenge detection data used by `job-link-issues` to avoid false broken-link reports when external sites return crawler challenges.

Each package is published independently, but related changes belong in one pull request when they need to land together.

## Fork And Pull Request Flow

1. Fork `Arachnodex/arachnodex`.
2. Clone your fork locally.
3. Create a branch with a short, descriptive name.
4. Make the smallest useful change for the package or behavior you are working on.
5. Run the checks listed in the Checks section before opening a pull request.
6. Open a pull request against the main Arachnodex repo.

If your change only affects one package, say that clearly in the pull request title or description. For example:

```text
job-link-issues: improve external redirect reporting
```

If your change touches shared behavior in `packages/core`, mention which downstream packages or jobs you tested.

## Local Setup

After cloning, use the Node version pinned for the repo and install dependencies:

```sh
nvm use
npm install
```

If you do not use nvm, install a Node version that satisfies the root `package.json` engines field.

## Working With Packages

Prefer package-scoped changes. A fix to the sitemap job should usually stay in `packages/job-sitemap`. A new crawler API belongs in `packages/core`, and the job using that API should be updated in the same PR only when needed.

Jobs should import public APIs from `@arachnodex/core`, not private files inside the core package. Shared standalone data or behavior that should be updateable independently can be its own package, like `@arachnodex/bot-protection-heuristics`.

Published package metadata should use normal semver dependency ranges. Avoid committing local `file:` dependencies for packages that are meant to be published.

## Build Output

Packages build to `bin/index.js`. Before opening a PR, rebuild any package whose source changed:

```sh
npm run build --workspaces --if-present
```

The built `bin/` files are part of the package surface, so keep them in sync with source changes.

## Checks

Run these from the repo root before submitting:

```sh
npm run check
```

That runs the package builds, TypeScript checks, ESLint, whitespace checks, and the built-file diff check that makes sure `bin/index.js` output was committed when source changed.

If a check fails because of something unrelated to your change, call that out in the pull request. Otherwise, please fix it before asking for review.

## Pull Request Notes

A good pull request explains:

- What changed.
- Why it changed.
- Which package or packages are affected.
- What checks you ran.

Screenshots are not usually needed for this project. Clear terminal output or a short before/after example is more useful when the change affects CLI behavior or report output.

## Code Style

Arachnodex uses TypeScript, ESM packages, strict type checking, and ESLint. Match nearby code style, keep changes direct, and avoid broad refactors inside feature or bugfix PRs.

Use public package imports where possible. Keep package boundaries boring and predictable; future contributors should be able to tell where a change belongs without reading half the repo first.

## Dependency Changes

Dependency updates are welcome when they are needed for the change. Please keep them scoped and explain why they are necessary. For new runtime dependencies, prefer small, maintained packages with clear value over adding a large dependency for a narrow helper.

## Issue Reports

When reporting a bug, include:

- The command you ran.
- The package or job involved.
- The relevant config shape, with secrets removed.
- The observed output.
- What you expected to happen.

Small reproduction cases are deeply appreciated.
