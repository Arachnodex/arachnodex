# Custom Jobs

Arachnodex jobs are npm packages loaded by the core crawler at runtime. A job receives crawler lifecycle events, can read its own config file, and can add console, email, file, or machine-readable output.

This document covers the current job package shape, how to install custom jobs from npm, a private registry, or a local filesystem path, and how to run local TypeScript source while actively developing a job.

## Naming And Loading

Arachnodex supports official shorthand and exact package loading.

Official Arachnodex jobs can use short handles:

```text
-j sitemap -> @arachnodex/job-sitemap
-j link-issues -> @arachnodex/job-link-issues
```

Those short handles only resolve the package name. The matching job package still has to be installed in the consuming Arachnodex project or in the same global environment as `@arachnodex/core`.

Third-party jobs should use their real npm package name. Scoped packages load exactly:

```sh
npm exec -- arachnodex -c default -j @acme/arachnodex-job-content-audit
```

That imports:

```text
@acme/arachnodex-job-content-audit
```

For exact unscoped package names, prefix the package with `npm:` so the crawler does not treat it as official shorthand:

```sh
npm exec -- arachnodex -c default -j npm:acme-arachnodex-content-audit
```

That imports:

```text
acme-arachnodex-content-audit
```

Most third-party authors should publish under their own npm scope, such as `@acme/arachnodex-job-content-audit`. You do not need access to the `@arachnodex` npm organization to write or distribute jobs.

## Package Shape

A minimal custom job package looks like this:

```text
my-job/
  package.json
  tsconfig.json
  src/
    index.ts
    cmd.ts
  bin/
    index.js
```

The package should export:

- A default job class from the package root.
- Optionally, a named `CommandParser` export for job-specific switches.

Example `package.json` for a scoped third-party job:

```json
{
  "name": "@acme/arachnodex-job-content-audit",
  "version": "1.0.0",
  "type": "module",
  "main": "bin/index.js",
  "types": "types/index.d.ts",
  "exports": {
    ".": {
      "types": "./types/index.d.ts",
      "development": "./src/index.ts",
      "default": "./bin/index.js"
    }
  },
  "files": [
    "bin",
    "src",
    "types"
  ],
  "scripts": {
    "clean:bin": "node -e \"const fs=require('node:fs'); fs.rmSync('bin',{recursive:true,force:true}); fs.mkdirSync('bin',{recursive:true});\"",
    "clean:types": "node -e \"const fs=require('node:fs'); fs.rmSync('types',{recursive:true,force:true});\"",
    "build:types": "tsc -p tsconfig.types.json",
    "build": "npm run clean:bin && npm run clean:types && esbuild src/index.ts --bundle --platform=node --format=esm --target=node22 --minify --packages=external --outfile=bin/index.js && npm run build:types"
  },
  "peerDependencies": {
    "@arachnodex/core": "^1.0.0"
  },
  "devDependencies": {
    "@arachnodex/core": "^1.0.0",
    "esbuild": "^0.25.0",
    "tsx": "^4.20.6",
    "typescript": "^5.6.3"
  },
  "engines": {
    "node": ">=22.13.0 <25"
  }
}
```

Use `peerDependencies` for `@arachnodex/core`. That lets npm warn users when a job expects a different core version without installing duplicate copies of core.

The `types` export should point to generated declaration files for published packages. Keep the `development` export pointed at `src/index.ts` so source-mode development can run without rebuilding after every edit.

Use a TypeScript config that matches Node ESM resolution. A standalone job can start with:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true,
    "forceConsistentCasingInFileNames": true,
    "allowSyntheticDefaultImports": true,
    "verbatimModuleSyntax": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "bin"]
}
```

Add a declaration-only config next to it:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "emitDeclarationOnly": true,
    "declarationMap": false,
    "rootDir": "src",
    "outDir": "types",
    "stripInternal": true
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts"],
  "exclude": ["node_modules", "bin", "types"]
}
```

## Job Class

Create a default export that extends `BaseJob`:

```ts
import type {AxiosResponse} from "axios";
import {
  BaseJob,
  type ArachnodexRuntime,
  type JobCommandParser,
  type JSONObject,
  type Location,
  type PageData,
  type Profiler,
  type ReportData
} from "@arachnodex/core";

export {default as CommandParser} from "./cmd.js";

interface ContentAuditConfig extends JSONObject {
  emailReportEnabled: boolean;
  requiredText: string;
}

export default class ContentAuditJob extends BaseJob {
  name = "Content Audit";
  configRequired = false;
  private requiredText = "";
  private missingPages: string[] = [];

  constructor(handle: string, command: JobCommandParser, profiler: Profiler, runtime: ArachnodexRuntime) {
    super(handle, command, profiler, runtime);
  }

  loadConfig(): void {
    const config = this.config.getJobConfig<ContentAuditConfig>(
      {
        emailReportEnabled: true,
        requiredText: ""
      },
      this.command,
      this.configRequired
    );

    this.emailReportEnabled = config.emailReportEnabled;
    this.requiredText = config.requiredText;
  }

  onInit(): void {
    this.profiler.markJob(this.handle, "init", "content audit initialized");
  }

  onBeforeRequest(_location: Location): void {
    // Optional hook before a request is made.
  }

  onHeadersReceived(_response: AxiosResponse | null, _location: Location): void {
    // Optional hook after response headers are available.
  }

  onPageReceived(_response: AxiosResponse | null, pageData: PageData): void {
    const body = pageData.jsdom?.body.textContent ?? "";
    if (this.requiredText !== "" && !body.includes(this.requiredText)) {
      this.missingPages.push(pageData.location.url);
    }
  }

  onEnd(): void {
    // Optional cleanup or end-of-run reporting work.
  }

  getReportTitle(): string {
    return "Content Audit Report";
  }

  getReportMessage(): string {
    return `${this.missingPages.length} page(s) were missing required text.`;
  }

  getReportData(): ReportData {
    return {
      "Missing Pages": this.missingPages.length
    };
  }

  getReportHtml(): string {
    if (this.missingPages.length === 0) {
      return "<p>No content audit issues were found.</p>";
    }

    return `<ul>${this.missingPages.map(url => `<li>${url}</li>`).join("")}</ul>`;
  }
}
```

`BaseJob` exposes the per-run runtime helpers as `this.config`, `this.events`, and `this.urlHelper`. Use those instead of importing the legacy singleton helpers directly, especially if your job may be used by tests or programmatic callers that run more than one crawl in the same Node process.

Available lifecycle hooks:

| Hook | When it runs |
| --- | --- |
| `loadConfig()` | After the job class is constructed. Use it to read job config. |
| `onInit()` | After all jobs are loaded and before crawling begins. |
| `onBeforeRequest(location)` | Before a crawler request is made for an in-scope URL. |
| `onHeadersReceived(response, location)` | After response headers are available. |
| `onPageReceived(response, pageData)` | After page data is parsed. |
| `onEnd()` | During crawler shutdown. May be async. |

Report methods used by the email/report system:

| Method | Purpose |
| --- | --- |
| `getReportTitle()` | Report section title. |
| `getReportMessage()` | Short plain-text summary. |
| `getReportData()` | Small label/value summary table. |
| `getReportHtml()` | Full HTML section for the job. |
| `shouldSendEmailReport()` | Controls whether this job contributes email output. |

Arachnodex marks a job complete after `onEnd()` returns. If `onEnd()` starts async work, return a promise so the crawler can wait for that work before finishing shutdown.

## Job Command Switches

Custom switches are optional. Add them by exporting a named `CommandParser` class:

```ts
import {JobCommandParser, type ArgumentConfig} from "@arachnodex/core";

export default class ContentAuditCommandParser extends JobCommandParser {
  constructor(args: string[], job: string) {
    const switches: Record<string, ArgumentConfig> = {
      "-r": {
        switch: "-r",
        aliases: ["--required-text"],
        value: true,
        type: "string",
        label: "text",
        configPath: "requiredText",
        description: "Require the supplied text to appear on each HTML page."
      }
    };

    super(args, switches, job);
  }

  getDescription(): string {
    return "Checks crawled pages for required content.";
  }
}
```

Then re-export it from `src/index.ts`:

```ts
export {default as CommandParser} from "./cmd.js";
```

Job switches belong after the job name and before the next `-j`:

```sh
npm exec -- arachnodex -c default -j @acme/arachnodex-job-content-audit -r "Privacy Policy" -j sitemap
```

## Job Config

Job config files live in the consuming project's `config/` directory.

If a user runs:

```sh
npm exec -- arachnodex -c default -j @acme/arachnodex-job-content-audit -c content-audit
```

the crawler config comes from:

```text
config/default.json
```

and the job config comes from:

```text
config/content-audit.json
```

Inside `loadConfig()`, call:

```ts
const config = this.config.getJobConfig(defaultConfig, this.command, this.configRequired);
```

Command switches with `configPath` values override values from the job config file.

## Installing A Published Job

For a job published to npm or a private npm registry:

```sh
npm install @acme/arachnodex-job-content-audit
npm exec -- arachnodex -c default -j @acme/arachnodex-job-content-audit
```

If the package is private, configure npm authentication and registry access the same way you would for any other private package.

## Deploying A Job

Before publishing or sharing a job package, build it:

```sh
npm run build
```

For a public npm package under your own scope:

```sh
npm publish --access public
```

For a private npm package, use your organization's normal private registry flow:

```sh
npm publish
```

For a private local job that is not released anywhere, keep the package in a reachable local directory, keep its `name` field aligned with the job command you plan to use, and install it into each Arachnodex project with `npm install ../path/to/job` or a `file:` dependency.

## Installing A Local Private Job

You can install a local, unpublished job package from the filesystem. The local package still needs a real package name:

```json
{
  "name": "@acme/arachnodex-job-content-audit"
}
```

Install it into an existing Arachnodex project:

```sh
npm install ../my-private-jobs/content-audit
npm exec -- arachnodex -c default -j @acme/arachnodex-job-content-audit
```

Or add it to the consuming project's `package.json`:

```json
{
  "dependencies": {
    "@arachnodex/core": "^1.0.0",
    "@acme/arachnodex-job-content-audit": "file:../my-private-jobs/content-audit"
  }
}
```

Then install and run:

```sh
npm install
npm exec -- arachnodex -c default -j @acme/arachnodex-job-content-audit
```

If you run the normal built CLI while developing, rebuild the job after source changes:

```sh
cd ../my-private-jobs/content-audit
npm run build
```

Then rerun the crawler in the consuming project. Depending on your package manager and local dependency layout, you may need to reinstall the local package after rebuilding.

## Developing A Job Without Rebuilding

During active development, you can run Arachnodex against TypeScript source instead of rebuilding `bin/index.js` after every edit. The job package must expose a development export condition:

```json
{
  "exports": {
    ".": {
      "types": "./types/index.d.ts",
      "development": "./src/index.ts",
      "default": "./bin/index.js"
    }
  }
}
```

The normal CLI uses the `default` export and loads `bin/index.js`. TypeScript consumers use the generated declaration files. Source mode uses Node's `development` condition plus `tsx`, so package imports resolve to `src/index.ts`.

Install the local job and the TypeScript runner in the consuming Arachnodex project:

```sh
npm install ../my-private-jobs/content-audit
npm install -D tsx typescript
```

Then run the core source entrypoint with the development condition enabled:

```sh
npm exec -- node --conditions=development --import tsx node_modules/@arachnodex/core/src/index.ts -c default -j @acme/arachnodex-job-content-audit
```

Projects created with `npm create @arachnodex` include this pattern as `npm run crawl:src`, so you can update that script's `-j` arguments while working on a custom job.

Inside this monorepo, use the same mode from the core package:

```sh
cd packages/core
npm run crawl:src -- -c default -j sitemap -j link-issues
```

From the monorepo root, the `crawl-dev` script wraps that workspace command:

```sh
npm run crawl-dev -- -j link-issues -n -e -p
```

Use source mode for fast local iteration. Before publishing, packing, or opening a pull request that changes built packages, still run `npm run build` and commit the updated `bin/index.js` and `types/` declarations.

## Using An Unscoped Local Package

If your local package is unscoped:

```json
{
  "name": "acme-arachnodex-content-audit"
}
```

install and run it with the `npm:` prefix:

```sh
npm install ../my-private-jobs/content-audit
npm exec -- arachnodex -c default -j npm:acme-arachnodex-content-audit
```

The `npm:` prefix is only a signal to Arachnodex. The actual package import is `acme-arachnodex-content-audit`.

## Testing A Job Locally

At minimum, run these checks in the job package:

```sh
npm run build
npm exec -- tsc --noEmit --pretty false
```

Then install the job into a real Arachnodex project and run it against a small site or local test fixture:

```sh
npm exec -- arachnodex -c default -j @acme/arachnodex-job-content-audit
```

When testing from this monorepo, prefer the source runner while iterating:

```sh
npm run crawl-dev -- -j @acme/arachnodex-job-content-audit
```

Keep test crawls small while developing. Jobs run during the crawl, so a noisy or slow hook can make a large audit unpleasant very quickly.
