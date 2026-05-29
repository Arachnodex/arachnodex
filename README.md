# Arachnodex

Arachnodex is a modular Node.js web crawler framework. It spiders a configured site, parses page data, and runs one or more installed jobs during the crawl.

The create workflow installs the core crawler, a sitemap job, a link issue reporting job, and a small bot protection heuristics package that can be updated independently.

## Requirements

- Node.js `22.13.0` or newer, including Node 24.
- npm `11.13.0` or compatible.

The repo includes an `.nvmrc` for contributors who use nvm. CI checks Node 22 and Node 24 so changes stay compatible with the supported range.

## Custom Jobs

Arachnodex can load your own job packages in addition to the official jobs. A job is an npm package with a default class export. Official shorthand such as `-j sitemap` resolves to `@arachnodex/job-sitemap`, while third-party scoped packages can be loaded by their full package name.

Custom jobs can be published to npm, installed from a private registry, or installed from a local filesystem path while you are developing private code.

For active job development, Arachnodex also supports a TypeScript source runner so you can iterate without rebuilding `bin/index.js` after every edit.

Read [CUSTOM-JOBS.md](CUSTOM-JOBS.md) for job package structure, lifecycle hooks, command switches, config files, source-mode development, and install options.

For a list of third-party custom jobs, check out the [Third-Party Job Registry](JOB-REGISTRY.md).

## Install

The recommended path is the create command:

```sh
npm create @arachnodex my-crawl-project
cd my-crawl-project
npm run crawl
```

That initializes a runnable project with local `package.json`, `config/`, `src/`, and `bin/` directories, installs the core crawler and official jobs, and adds `crawl` and `crawl:src` scripts.

You can skip automatic install if you want to inspect or edit files first:

```sh
npm create @arachnodex my-crawl-project -- --no-install
cd my-crawl-project
npm install
```

You can also install the CLI globally:

```sh
npm install -g @arachnodex/core
npm install -g @arachnodex/job-sitemap @arachnodex/job-link-issues
arachnodex -c default -j sitemap -j link-issues
```

The global install works for the core CLI, but core does not include job packages. Install the jobs you want alongside it so shorthand names such as `sitemap` and `link-issues` can resolve.

For project work, prefer the create command or a local project install so config, job versions, and output files live with the site audit project.

For a minimal manual local install, add core and only the jobs you need:

```sh
npm install @arachnodex/core
npm install @arachnodex/job-sitemap
npm exec -- arachnodex -c default -j sitemap
```

## Basic Usage

Arachnodex reads JSON config files from `config/`. The default crawler config is:

```text
config/default.json
```

A minimal config looks like this:

```json
{
  "siteName": "Example Site",
  "domain": "example.com",
  "baseUrl": "https://www.example.com",
  "numThreads": 10,
  "mail": {
    "disabled": true
  }
}
```

Crawler HTTPS certificate verification is enabled by default. If you intentionally need to crawl a staging or client site with an invalid certificate, opt out in config:

```json
{
  "requestTls": {
    "rejectUnauthorized": false
  }
}
```

Projects created with `npm create @arachnodex` include a local `crawl` script:

```sh
npm run crawl
```

Generated projects also include a source-mode runner for custom job development:

```sh
npm run crawl:src
```

In this monorepo, use the root `crawl-dev` script for the same source-mode workflow:

```sh
npm run crawl-dev -- -j link-issues -n -e -p
```

`crawl-dev` wraps `npm --workspace @arachnodex/core run crawl:src --`, so anything after `--` is passed through to the crawler. The underlying `crawl:src` script uses `tsx` and Node's `development` export condition to run core and compatible job packages from TypeScript source instead of their built `bin/` files.

For local installs, run custom commands through npm so it can find the local `node_modules/.bin/arachnodex` executable:

```sh
npm exec -- arachnodex -c default -j sitemap
```

Bare `arachnodex ...` commands are intended for global installs.

Run one job:

```sh
npm exec -- arachnodex -c default -j sitemap
```

Run multiple jobs in one crawl:

```sh
npm exec -- arachnodex -c default -j sitemap -j link-issues
```

Pass switches to a specific job by placing them after that job name and before the next `-j`:

```sh
npm exec -- arachnodex -c default -j sitemap -j link-issues -e -n
```

In that example, `-e` and `-n` belong to `link-issues`.

Use a non-default crawler config:

```sh
npm exec -- arachnodex -c staging -j sitemap
```

That loads:

```text
config/staging.json
```

Use a job-specific config by placing `-c` after the job name:

```sh
npm exec -- arachnodex -c default -j link-issues -c link-issues
```

That loads the crawler config from `config/default.json` and the link issue job config from `config/link-issues.json`.

## Core Switches

Core switches may be used before the first job:

| Switch | Description |
| --- | --- |
| `-c <config-name>`, `--config=<config-name>` | Load `config/<config-name>.json`. Defaults to `default`. |
| `-j <job-name\|package>`, `--job=<job-name\|package>` | Run an installed job package. `-j sitemap` loads `@arachnodex/job-sitemap`; `-j @scope/job-name` loads that exact scoped package; `-j npm:package-name` loads an exact unscoped package. |
| `-h`, `--help` | Display help. Use after a job name for that job's help. |
| `-m`, `--mute-status` | Mute crawler response status output. Job output and errors still print. |
| `-mm`, `--mute-all` | Mute all non-error output, including job output. |
| `-nc`, `--no-color` | Disable ANSI color output. |
| `-nm`, `--no-mail` | Disable regular and error email reports for the run. |
| `-t <count>`, `--threads=<count>` | Set the maximum worker thread count. |
| `-v`, `--verbose` | Show summary crawl statistics at the end. |
| `-vv` | Show full URL lists in crawl statistics. |
| `-vvv` | Show sorted full URL lists in crawl statistics. |
| `-p`, `--profile` | Print profiler milestones. |
| `--test-report-email` | Render and send a test report email without crawling. |

## Official Jobs

### Sitemap

Package:

```text
@arachnodex/job-sitemap
```

Run it:

```sh
npm exec -- arachnodex -c default -j sitemap
```

The sitemap job writes a sitemap from crawlable internal URLs found during the crawl. Its example config is:

```json
{
  "includeOnlyCanonical": true,
  "includeDocs": true,
  "emailReportEnabled": true,
  "outputFile": "../web/sitemap.xml",
  "includeDocPattern": "((x-)?pdf)|(ms-?excel)|(vnd.)|(ms-?word)|(ms-?powerpoint)|(ms-?access)|(download)"
}
```

`outputFile` is resolved from the Arachnodex project directory where you run the crawler. The default assumes a sibling website document root at `../web`, so a project at `site-audit/` writes the public sitemap to `web/sitemap.xml` beside it.

Sitemap job switch:

| Switch | Description |
| --- | --- |
| `-v`, `--version` | Print the Sitemap job version and exit without crawling. |

### Link Issues

Package:

```text
@arachnodex/job-link-issues
```

Run it:

```sh
npm exec -- arachnodex -c default -j link-issues
```

Run it with external link checks and notice-level findings:

```sh
npm exec -- arachnodex -c default -j link-issues -e -n
```

Run it with copy/paste prompt output:

```sh
npm exec -- arachnodex -c default -j link-issues -p
```

The link issue job reports broken, malformed, non-canonical, insecure, placeholder, redirect, fragment, and optional external-link issues. When external checks are enabled with `-e`, it uses the bot protection heuristics package to recognize common WAF, CAPTCHA, and browser-challenge responses. Those responses are treated as inconclusive instead of broken because many third-party sites block automated HEAD/GET checks while still serving normal browsers.

Its example config is:

```json
{
  "emailReportEnabled": true,
  "emailReportTriggerLevels": ["error", "warning", "notice"],
  "undesirablePathCharacterPattern": "[^\\w\\-/.]",
  "allowedNonCanonicalLinks": []
}
```

Link issue job switches:

| Switch | Description |
| --- | --- |
| `-V`, `--version` | Print the Link Issues job version and exit without crawling. |
| `-n`, `--include-notices` | Include notice-level findings. By default, only errors and warnings render. |
| `-e`, `--include-external` | Check external links using HEAD requests with limited fallback behavior. |
| `-p`, `--prompt` | Output grouped findings as copy/paste prompts for another coding agent. |

## Updating Individual Packages

Arachnodex is designed as a set of independently published npm packages. You can update the core, jobs, or shared heuristic data separately when new versions are available.

Update the core:

```sh
npm install @arachnodex/core@latest
```

Update one job:

```sh
npm install @arachnodex/job-link-issues@latest
npm install @arachnodex/job-sitemap@latest
```

Update bot protection heuristics:

```sh
npm install @arachnodex/bot-protection-heuristics@latest
```

The job packages use `@arachnodex/core` as a peer dependency so npm can warn when a job expects a different core range. The bot protection heuristics package is a required dependency of core and is re-exported from `@arachnodex/core` for jobs that need it.

## Bot Protection Heuristics

Package:

```text
@arachnodex/bot-protection-heuristics
```

This package contains marker lists used to detect common bot protection, WAF, CAPTCHA, and challenge/interstitial responses.

The official `link-issues` job uses these markers during external-link audits. If an external URL returns something that looks like a bot challenge, the job skips the broken-link finding instead of reporting a false positive. That matters most for CDNs, WAF-protected sites, and services that reject crawler-style HEAD requests but still work in a browser.

Keeping the markers separate lets Arachnodex update bot-protection detection without requiring a full core crawler or job release. Updating `@arachnodex/bot-protection-heuristics` can improve how `link-issues` classifies those external responses.

The package exports:

```ts
import {
  botProtectionHeuristics,
  type BotProtectionHeuristics
} from "@arachnodex/bot-protection-heuristics";
```

Most users do not need to import it directly. Jobs can also consume the core re-export:

```ts
import {botProtectionHeuristics} from "@arachnodex/core";
```

## Contributing

Contributions are welcome. This repo is a monorepo, so focused package-specific pull requests are easiest to review.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the fork and pull request flow, package boundaries, build expectations, and required checks.
