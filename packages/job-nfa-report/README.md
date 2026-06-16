# @arachnodex/job-nfa-report

The NFA Report job reports non-fingerprinted asset, media, and document references found during an Arachnodex crawl.

NFA is short for "non-fingerprinted assets." The job is intended for cache-busting audits where long-lived public files should include a build/content fingerprint in the filename or an approved query-string cache-bust value.

## Install

Projects created with `npm create @arachnodex` include this job by default. For a manual install, add it beside `@arachnodex/core`:

```sh
npm install @arachnodex/job-nfa-report
```

The package uses `@arachnodex/core` as a peer dependency, so it should be installed in the same project as the crawler.

## Usage

Run the job with the default crawler config:

```sh
npm exec -- arachnodex -c default -j nfa-report
```

Print findings as they are discovered:

```sh
npm exec -- arachnodex -c default -j nfa-report -v
```

Also scan same-site CSS and JavaScript bodies for nested asset references:

```sh
npm exec -- arachnodex -c default -j nfa-report -n
```

Use both real-time output and nested scanning:

```sh
npm exec -- arachnodex -c default -j nfa-report -v -n
```

Run it with copy/paste prompt output:

```sh
npm exec -- arachnodex -c default -j nfa-report -p
```

Use a job-specific config by placing `-c` after the job name:

```sh
npm exec -- arachnodex -c default -j nfa-report -c nfa-report
```

That loads the crawler config from `config/default.json` and the NFA Report job config from `config/nfa-report.json`.

## Config File

The package example config is available at:

```text
config/nfa-report.example.json
```

A generated Arachnodex project copies this to:

```text
config/nfa-report.json
```

For a manual install, copy the example into your Arachnodex project's `config/` directory as `nfa-report.json` when you want to customize the job settings. The job can run with built-in defaults if no job config file exists.

Default config:

```json
{
  "emailReportEnabled": true,
  "limitMail": true,
  "verbose": false,
  "nested": false,
  "viteRollupFingerprintCompatibility": true,
  "fingerprintPattern": "[A-Za-z0-9]{8,}",
  "fingerprintSeparatorPattern": "\\.",
  "ignorePatterns": [],
  "qsProps": {
    "cb": "^\\d{10,}$",
    "t": "^\\d{10,}$",
    "ts": "^\\d{10,}$",
    "v": "^(?:\\d{8,}|[A-Za-z0-9._-]{8,})$",
    "ver": "^(?:\\d{8,}|[A-Za-z0-9._-]{8,})$",
    "version": "^(?:\\d{8,}|[A-Za-z0-9._-]{8,})$"
  },
  "assetExtensions": [
    "css",
    "js",
    "mjs",
    "woff",
    "woff2",
    "ttf",
    "otf",
    "eot",
    "ico",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "avif",
    "svg",
    "webmanifest",
    "map"
  ],
  "mediaExtensions": [
    "mp4",
    "webm",
    "mov",
    "m4v",
    "mp3",
    "wav",
    "ogg",
    "vtt"
  ],
  "documentExtensions": [
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "csv",
    "zip"
  ]
}
```

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `emailReportEnabled` | boolean | `true` | Include the NFA Report job in Arachnodex report emails. |
| `limitMail` | boolean | `true` | Suppress this job's regular email report when no non-fingerprinted references were found. |
| `verbose` | boolean | `false` | Print each unique finding as it is discovered. Can be enabled for one run with `-v` / `--verbose`. Core quiet mode still suppresses this output. |
| `nested` | boolean | `false` | Scan same-site CSS and JavaScript bodies for nested asset references. Can be enabled for one run with `-n` / `--nested`. |
| `viteRollupFingerprintCompatibility` | boolean | `true` | Accept Vite/Rollup default `name-[hash].ext` assets when the final dash segment is exactly eight URL-safe hash characters and looks hash-like. Disable this for strict separator-only fingerprint detection. |
| `fingerprintPattern` | string | `"[A-Za-z0-9]{8,}"` | Regular expression used to identify a valid hash segment inside a filename stem. The job anchors this pattern to the full segment. |
| `fingerprintSeparatorPattern` | string | `"\\."` | Regular expression used to identify the separator before the filename hash segment. Defaults to a literal dot. Use a character class such as `"[._-]"` to accept multiple custom separator characters. |
| `ignorePatterns` | string[] | `[]` | URL regular expressions to suppress findings that would otherwise be reported. |
| `qsProps` | object | common cache-bust params | Map of query-string property names to regular expressions. When a URL has a matching property and value, the URL is treated as fingerprinted. |
| `assetExtensions` | string[] | CSS, JS, fonts, images, manifest, map | File extensions treated as normal asset references. Extensions may be written with or without a leading dot. |
| `mediaExtensions` | string[] | common audio/video/caption files | File extensions treated as media references. |
| `documentExtensions` | string[] | common office/document/archive files | File extensions treated as document references. |

## Fingerprint Rules

A URL is accepted as fingerprinted when either the filename or query string proves cache busting.

Filename fingerprints must be the final separated segment before the extension: `name<separator><hash>.<ext>`. By default the configured separator is a literal dot, so the configured shape is `name.<hash>.<ext>`. The default `fingerprintPattern` accepts alphanumeric hash segments of eight or more characters. This avoids treating ordinary words in one-dot filenames like `Products` in `catalog-products-tds_60882.pdf` as fingerprints because they are not in the configured hash-separator position.

Vite and Rollup commonly emit assets as `name-[hash].ext` with an eight-character URL-safe base64 hash. When `viteRollupFingerprintCompatibility` is enabled, those default bundler assets are accepted when the final dash segment is exactly eight URL-safe hash characters and looks hash-like. Plain hyphenated asset names such as `product-selector.css` are still reported.

Accepted examples:

```text
/assets/app.2f4a9c0e.css
/assets/runtime.9A7b6C5d.js
/assets/app-2f4a9c0e.css
/assets/admin-panel-Ab-cdE1F.css
```

To also accept broader custom dash or underscore hash separators, configure:

```json
{
  "fingerprintSeparatorPattern": "[._-]"
}
```

With that setting, `/assets/app-2f4a9c0e.css` and `/assets/runtime_9A7b6C5d.js` are treated as fingerprinted.

Rejected by default examples:

```text
/assets/app.css
/assets/2f4a9c0e.css
/assets/app2f4a9c0e.css
/assets/app-2f4a9c0e.css
/assets/runtime_9A7b6C5d.js
```

The second rejected example is only a hash plus extension. The job requires at least one other filename segment before the configured hash separator so reports stay focused on real named assets with build fingerprints.

Query-string cache busting is controlled by `qsProps`. For example, the default config treats these as valid:

```text
/assets/app.css?cb=1718048501
/assets/app.css?v=1718048501
/assets/app.css?v=20240610
/assets/app.css?version=2f4a9c0e
```

Use tighter project-specific patterns if your site has query parameters that look like versions but are not actually cache-bust values.

## Scan Coverage

The job scans references found in crawled page markup, including:

- Scripts, stylesheets, preloads, icons, manifests, and regular `<link>` references.
- Images, `srcset` candidates, SVG image/use references, inline styles, and `<style>` blocks.
- Video, audio, sources, posters, tracks, iframes, embeds, and objects.
- Open Graph, Twitter, and Microsoft tile image/video metadata.
- Anchor links to configured asset, media, or document file extensions.

The job validates only URLs whose extension appears in `assetExtensions`, `mediaExtensions`, or `documentExtensions`. Other URLs are ignored.

## Nested CSS And JavaScript

Nested scanning is disabled by default. Enable it with config `nested: true` or the job switch:

```sh
npm exec -- arachnodex -c default -j nfa-report -n
```

When enabled, the job downloads same-site CSS, JS, and MJS files already referenced by crawled pages or nested files. It then scans:

- CSS `url(...)`
- CSS `@import`
- CSS and JS `sourceMappingURL` comments
- Conservative JavaScript asset string literals

JavaScript scanning intentionally avoids ordinary relative `.js` / `.mjs` module specifiers, template strings with interpolation, string concatenation, JSON-like broad parsing, and arbitrary library internals. The goal is to catch asset URLs, not every import path or runtime string.

Nested fetches are private to this job. They do not add URLs to the shared crawler queue and they do not perform availability reporting.

## Ignore Patterns

Use `ignorePatterns` for references that are expected to remain unfingerprinted, such as third-party URLs, CMS-managed files, or endpoint-style document downloads.

```json
{
  "ignorePatterns": [
    "^https://cdn\\.example\\.com/vendor/",
    "^/downloads/dynamic-report\\.pdf(?:[?#].*)?$"
  ]
}
```

Patterns are tested against the raw value, absolute URL, path plus query string, path only, and decoded path variants.

## Output

The console report groups findings by asset, media, and document references. Each entry includes the normalized URL, occurrence count, reference kinds, and sample source URLs.

Verbose mode prints each unique finding as it is discovered:

```sh
npm exec -- arachnodex -c default -j nfa-report -v
```

Report emails include summary counts and grouped finding details. When `limitMail` is `true`, the job suppresses its regular email report if there are no findings.

## Switches

| Switch | Description |
| --- | --- |
| `-V`, `--version` | Print the NFA Report job version and exit without crawling. |
| `-v`, `--verbose` | Print unique findings in real time. Core quiet mode suppresses this output. |
| `-n`, `--nested` | Scan same-site CSS and JavaScript bodies for nested asset references. |
| `-p`, `--prompt` | Output grouped findings as copy/paste prompts for another coding agent. |
