# @arachnodex/job-sitemap

The Sitemap job creates an XML sitemap from crawlable internal URLs discovered while Arachnodex spiders the configured site.

It can include normal HTML pages, optionally include document URLs such as PDFs, and optionally skip URLs that point at a different canonical target.

## Install

Projects created with `npm create @arachnodex` include this job by default. For a manual install, add it beside `@arachnodex/core`:

```sh
npm install @arachnodex/job-sitemap
```

The package uses `@arachnodex/core` as a peer dependency, so it should be installed in the same project as the crawler.

## Usage

Run the job with the default crawler config:

```sh
npm exec -- arachnodex -c default -j sitemap
```

Use a job-specific config by placing `-c` after the job name:

```sh
npm exec -- arachnodex -c default -j sitemap -c sitemap
```

That loads the crawler config from `config/default.json` and the Sitemap job config from `config/sitemap.json`.

## Config File

The package example config is available at:

```text
config/sitemap.example.json
```

A generated Arachnodex project copies this to:

```text
config/sitemap.json
```

For a manual install, copy the example into your Arachnodex project's `config/` directory as `sitemap.json` before running the job.

Default config:

```json
{
  "includeOnlyCanonical": true,
  "includeDocs": true,
  "emailReportEnabled": true,
  "outputFile": "../web/sitemap.xml",
  "includeDocPattern": "((x-)?pdf)|(ms-?excel)|(vnd.)|(ms-?word)|(ms-?powerpoint)|(ms-?access)|(download)"
}
```

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `includeOnlyCanonical` | boolean | `true` | Only include HTML page URLs when the page has no canonical URL or its canonical URL matches the current crawled URL. Set to `false` to include crawled page URLs even when they point at another canonical target. |
| `includeDocs` | boolean | `true` | Include matching non-HTML document URLs discovered from successful response headers. |
| `emailReportEnabled` | boolean | `true` | Include the Sitemap job summary in Arachnodex report emails. |
| `outputFile` | string | `"../web/sitemap.xml"` | Path for the generated sitemap file, resolved from the directory where the crawler is run. The default assumes the Arachnodex project sits beside a website document root at `../web`. |
| `includeDocPattern` | string | `"((x-)?pdf)|(ms-?excel)|(vnd.)|(ms-?word)|(ms-?powerpoint)|(ms-?access)|(download)"` | Regular expression used against response `content-type` headers when `includeDocs` is enabled. Matching URLs are written as document entries. |

## Output Path

`outputFile` may point outside the Arachnodex project directory as long as the Node process has filesystem permission to write there. A common layout is:

```text
site-audit/
web/
```

With that layout, running Arachnodex from `site-audit/` and leaving `outputFile` as `../web/sitemap.xml` writes the public sitemap beside the audit project.

The job overwrites the configured output file at the end of each successful crawl. Temporary working files are run-specific and are cleaned up after the final sitemap is written.

## Switches

| Switch | Description |
| --- | --- |
| `-v`, `--version` | Print the Sitemap job version and exit without crawling. |
