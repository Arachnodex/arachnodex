import assert from "node:assert/strict";
import test from "node:test";
import {stripVTControlCharacters} from "node:util";

import axios from "axios";
import {JSDOM} from "jsdom";
import type {JSONObject, PageData} from "@arachnodex/core";

import CspReportCmd from "../src/cmd.ts";
import CspReport from "../src/index.ts";

type JobConfig = Record<string, unknown>;

type CspReportState = CspReport & {
    buildPolicy: () => string;
    renderDirectives: () => string;
    nestedQueue: Set<string>;
    scannedPageCount: number;
    ignoredPageCount: number;
    scannedNestedCount: number;
};

const baseUrl = "https://example.test";

function createJob(args: string[] = [], configOverrides: JobConfig = {}): CspReport {
    const config = {
        getConfigBoolean: (key: string) => key === "requestTls.rejectUnauthorized",
        getConfigString: (key: string) => key === "baseUrl" ? baseUrl : "",
        getJobConfig: <T extends JobConfig>(
            defaults: T,
            _command: unknown,
            _required: boolean,
            normalize?: (value: T) => void
        ): T => {
            const value = {
                ...defaults,
                ...configOverrides
            };
            value.ignorePatterns = [...value.ignorePatterns as string[]];
            value.additionalSources = {...value.additionalSources as JSONObject};
            value.ignoreSources = {...value.ignoreSources as JSONObject};
            value.staticDirectives = {...value.staticDirectives as JSONObject};
            if(args.includes("--unsafe-inline")) {
                value.unsafeInline = true;
            }
            const outputIndex = args.findIndex(arg => arg === "-o" || arg === "--output");
            if(outputIndex !== -1 && typeof args[outputIndex + 1] === "string") {
                value.outputFormat = args[outputIndex + 1];
            }
            normalize?.(value as T);
            return value as T;
        }
    };
    const runtime = {
        config,
        events: {emit: () => undefined},
        abortSignal: undefined,
        aborted: false
    };
    const command = new CspReportCmd(args, "csp-report");
    const job = new CspReport("csp-report", command, {} as never, runtime as never);
    job.loadConfig();

    return job;
}

function makePage(body: string, url = `${baseUrl}/`, head = ""): PageData {
    const jsdom = new JSDOM(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, {url});

    return {
        location: {
            url,
            rawUrl: url
        },
        links: [],
        rawLinks: [],
        parseWarnings: [],
        contentType: "text/html",
        jsdom: jsdom.window.document
    };
}

function state(job: CspReport): CspReportState {
    return job as unknown as CspReportState;
}

function captureConsole(callback: () => void): string[] {
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
        lines.push(stripVTControlCharacters(args.map(String).join(" ")));
    };
    try {
        callback();
    } finally {
        console.log = original;
    }
    return lines;
}

async function captureConsoleAsync(callback: () => Promise<void>): Promise<string[]> {
    const original = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
        lines.push(stripVTControlCharacters(args.map(String).join(" ")));
    };
    try {
        await callback();
    } finally {
        console.log = original;
    }
    return lines;
}

test("command parser exposes version and expected help switches", () => {
    const lines = captureConsole(() => {
        assert.throws(() => new CspReportCmd(["-V"], "csp-report"), error => {
            return isRecord(error) && error.statusCode === 0;
        });
    });
    assert.deepEqual(lines, ["CSP Report Job Version 1.0.0"]);

    const help = new CspReportCmd([], "csp-report").getHelpMessage();
    assert.match(help, /-o <apache\|nginx\|lighttpd\|raw>, --output=<apache\|nginx\|lighttpd\|raw>/);
    assert.match(help, /--no-nested/);
    assert.match(help, /--unsafe-inline/);
    assert.match(help, /-p, --prompt/);
    assert.doesNotMatch(help, /--verbose/);
});

test("invalid output format is rejected", () => {
    assert.throws(() => createJob(["-o", "iis"]), /outputFormat must be one of/);
});

test("observed HTML resources are mapped to CSP directives", () => {
    const job = createJob([], {nested: false});
    job.onPageReceived(null, makePage([
        '<script src="/assets/app.js"></script>',
        '<script src="https://cdn.example.com/app.js"></script>',
        '<script>fetch("https://api.example.com/data")</script>',
        '<button onclick="save()">Save</button>',
        '<link rel="stylesheet" href="/assets/app.css">',
        '<style>.hero{background:url("https://img.example.com/hero.png")}</style>',
        '<link rel="preload" as="font" href="https://fonts.example.com/site.woff2">',
        '<img src="/logo.png" srcset="/logo-2x.png 2x, https://img.example.com/logo.png 3x">',
        '<video src="/intro.mp4" poster="/poster.jpg"></video>',
        '<iframe src="https://player.example.com/embed"></iframe>',
        '<object data="http://legacy.example.com/widget.swf"></object>',
        '<form action="https://forms.example.com/contact"></form>',
        '<link rel="manifest" href="/site.webmanifest">'
    ].join("")));

    const policy = state(job).buildPolicy();
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /script-src 'self' https:\/\/cdn\.example\.com/);
    assert.match(policy, /connect-src https:\/\/api\.example\.com/);
    assert.match(policy, /style-src 'self'/);
    assert.match(policy, /img-src 'self' https:\/\/img\.example\.com/);
    assert.match(policy, /font-src https:\/\/fonts\.example\.com/);
    assert.match(policy, /media-src 'self'/);
    assert.match(policy, /frame-src https:\/\/player\.example\.com/);
    assert.match(policy, /object-src http:\/\/legacy\.example\.com/);
    assert.match(policy, /form-action https:\/\/forms\.example\.com/);
    assert.match(policy, /manifest-src 'self'/);
    assert.doesNotMatch(policy, /'unsafe-inline'/);

    const html = job.getReportHtml();
    assert.match(html, /inline script\/event handler/);
    assert.match(html, /Samples:/);
    assert.match(html, /onclick=&quot;save\(\)&quot;/);
    assert.match(html, /http source observed on an https crawl/);
    assert.match(html, /object\/embed content/);
});

test("document base URLs are applied and preserved in the generated policy", () => {
    const job = createJob([], {nested: false});
    job.onPageReceived(null, makePage(
        '<script src="app.js"></script><img src="images/logo.png">',
        `${baseUrl}/products/index.html`,
        '<base href="https://cdn.example.com/site/">'
    ));

    const policy = state(job).buildPolicy();
    assert.match(policy, /base-uri 'self' https:\/\/cdn\.example\.com/);
    assert.match(policy, /script-src https:\/\/cdn\.example\.com/);
    assert.match(policy, /img-src https:\/\/cdn\.example\.com/);
    assert.match(job.getReportHtml(), /external base URL/);
});

test("non-executable script data blocks and social metadata do not expand CSP", () => {
    const job = createJob([], {nested: false});
    job.onPageReceived(null, makePage(
        '<script type="application/ld+json">{"image":"https://metadata.example.com/image.jpg"}</script>',
        `${baseUrl}/products`,
        '<meta property="og:image" content="https://social.example.com/share.jpg">'
    ));

    const policy = state(job).buildPolicy();
    assert.doesNotMatch(policy, /metadata\.example\.com|social\.example\.com|script-src|img-src/);
    assert.equal(job.getReportData()["Inline Findings"], 0);
});

test("forms without explicit actions are restricted to self", () => {
    const job = createJob([], {nested: false});
    job.onPageReceived(null, makePage([
        "<form method=\"post\"></form>",
        "<form action=\"\"></form>",
        "<form action=\"https://forms.example.com/submit\"></form>"
    ].join("")));

    assert.match(state(job).buildPolicy(), /form-action 'self' https:\/\/forms\.example\.com/);
});

test("ignoreSources applies consistently to static and automatic policy sources", () => {
    const job = createJob([], {
        nested: false,
        ignoreSources: {
            "DEFAULT-SRC": ["'self'"],
            "object-src": ["'none'"]
        }
    });

    const policy = state(job).buildPolicy();
    assert.doesNotMatch(policy, /default-src|object-src/);
    assert.match(policy, /base-uri 'self'/);
});

test("unsafe-inline is opt-in and only added to directives with observed inline usage", () => {
    const scriptOnly = createJob(["--unsafe-inline"], {nested: false});
    scriptOnly.onPageReceived(null, makePage("<script>console.log('x')</script>"));
    assert.match(state(scriptOnly).buildPolicy(), /script-src 'unsafe-inline'/);
    assert.doesNotMatch(state(scriptOnly).buildPolicy(), /style-src 'unsafe-inline'/);

    const styleOnly = createJob(["--unsafe-inline"], {nested: false});
    styleOnly.onPageReceived(null, makePage('<div style="color:red"></div>'));
    assert.match(state(styleOnly).buildPolicy(), /style-src 'unsafe-inline'/);
    assert.doesNotMatch(state(styleOnly).buildPolicy(), /script-src 'unsafe-inline'/);
    assert.match(styleOnly.getReportHtml(), /unsafe-inline was added to style-src/);
});

test("ignorePatterns exclude matching pages from CSP collection", () => {
    const job = createJob([], {
        nested: false,
        ignorePatterns: ["/enews/", "past-newsletters", "/digital-catalog/", "1stmonday"]
    });

    job.onPageReceived(null, makePage(
        '<script src="https://ignored.example.com/newsletter.js"></script>',
        `${baseUrl}/enews/summer.html`
    ));
    job.onPageReceived(null, makePage(
        '<script src="https://ignored.example.com/catalog.js"></script>',
        `${baseUrl}/digital-catalog/index.html`
    ));
    job.onPageReceived(null, makePage(
        '<script src="https://cdn.example.com/app.js"></script>',
        `${baseUrl}/products`
    ));

    const policy = state(job).buildPolicy();
    assert.match(policy, /script-src https:\/\/cdn\.example\.com/);
    assert.doesNotMatch(policy, /ignored\.example\.com/);
    assert.equal(state(job).scannedPageCount, 1);
    assert.equal(state(job).ignoredPageCount, 2);
    assert.equal(job.getReportData()["Ignored Pages"], 2);
});

test("ignorePatterns prevent ignored pages from queueing nested assets", async () => {
    const originalGet = axios.get;
    let requested = 0;
    (axios as unknown as {get: typeof axios.get}).get = (async () => {
        requested++;
        return {data: 'fetch("https://api.example.com/data")'};
    }) as typeof axios.get;

    try {
        const job = createJob([], {ignorePatterns: ["/enews/"]});
        job.onPageReceived(null, makePage(
            '<script src="/assets/newsletter.js"></script>',
            `${baseUrl}/enews/summer.html`
        ));
        await captureConsoleAsync(() => job.onEnd());

        assert.equal(requested, 0);
        assert.equal(state(job).scannedNestedCount, 0);
        assert.doesNotMatch(state(job).buildPolicy(), /connect-src/);
    } finally {
        (axios as unknown as {get: typeof axios.get}).get = originalGet;
    }
});

test("non-script and non-style URLs are never queued for nested scanning", () => {
    const job = createJob();
    job.onPageReceived(null, makePage([
        '<form action="/submit.js"></form>',
        '<img src="/placeholder.css">'
    ].join("")));

    assert.equal(state(job).nestedQueue.size, 0);
});

test("https protocol ternary does not report inactive http script branch", () => {
    const job = createJob([], {nested: false});
    job.onPageReceived(null, makePage(`
        <script>
            var src = document.location.protocol === \`https:\`
                ? \`https://www.formilla.com/scripts/feedback.js\`
                : \`http://www.formilla.com/scripts/feedback.js\`;
            script.setAttribute("src", src);
        </script>
    `));

    const policy = state(job).buildPolicy();
    assert.match(policy, /script-src https:\/\/www\.formilla\.com/);
    assert.doesNotMatch(policy, /http:\/\/www\.formilla\.com/);
    assert.doesNotMatch(job.getReportHtml(), /http source observed on an https crawl/);
});

test("standalone http script string literals are still reported on https crawls", () => {
    const job = createJob([], {nested: false});
    job.onPageReceived(null, makePage('<script>const legacyScript = "http://legacy.example.com/script.js";</script>'));

    const policy = state(job).buildPolicy();
    assert.match(policy, /script-src http:\/\/legacy\.example\.com/);
    assert.match(job.getReportHtml(), /http source observed on an https crawl/);
});

test("nested same-site CSS and JavaScript contribute sources by default", async () => {
    const originalGet = axios.get;
    const requested: string[] = [];
    (axios as unknown as {get: typeof axios.get}).get = (async (url: string) => {
        requested.push(url);
        if(url.endsWith("/assets/app.css")) {
            return {
                data: '@import "https://cdn.example.com/theme.css"; .x{background:url("https://img.example.com/bg.png"); src:url("https://fonts.example.com/site.woff2")}'
            };
        }
        if(url.endsWith("/assets/app.js")) {
            return {
                data: 'fetch("https://api.example.com/data"); new Worker("/worker.js"); import("https://cdn.example.com/module.js");'
            };
        }
        return {data: ""};
    }) as typeof axios.get;

    try {
        const job = createJob();
        job.onPageReceived(null, makePage([
            '<link rel="stylesheet" href="/assets/app.css">',
            '<script src="/assets/app.js"></script>',
            '<script src="https://cdn.example.com/external.js"></script>'
        ].join("")));
        await captureConsoleAsync(() => job.onEnd());

        const policy = state(job).buildPolicy();
        assert.deepEqual(requested.sort(), [`${baseUrl}/assets/app.css`, `${baseUrl}/assets/app.js`, `${baseUrl}/worker.js`]);
        assert.match(policy, /style-src 'self' https:\/\/cdn\.example\.com/);
        assert.match(policy, /img-src https:\/\/img\.example\.com/);
        assert.match(policy, /font-src https:\/\/fonts\.example\.com/);
        assert.match(policy, /connect-src https:\/\/api\.example\.com/);
        assert.match(policy, /worker-src 'self'/);
        assert.match(policy, /script-src 'self' https:\/\/cdn\.example\.com/);
    } finally {
        (axios as unknown as {get: typeof axios.get}).get = originalGet;
    }
});

test("nested assets scan concurrently and count successful empty responses", async () => {
    const originalGet = axios.get;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    (axios as unknown as {get: typeof axios.get}).get = (async () => {
        activeRequests++;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise(resolve => setImmediate(resolve));
        activeRequests--;
        return {data: ""};
    }) as typeof axios.get;

    try {
        const job = createJob();
        job.onPageReceived(null, makePage(Array.from(
            {length: 5},
            (_, index) => `<script src="/assets/app-${index}.js"></script>`
        ).join("")));
        await captureConsoleAsync(() => job.onEnd());

        assert.equal(maxActiveRequests, 4);
        assert.equal(state(job).scannedNestedCount, 5);
    } finally {
        (axios as unknown as {get: typeof axios.get}).get = originalGet;
    }
});

test("nested JavaScript scanning ignores bare module-like string literals", async () => {
    const originalGet = axios.get;
    const requested: string[] = [];
    (axios as unknown as {get: typeof axios.get}).get = (async (url: string) => {
        requested.push(url);
        if(url.endsWith("/assets/app.js")) {
            return {
                data: [
                    '"v1.js";',
                    '"core-js/modules/es6.symbol.js";',
                    '"./local-module.js";',
                    'import("./real-chunk.js");',
                    'new Worker("/worker.js");'
                ].join("")
            };
        }
        return {data: ""};
    }) as typeof axios.get;

    try {
        const job = createJob();
        job.onPageReceived(null, makePage('<script src="/assets/app.js"></script>'));
        await captureConsoleAsync(() => job.onEnd());

        assert.deepEqual(requested.sort(), [
            `${baseUrl}/assets/app.js`,
            `${baseUrl}/assets/real-chunk.js`,
            `${baseUrl}/worker.js`
        ]);
    } finally {
        (axios as unknown as {get: typeof axios.get}).get = originalGet;
    }
});

test("no-nested disables nested asset fetches", async () => {
    const originalGet = axios.get;
    let requested = 0;
    (axios as unknown as {get: typeof axios.get}).get = (async () => {
        requested++;
        return {data: 'fetch("https://api.example.com/data")'};
    }) as typeof axios.get;

    try {
        const job = createJob(["--no-nested"]);
        job.onPageReceived(null, makePage('<script src="/assets/app.js"></script>'));
        await captureConsoleAsync(() => job.onEnd());

        assert.equal(requested, 0);
        assert.equal(state(job).scannedNestedCount, 0);
        assert.doesNotMatch(state(job).buildPolicy(), /connect-src/);
    } finally {
        (axios as unknown as {get: typeof axios.get}).get = originalGet;
    }
});

test("renderers output apache, nginx, lighttpd, and raw syntax", () => {
    const apache = createJob([], {outputFormat: "apache", nested: false});
    assert.match(state(apache).renderDirectives(), /Header onsuccess unset Content-Security-Policy-Report-Only/);
    assert.match(state(apache).renderDirectives(), /Header always set Content-Security-Policy "/);

    const nginx = createJob([], {outputFormat: "nginx", nested: false});
    assert.match(state(nginx).renderDirectives(), /add_header Content-Security-Policy-Report-Only ".*" always;/);
    assert.match(state(nginx).renderDirectives(), /add_header Content-Security-Policy ".*" always;/);

    const lighttpd = createJob([], {outputFormat: "lighttpd", nested: false});
    assert.match(state(lighttpd).renderDirectives(), /setenv\.set-response-header \+= \(/);
    assert.match(state(lighttpd).renderDirectives(), /"Content-Security-Policy-Report-Only" => "/);
    assert.match(state(lighttpd).renderDirectives(), /"Content-Security-Policy" => "/);

    const raw = createJob([], {outputFormat: "raw", nested: false});
    assert.match(state(raw).renderDirectives(), /Content-Security-Policy-Report-Only: /);
    assert.match(state(raw).renderDirectives(), /Content-Security-Policy: /);
});

test("report-uri and report-to are omitted unless configured", () => {
    const defaultJob = createJob([], {nested: false});
    assert.doesNotMatch(state(defaultJob).buildPolicy(), /report-uri/);
    assert.doesNotMatch(state(defaultJob).buildPolicy(), /report-to/);

    const configuredJob = createJob([], {
        nested: false,
        reportUri: "https://reports.example.com/csp",
        reportTo: "default"
    });
    assert.match(state(configuredJob).buildPolicy(), /report-uri https:\/\/reports\.example\.com\/csp/);
    assert.match(state(configuredJob).buildPolicy(), /report-to default/);
});

test("clean reports still recommend report-only verification", () => {
    const job = createJob([], {nested: false});
    job.onPageReceived(null, makePage('<script src="/assets/app.js"></script>'));

    const lines = captureConsole(() => {
        void job.onEnd();
    }).join("\n");
    const html = job.getReportHtml();

    assert.match(lines, /ALL CHECKS PASSED FROM CRAWL OBSERVATIONS/);
    assert.match(lines, /deploy the report-only header first and manually test the site/);
    assert.match(lines, /developer\.mozilla\.org\/en-US\/docs\/Web\/Security\/Practical_implementation_guides\/CSP#report-only_csps/);
    assert.match(lines, /-- start copy --\nHeader onsuccess unset Content-Security-Policy-Report-Only/);
    assert.match(lines, /Header always set Content-Security-Policy ".*"\n-- end copy --/);
    assert.match(html, /All checks passed from crawl observations/);
    assert.match(html, /-- start copy --/);
    assert.match(html, /-- end copy --/);
    assert.match(html, /MDN's report-only CSP guidance/);
});

test("a report with no scanned pages is an alert, not a clean result", () => {
    const job = createJob([], {nested: false});
    const html = job.getReportHtml();

    assert.match(html, /No Pages Scanned/);
    assert.match(html, /do not deploy the enforcing Content-Security-Policy header/i);
    assert.doesNotMatch(html, /All checks passed from crawl observations/);
});

test("prompt output follows the normal report with warning handoff prompts", async () => {
    const job = createJob(["-p"], {nested: false});
    job.onPageReceived(null, makePage([
        '<script>console.log("x")</script>',
        '<div style="color:red"></div>'
    ].join("")));

    const lines = captureConsole(() => {
        void job.onEnd();
    }).join("\n");

    assert.match(lines, /How to use this report/);
    assert.match(lines, /ALERT: The enforcing Content-Security-Policy header is likely to break this site/);
    assert.match(lines, /CSP CLEANUP PROMPTS/);
    assert.match(lines, /PROMPT: CSP \/ Inline Script And Event Handlers/);
    assert.match(lines, /PROMPT: CSP \/ Inline Styles/);
    assert.match(lines, /----- BEGIN PROMPT -----/);
});

test("prompt output generalizes warning groups with more than 100 occurrences", () => {
    const job = createJob(["-p"], {nested: false});
    const body = Array.from({length: 101}, (_value, index) => `<button onclick="save${index}()">Save</button>`).join("");
    job.onPageReceived(null, makePage(body));

    const lines = captureConsole(() => {
        void job.onEnd();
    }).join("\n");

    assert.match(lines, /The report found 101 occurrences in this group/);
    assert.match(lines, /Search the codebase\/templates\/CMS data for the repeated pattern/);
    assert.match(lines, /intentionally avoids carrying a large occurrence list/);
    assert.doesNotMatch(lines, /1\. https:\/\/example\.test\//);
    assert.doesNotMatch(lines, /save100/);
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
