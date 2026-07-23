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

Run it with asset checks:

```sh
npm exec -- arachnodex -c default -j link-issues -a
```

Add `-e` when you also want HEAD-only availability checks for external asset URLs:

```sh
npm exec -- arachnodex -c default -j link-issues -a -e
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
  "includeAssets": false,
  "undesirablePathCharacterPattern": "[^\\w\\-/.]",
  "allowedNonCanonicalLinks": [],
  "ignoredIssuePatterns": [
    {
      "codes": ["external-redirect"],
      "urlPattern": "^https?://(?:www\\.)?(?:facebook\\.com/(?:sharer|share_channel)|linkedin\\.com/(?:shareArticle|uas/login)|(?:x|twitter)\\.com/(?:intent/tweet|share)|threads\\.net/(?:intent/post|share)|bsky\\.app/intent/compose|youtu\\.be/|youtube\\.com/watch|instagram\\.com/|goo\\.gl/maps/)(?:[?#/].*)?$"
    }
  ]
}
```

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `emailReportEnabled` | boolean | `true` | Include the Link Issues job report in Arachnodex report emails. |
| `emailReportTriggerLevels` | array or `null` | `["error", "warning", "notice"]` | Severity levels that are allowed to trigger the email report. Valid values are `error`, `warning`, and `notice`. Set to `null` or an empty array to allow the report whenever the job has findings. |
| `includeAssets` | boolean | `false` | Check asset URLs found in HTML markup and same-site CSS/JS bodies. External asset availability checks require `includeExternal` / `-e`. |
| `undesirablePathCharacterPattern` | string | `"[^\\w\\-/.]"` | Regular expression used against decoded internal URL paths. Matching paths create notice-level URL path quality findings. |
| `allowedNonCanonicalLinks` | string[] | `[]` | Path allowlist for internal pages that may point to a different canonical URL without being reported. Entries are compared after the configured `baseUrl` is removed from the normalized canonical target. |
| `ignoredIssuePatterns` | object[] | social/share `external-redirect` defaults | Suppress matching findings by URL pattern plus optional `codes`, `groups`, and `severities` selectors. Patterns are tested against URL-like issue fields and parsed path/query forms. |

Each `ignoredIssuePatterns` entry supports:

```json
{
  "codes": ["external-redirect"],
  "groups": ["External Links"],
  "severities": ["warning"],
  "statusCodes": [301, 302],
  "urlPattern": "^https?://example\\.com/expected-redirect(?:[?#/].*)?$"
}
```

The code, group, severity, and status-code selectors are optional and combine
with AND. To suppress only HTTP 429 responses from external link checks across
all destinations:

```json
{
  "groups": ["External Links"],
  "statusCodes": [429],
  "urlPattern": ".*"
}
```

The default suppresses only `external-redirect` findings for common social,
share, video, and map destinations that frequently redirect by design:
Facebook, LinkedIn, X/Twitter, Threads, Bluesky, YouTube, Instagram, and Google
Maps short URLs. Other issue codes for those links still report.

Projects can add their own external redirect ignores for domain-specific
third-party destinations, but package defaults and examples intentionally avoid
niche domains that may be broken or no longer relevant for other integrations.

Internal links whose only canonical mismatch is the query string are reported as
notices, not warnings. This catches links such as `/?catalog-request` when the
page canonical is `/`, while still treating path, host, and protocol canonical
mismatches as warnings. Use `ignoredIssuePatterns` for known query-driven UI
states, campaign parameters, modal triggers, or action flags that should stay
out of notice output:

```json
{
  "codes": ["canonical-query-variant"],
  "urlPattern": "^/\\?catalog-request$"
}
```

### Issue Codes

Use these values in an `ignoredIssuePatterns` entry's `codes` array when you
want the ignore to apply only to specific finding types.

| Area | Codes |
| --- | --- |
| Crawl status | `fetch-failed`, `client-error`, `server-error` |
| Internal redirects | `redirect-response`, `redirect-loop`, `redirect-final-target-failed`, `redirect-chain`, `redirect-final-target-non-canonical` |
| External links | `external-redirect`, `external-http-upgrade-available`, `external-error`, `external-bot-protection`, `external-dns-temporary-failure`, `external-fetch-failed` |
| Asset links | `asset-redirect`, `asset-http-upgrade-available`, `asset-error`, `asset-bot-protection`, `asset-dns-temporary-failure`, `asset-fetch-failed` |
| Asset security | `insecure-asset-url`, `iframe-missing-sandbox`, `iframe-missing-referrerpolicy`, `malformed-asset-url`, `unsupported-asset-protocol` |
| Canonical issues | `missing-canonical`, `multiple-canonicals`, `empty-canonical`, `malformed-canonical`, `offsite-canonical`, `http-canonical`, `canonical-query-variant`, `non-canonical-internal-link`, `canonical-target-failed`, `canonical-target-redirects` |
| Placeholder links | `missing-href`, `empty-href`, `hash-placeholder` |
| Malformed links | `malformed-href`, `control-character-href` |
| Unsafe protocols | `javascript-href`, `vbscript-href`, `non-web-protocol` |
| Internal link hygiene | `insecure-internal-link`, `target-blank-rel` |
| Fragments and URL quality | `missing-same-page-fragment`, `missing-cross-page-fragment`, `undesirable-path-character` |

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

When external checks are enabled, the job uses the `@arachnodex/bot-protection-heuristics` package through `@arachnodex/core` to recognize common WAF, CAPTCHA, and browser-challenge responses. Responses that match those markers are reported as notice-level `external-bot-protection` findings instead of broken-link errors because many third-party sites block automated HEAD or GET checks while still serving normal browsers.

Unmatched network failures, timeouts, DNS failures, and ordinary error responses still report as external-link findings such as `external-fetch-failed`, `external-dns-temporary-failure`, or `external-error`; they are not downgraded to bot-protection notices unless the response matches a configured bot-protection marker.

External checks use a browser-shaped user agent so third-party sites that reject explicit crawler identifiers can still be verified. This does not change the core crawler's default Arachnodex user agent for normal crawl requests.

Crawler TLS behavior for external HTTPS checks follows the core `requestTls.rejectUnauthorized` setting.

## Asset Links

Asset checks are disabled by default. Enable them with `-a` or config
`includeAssets: true`. The job keeps asset requests private to Link Issues:
asset URLs are not added to the shared crawler queue and cannot be emitted by
the Sitemap job.

When asset checks are enabled, the job inspects common asset references in page
markup, including scripts, stylesheets, images and srcsets, icons, manifests,
media sources, posters, tracks, iframes, embeds, objects, SVG image hrefs,
inline styles, and common social image/video meta tags. Same-site asset
availability is checked with HEAD requests. Same-site CSS and JavaScript bodies
may be downloaded only after a successful HEAD response so the job can discover
nested asset URLs such as CSS `url(...)`, `@import`, source maps, and
conservative JavaScript asset string literals.

External asset availability is checked only when external checks are also
enabled with `-e`. Those checks use HEAD only; external CSS and JavaScript
bodies are never downloaded or parsed.

Asset checks also report decoded asset URL paths that match
`undesirablePathCharacterPattern`, HTTPS-page references to HTTP or
protocol-relative assets, plus iframe embeds missing `sandbox` or
`referrerpolicy` attributes.

## Switches

| Switch | Description |
| --- | --- |
| `-V`, `--version` | Print the Link Issues job version and exit without crawling. |
| `-n`, `--include-notices` | Include notice-level findings. By default, only errors and warnings render. |
| `-e`, `--include-external` | Check external links using HEAD requests with limited fallback behavior. This does not disable normal anchor hygiene reporting for external hrefs when omitted. |
| `-a`, `--include-assets` | Check asset URLs found in page markup and same-site CSS/JS. External asset availability checks require `-e`. |
| `-p`, `--prompt` | Output grouped findings as copy/paste prompts for another coding agent. |
