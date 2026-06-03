# @arachnodex/job-link-issues

The Link Issues job reports broken, malformed, non-canonical, insecure, placeholder, redirect, fragment, and optional external-link issues found during an Arachnodex crawl.

It is intended for site cleanup work where grouped, actionable findings are more useful than a raw list of every repeated link occurrence.

## Install

Projects created with `npm create @arachnodex` include this job by default. For a manual install, add it beside `@arachnodex/core`:

```sh
npm install @arachnodex/job-link-issues
```

The package uses `@arachnodex/core` as a peer dependency, so it should be installed in the same project as the crawler.

## Usage

Run the job with the default crawler config:

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

When available, console reports, email reports, and prompt output include an
`Anchor HTML` detail with the offending `<a>` element. Anchors with small inner
HTML are shown exactly; anchors with inner HTML over 128 bytes keep the real
opening/closing anchor tag but replace the body with a bracketed rendered
text/image summary marked as trimmed. This gives patching agents a concrete
snippet to search for without flooding reports with large nested markup.

Use a job-specific config by placing `-c` after the job name:

```sh
npm exec -- arachnodex -c default -j link-issues -c link-issues
```

That loads the crawler config from `config/default.json` and the Link Issues job config from `config/link-issues.json`.

## Config File

The package example config is available at:

```text
config/link-issues.example.json
```

A generated Arachnodex project copies this to:

```text
config/link-issues.json
```

For a manual install, copy the example into your Arachnodex project's `config/` directory as `link-issues.json` when you want to customize the job settings. The job can run with built-in defaults if no job config file exists.

Default config:

```json
{
  "emailReportEnabled": true,
  "emailReportTriggerLevels": ["error", "warning", "notice"],
  "undesirablePathCharacterPattern": "[^\\w\\-/.]",
  "allowedNonCanonicalLinks": [],
  "ignoredCanonicalQueryVariantPatterns": []
}
```

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `emailReportEnabled` | boolean | `true` | Include the Link Issues job report in Arachnodex report emails. |
| `emailReportTriggerLevels` | array or `null` | `["error", "warning", "notice"]` | Severity levels that are allowed to trigger the email report. Valid values are `error`, `warning`, and `notice`. Set to `null` or an empty array to allow the report whenever the job has findings. |
| `undesirablePathCharacterPattern` | string | `"[^\\w\\-/.]"` | Regular expression used against decoded internal URL paths. Matching paths create notice-level URL path quality findings. |
| `allowedNonCanonicalLinks` | string[] | `[]` | Path allowlist for internal pages that may point to a different canonical URL without being reported. Entries are compared after the configured `baseUrl` is removed from the normalized canonical target. |
| `ignoredCanonicalQueryVariantPatterns` | string[] | `[]` | Regular expression patterns for query-string URL variants that should not create notice-level canonical query variant findings. Patterns are tested against the normalized full URL and the path/query form, such as `^https://www.example.com/\\?catalog-request$` or `^/\\?catalog-request$`. |

Internal links whose only canonical mismatch is the query string are reported as
notices, not warnings. This catches links such as `/?catalog-request` when the
page canonical is `/`, while still treating path, host, and protocol canonical
mismatches as warnings. Use `ignoredCanonicalQueryVariantPatterns` for known
query-driven UI states, campaign parameters, modal triggers, or action flags
that should stay out of notice output.

## Finding Severity

The job uses three severity levels:

| Severity | Meaning |
| --- | --- |
| `error` | Broken or unsafe behavior that usually needs correction. |
| `warning` | Risky, unexpected, or SEO-relevant behavior that may be intentional but should be reviewed. |
| `notice` | Lower-priority cleanup and quality findings. Notice output is hidden unless `-n` is used. |

## External Links And Bot Protection

External link checks are disabled by default. Enable them with `-e`:

```sh
npm exec -- arachnodex -c default -j link-issues -e
```

The `-e` switch only controls network verification of external URLs. External
anchors can still appear in the report without `-e` when they trigger regular
anchor hygiene findings, such as malformed hrefs, unsafe protocols, or
`target="_blank"` links missing `rel="noopener"`/`rel="noreferrer"`.

When external checks are enabled, the job uses the `@arachnodex/bot-protection-heuristics` package through `@arachnodex/core` to recognize common WAF, CAPTCHA, and browser-challenge responses. Those responses are treated as inconclusive instead of broken because many third-party sites block automated HEAD or GET checks while still serving normal browsers.

Crawler TLS behavior for external HTTPS checks follows the core `requestTls.rejectUnauthorized` setting.

## Switches

| Switch | Description |
| --- | --- |
| `-V`, `--version` | Print the Link Issues job version and exit without crawling. |
| `-n`, `--include-notices` | Include notice-level findings. By default, only errors and warnings render. |
| `-e`, `--include-external` | Check external links using HEAD requests with limited fallback behavior. This does not disable normal anchor hygiene reporting for external hrefs when omitted. |
| `-p`, `--prompt` | Output grouped findings as copy/paste prompts for another coding agent. |
