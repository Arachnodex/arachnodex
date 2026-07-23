# @arachnodex/job-csp-report

> **Beta:** This job is in beta and has not been fully tested. Review all generated directives carefully before deploying them.

Generate Content Security Policy header directives from observed Arachnodex crawl data.

```bash
npm install @arachnodex/job-csp-report
```

Run it with the Arachnodex crawler:

```bash
arachnodex -j csp-report
```

By default the job scans crawled HTML plus same-site CSS and JavaScript bodies, outputs both `Content-Security-Policy-Report-Only` and `Content-Security-Policy`, and formats directives for Apache `mod_headers`.

## Switches

| Switch | Description |
| --- | --- |
| `-V`, `--version` | Output the job version and terminate. |
| `-o <format>`, `--output=<format>` | Output format: `apache`, `nginx`, `lighttpd`, or `raw`. |
| `--no-nested` | Disable nested same-site CSS/JS scanning. |
| `--unsafe-inline` | Add `'unsafe-inline'` for observed inline script/style usage. |
| `-p`, `--prompt` | After the normal report, output copy/paste agent prompts for each warning group. |
| `-h`, `--help` | Show job help. |

## Notes

The generated CSP is based on crawl observations. It is a strong starting policy, not proof that every runtime dependency was observed. A crawl with no scanned HTML pages is reported as an alert rather than a clean result.

Relative resource URLs honor the document's `<base href>`. External base URLs are preserved for compatibility and reported as risky. Forms without an explicit action contribute `'self'` to `form-action`. Non-executable script data blocks such as JSON-LD and social metadata URLs are not treated as CSP-loaded resources.

Inline script/style/event handler usage is reported as a hardening item. Without `--unsafe-inline`, inline usage is not automatically allowed.

## Config

Default config:

```json
{
  "emailReportEnabled": true,
  "outputFormat": "apache",
  "nested": true,
  "unsafeInline": false,
  "includeReportOnly": true,
  "includeEnforce": true,
  "reportUri": "",
  "reportTo": "",
  "ignorePatterns": [],
  "additionalSources": {},
  "ignoreSources": {},
  "staticDirectives": {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "frame-ancestors": ["'self'"]
  }
}
```

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `emailReportEnabled` | boolean | `true` | Allows this job to contribute its report to configured Arachnodex report email output. |
| `outputFormat` | string | `"apache"` | Header format: `apache`, `nginx`, `lighttpd`, or `raw`. |
| `nested` | boolean | `true` | Fetch and scan same-site CSS/JS files observed in crawled pages, with up to four nested requests in flight. |
| `unsafeInline` | boolean | `false` | Add `'unsafe-inline'` to `script-src`/`style-src` when matching inline usage is observed. Inline usage is still reported. |
| `includeReportOnly` | boolean | `true` | Emit `Content-Security-Policy-Report-Only`. |
| `includeEnforce` | boolean | `true` | Emit `Content-Security-Policy`. |
| `reportUri` | string | `""` | Optional `report-uri` CSP directive value. Omitted when empty. |
| `reportTo` | string | `""` | Optional `report-to` CSP directive value. Omitted when empty. |
| `ignorePatterns` | string[] | `[]` | Page/document URL regular expressions to exclude from this CSP report. Matching pages are not counted, their HTML resources are ignored, and their same-site nested CSS/JS assets are not queued from that page. Patterns are tested against full URL, path plus query, path, and decoded path forms. |
| `additionalSources` | object | `{}` | Extra CSP sources keyed by directive, for sources that were not observed but must be allowed. |
| `ignoreSources` | object | `{}` | Exact CSP sources to omit, keyed by directive or `*`. This also applies to static and automatically added sources, so review removals carefully. |
| `staticDirectives` | object | default safe directives | Fixed directives included in every generated policy. |

Example section-specific CSP exclusion:

```json
{
  "ignorePatterns": [
    "/enews/",
    "past-newsletters",
    "/digital-catalog/",
    "1stmonday"
  ]
}
```

Use crawler-level `urlCantContain` / `urlMustContain` when a URL should be excluded from the whole crawl and every job. Use this job's `ignorePatterns` when the URL should still be available to other jobs, but should not influence the generated CSP for the current policy scope.
