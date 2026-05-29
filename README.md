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
npm run crawl:default
```

That initializes a runnable project with local `README.md`, `package.json`, and `config/` files, installs the core crawler and official jobs, and adds pass-through `crawl` / `crawl:src` scripts plus default starter scripts.

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

## Package Boundaries

`@arachnodex/core` provides the crawler runtime, shared APIs, and the `arachnodex` CLI. It does not bundle official jobs.

Job handles such as `sitemap` and `link-issues` are shorthand import names. They resolve to `@arachnodex/job-sitemap` and `@arachnodex/job-link-issues`, but those packages must be installed in the current local project or in the same global environment as the CLI.

`npm create @arachnodex` installs the default official jobs for generated projects. Manual and global installs should add whichever official or third-party job packages they plan to run.

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

Projects created with `npm create @arachnodex` include a default starter script:

```sh
npm run crawl:default
```

They also include a pass-through `crawl` script for custom runs. Put crawler arguments after `--` so npm forwards them:

```sh
npm run crawl -- -c default -j sitemap
```

Generated projects also include a source-mode runner for custom job development:

```sh
npm run crawl:src -- -c default -j sitemap -j link-issues
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

## Core Config Settings

Core crawler config files live in `config/`. The default run loads:

```text
config/default.json
```

Projects created with `npm create @arachnodex` start from the core example config and copy it into:

```text
config/default.example.json
config/default.json
```

Full example:

```json
{
  "siteName": "Example Site",
  "domain": "example.com",
  "baseUrl": "https://www.example.com",
  "pathPrefix": "",
  "entryFile": "",
  "dontResetUrls": false,
  "numThreads": 10,
  "requestDelayMs": 0,
  "requestTimeoutMs": 30000,
  "requestTimeoutMaxRetries": 3,
  "requestTls": {
    "rejectUnauthorized": true
  },
  "muteResponseStatus": false,
  "muteAll": false,
  "disableColorOutput": false,
  "urlCantContain": [],
  "urlMustContain": [],
  "treatHashAsUniquePage": false,
  "mail": {
    "disabled": true,
    "defaultSubject": "Arachnodex {{domain}} Report [{{jobs}}]",
    "developerRecipients": [],
    "reportRecipients": [],
    "errorRecipients": [],
    "from": {
      "Arachnodex Spider": "noreply@example.com"
    },
    "replyTo": [],
    "transport": {
      "host": "127.0.0.1",
      "port": "1025",
      "secure": false
    }
  }
}
```

### Site Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `siteName` | string | `""` | Human-readable site name used in reports. |
| `domain` | string | `""` | Canonical hostname without `www.`. For example, use `example.com`, not `www.example.com`. |
| `baseUrl` | string | `""` | Root crawl URL. Must be a valid `http://` or `https://` URL with no path, query string, or hash. The hostname must match `domain`, allowing only an optional leading `www.`. |
| `pathPrefix` | string | `""` | Optional path prefix for crawls that should stay under a subdirectory. When set, Arachnodex also requires discovered URLs to contain the configured domain plus this prefix. |
| `entryFile` | string | `""` | Optional entry path appended after `baseUrl` and `pathPrefix` for the first URL queued by the crawler. |
| `dontResetUrls` | boolean | `false` | Leave internal URLs on their discovered protocol and host instead of normalizing them back to `baseUrl`. Most projects should keep this `false`. |

### Crawl Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `numThreads` | number | `10` | Maximum number of concurrent crawler workers. Values lower than `1` are treated as `1`. |
| `requestDelayMs` | number | `0` | Delay in milliseconds before crawler requests. |
| `requestTimeoutMs` | number | `30000` | Per-request timeout in milliseconds. |
| `requestTimeoutMaxRetries` | number | `3` | Maximum retry attempts for timeout failures. |
| `requestTls.rejectUnauthorized` | boolean | `true` | Verify HTTPS certificates for crawler requests and job requests that use the core request TLS setting. Set to `false` only when intentionally crawling a site with an invalid certificate. |
| `treatHashAsUniquePage` | boolean | `false` | Keep URL fragments as part of the crawled URL identity. By default, fragments are stripped so `/page#one` and `/page#two` are treated as the same page. |

### Filtering Settings

`urlCantContain` and `urlMustContain` are arrays of regular expression strings.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `urlCantContain` | string[] | `[]` | Reject discovered URLs that match any listed pattern. |
| `urlMustContain` | string[] | `[]` | Reject discovered URLs unless every listed pattern matches. |

### Output Settings

These values can be set in config or overridden by core switches.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `muteResponseStatus` | boolean | `false` | Mute crawler response status output. Job output and errors still print. |
| `muteAll` | boolean | `false` | Mute all non-error output, including job output. |
| `disableColorOutput` | boolean | `false` | Disable ANSI color output. |

### Mail Settings

Mail is disabled by default. Enable it by setting `mail.disabled` to `false` and configuring recipients plus transport settings.

Recipient lists accept email strings or name-to-email maps:

```json
[
  "rick@example.com",
  {"Jane Developer": "jane@example.com"}
]
```

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `mail.disabled` | boolean | `true` | Disable regular and error report emails. |
| `mail.defaultSubject` | string | `"Arachnodex {{domain}} Report [{{jobs}}]"` | Subject template for report emails. Supports `{{domain}}` and `{{jobs}}`. |
| `mail.developerRecipients` | `(string \| object)[]` | `[]` | Developer recipients that can receive crawler reports. |
| `mail.reportRecipients` | `(string \| object)[]` | `[]` | Recipients for regular completion reports. |
| `mail.errorRecipients` | `(string \| object)[]` | `[]` | Recipients for accumulated error reports. |
| `mail.from` | `string \| object` | `{}` | Sender email string or name-to-email map. |
| `mail.replyTo` | `(string \| object)[]` | `[]` | Reply-to email strings or recipient maps. |

Mail transport settings are passed to Nodemailer.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `mail.transport.host` | string | `""` | SMTP host. |
| `mail.transport.port` | number or string | `465` | SMTP port. |
| `mail.transport.secure` | boolean | `true` | Use TLS for the SMTP connection. Local Mailpit/MailHog setups commonly use `false`. |
| `mail.transport.auth.username` | string | `""` | Optional SMTP username. |
| `mail.transport.auth.password` | string | `""` | Optional SMTP password. |
| `mail.transport.tls.rejectUnauthorized` | boolean | `true` | Verify SMTP TLS certificates when TLS is used. |

## Core Switches

Core switches may be used before the first job:

| Switch | Description |
| --- | --- |
| `-c <config-name>`, `--config=<config-name>` | Load `config/<config-name>.json`. Defaults to `default`; the `.json` suffix is optional. |
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

Official jobs are regular job packages. They install by default through the create workflow, and they can also be installed or updated individually.

### Sitemap

`@arachnodex/job-sitemap` writes an XML sitemap from crawlable internal URLs found during a crawl. It can include canonical HTML pages and optionally include document URLs such as PDFs.

Read the [Sitemap job README](packages/job-sitemap/README.md) for install notes, usage examples, switches, and full job config settings.

### Link Issues

`@arachnodex/job-link-issues` reports broken, malformed, non-canonical, insecure, placeholder, redirect, fragment, and optional external-link issues. External checks use the bot protection heuristics package to avoid false positives from common WAF, CAPTCHA, and browser-challenge responses.

Read the [Link Issues job README](packages/job-link-issues/README.md) for install notes, usage examples, switches, finding severities, bot-protection behavior, and full job config settings.

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
