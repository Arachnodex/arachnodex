import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

import type {AxiosResponse} from "axios";
import {JSDOM} from "jsdom";
import {isCommandExit, type PageData, type PageLink} from "@arachnodex/core";

import LinkIssuesCmd from "../src/cmd.ts";
import LinkIssues from "../src/index.ts";

type IssueLike = {
    code: string;
    severity?: string;
    group?: string;
    targetUrl?: string;
    sourceUrl?: string;
    rawHref?: string;
    htmlSnippet?: string;
    finalUrl?: string;
    decodedPath?: string;
    assetKind?: string;
    sourceLabel?: string;
    statusCode?: number;
};

type AssetLike = {
    targetUrl: string;
    sourceUrl: string;
    occurrences?: unknown[];
};

type JobConfigOverrides = {
    ignoredIssuePatterns?: Array<{
        codes?: string[];
        groups?: string[];
        severities?: string[];
        statusCodes?: number[];
        urlPattern: string;
    }>;
};

const baseUrl = "https://example.test";
const response = {} as AxiosResponse;

test("version output matches the package manifest", () => {
    const packageVersion = (JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {version: string}).version;
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));

    try {
        assert.throws(
            () => new LinkIssuesCmd(["--version"], "link-issues"),
            error => isCommandExit(error) && error.statusCode === 0
        );
    } finally {
        console.log = originalLog;
    }

    assert.deepEqual(lines, [`Link Issues Job Version ${packageVersion}`]);
});

function createJob({
    includeAssets = false,
    configOverrides = {}
}: {
    includeAssets?: boolean;
    configOverrides?: JobConfigOverrides;
} = {}): LinkIssues {
    const config = {
        getConfigBoolean: () => false,
        getConfigString: (key: string) => key === "baseUrl" ? baseUrl : "",
        getJobConfig: <T extends Record<string, unknown>>(defaults: T): T => ({
            ...defaults,
            ...configOverrides
        }) as T
    };
    const command = {
        arguments: {
            "-a": {active: includeAssets},
            "--include-assets": {active: includeAssets}
        }
    };
    const runtime = {
        config,
        events: {emit: () => undefined},
        urlHelper: {validateLocation: () => true},
        abortSignal: undefined,
        aborted: false
    };

    return new LinkIssues("link-issues", command as never, {} as never, runtime as never);
}

function makePage({
    url,
    canonicalUrl,
    body = "",
    rawLinks = [],
    referer = `${baseUrl}/source`
}: {
    url: string;
    canonicalUrl: string;
    body?: string;
    rawLinks?: PageLink[];
    referer?: string;
}): PageData {
    const jsdom = new JSDOM(
        `<!doctype html><html><head><link rel="canonical" href="${canonicalUrl}"></head><body>${body}</body></html>`,
        {url}
    );

    return {
        location: {
            url,
            rawUrl: url,
            referer,
            htmlSnippet: `<a href="${url}">test page</a>`
        },
        links: [],
        rawLinks,
        parseWarnings: [],
        contentType: "text/html",
        jsdom: jsdom.window.document
    };
}

function javascriptLink(referer: string): PageLink {
    return {
        rawHref: "javascript:void(0)",
        hasHref: true,
        referer,
        htmlSnippet: '<a href="javascript:void(0)">Bad link</a>',
        zone: "main",
        isExternal: false,
        isCrawlable: false
    };
}

function pageLink({
    rawHref,
    referer,
    htmlSnippet,
    normalizedUrl,
    zone = "main",
    target,
    rel
}: {
    rawHref: string;
    referer: string;
    htmlSnippet: string;
    normalizedUrl: string;
    zone?: PageLink["zone"];
    target?: string;
    rel?: string;
}): PageLink {
    return {
        rawHref,
        hasHref: true,
        referer,
        htmlSnippet,
        normalizedUrl,
        zone,
        target,
        rel,
        isExternal: false,
        isCrawlable: true
    };
}

function issues(job: LinkIssues): IssueLike[] {
    return job.issues as IssueLike[];
}

function assets(job: LinkIssues): AssetLike[] {
    return Array.from(job.assetLinks.values()) as AssetLike[];
}

function shouldSuppressIssue(job: LinkIssues, issue: IssueLike): boolean {
    return (job as unknown as {
        shouldSuppressIssue(candidate: IssueLike): boolean;
    }).shouldSuppressIssue(issue);
}

function auditDeferredFragments(job: LinkIssues): void {
    (job as unknown as {auditDeferredFragments(): void}).auditDeferredFragments();
}

function auditCanonicalTargets(job: LinkIssues): void {
    (job as unknown as {auditCanonicalTargets(): void}).auditCanonicalTargets();
}

function auditRedirects(job: LinkIssues): void {
    (job as unknown as {auditRedirects(): void}).auditRedirects();
}

test("query-string canonical variants still audit outgoing links and assets after canonical page was processed", () => {
    const job = createJob({includeAssets: true});
    const canonicalUrl = `${baseUrl}/`;
    const variantUrl = `${baseUrl}/?banner=3`;

    job.onPageReceived(response, makePage({url: canonicalUrl, canonicalUrl}));
    job.onPageReceived(response, makePage({
        url: variantUrl,
        canonicalUrl,
        body: '<img src="/banner-3.jpg" alt="">',
        rawLinks: [javascriptLink(variantUrl)]
    }));

    assert.ok(issues(job).some(issue => issue.code === "javascript-href" && issue.sourceUrl === variantUrl));
    assert.ok(assets(job).some(asset => asset.targetUrl === `${baseUrl}/banner-3.jpg` && asset.sourceUrl === variantUrl));
});

test("path-level non-canonical pages are fully audited regardless of crawl order", () => {
    const canonicalUrl = `${baseUrl}/canonical`;
    const duplicateUrl = `${baseUrl}/duplicate`;
    const sharedAssetUrl = `${baseUrl}/shared.jpg`;
    const canonicalPage = () => makePage({
        url: canonicalUrl,
        canonicalUrl,
        body: '<img src="/shared.jpg" alt="">'
    });
    const duplicatePage = () => makePage({
        url: duplicateUrl,
        canonicalUrl,
        body: '<img src="/shared.jpg" alt="">',
        rawLinks: [javascriptLink(duplicateUrl)]
    });

    [
        [canonicalPage(), duplicatePage()],
        [duplicatePage(), canonicalPage()]
    ].forEach(pages => {
        const job = createJob({includeAssets: true});
        pages.forEach(page => job.onPageReceived(response, page));

        assert.ok(issues(job).some(issue => issue.code === "non-canonical-internal-link"
            && issue.targetUrl === duplicateUrl));
        assert.ok(issues(job).some(issue => issue.code === "javascript-href"
            && issue.sourceUrl === duplicateUrl));
        assert.equal(assets(job).filter(asset => asset.targetUrl === sharedAssetUrl).length, 1);
        assert.equal(assets(job).find(asset => asset.targetUrl === sharedAssetUrl)?.occurrences?.length, 2);
    });
});

test("canonical-query-variant notices are still reported and suppressible", () => {
    const canonicalUrl = `${baseUrl}/`;
    const variantUrl = `${baseUrl}/?banner=3`;
    const reportingJob = createJob();

    reportingJob.onPageReceived(response, makePage({url: variantUrl, canonicalUrl}));

    assert.ok(issues(reportingJob).some(issue => issue.code === "canonical-query-variant"
        && issue.targetUrl === variantUrl
        && issue.finalUrl === canonicalUrl));

    const suppressedJob = createJob({
        configOverrides: {
            ignoredIssuePatterns: [{
                codes: ["canonical-query-variant"],
                urlPattern: "^/\\?banner=3$"
            }]
        }
    });
    suppressedJob.loadConfig();
    suppressedJob.onPageReceived(response, makePage({url: variantUrl, canonicalUrl}));

    assert.equal(issues(suppressedJob).some(issue => issue.code === "canonical-query-variant"), false);
});

test("non-canonical internal links report every source page that links to the target", () => {
    const job = createJob();
    const pageAUrl = `${baseUrl}/products/a`;
    const pageBUrl = `${baseUrl}/products/b`;
    const linkedUrl = `${baseUrl}/samples/`;
    const canonicalUrl = `${baseUrl}/samples`;

    [pageAUrl, pageBUrl].forEach(pageUrl => {
        job.onPageReceived(response, makePage({
            url: pageUrl,
            canonicalUrl: pageUrl,
            rawLinks: [
                pageLink({
                    rawHref: "/samples/",
                    referer: pageUrl,
                    htmlSnippet: '<a href="/samples/">Free sample</a>',
                    normalizedUrl: linkedUrl
                })
            ]
        }));
    });

    job.onPageReceived(response, makePage({
        url: linkedUrl,
        canonicalUrl,
        referer: pageAUrl
    }));

    const html = job.getReportHtml();
    assert.match(html, /Found on 2 pages \(2 occurrences\):/);
    assert.match(html, new RegExp(pageAUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(pageBUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("ignored issue patterns can target only HTTP 429 external link errors", () => {
    const job = createJob({
        configOverrides: {
            ignoredIssuePatterns: [{
                groups: ["External Links"],
                statusCodes: [429],
                urlPattern: ".*"
            }]
        }
    });
    job.loadConfig();

    const issue = {
        severity: "error",
        group: "External Links",
        code: "external-error",
        targetUrl: "https://external.example/resource"
    };

    assert.equal(shouldSuppressIssue(job, {...issue, statusCode: 429}), true);
    assert.equal(shouldSuppressIssue(job, {...issue, statusCode: 404}), false);
    assert.equal(shouldSuppressIssue(job, {
        ...issue,
        code: "external-bot-protection",
        statusCode: 429
    }), true);
    assert.equal(shouldSuppressIssue(job, {
        ...issue,
        group: "Asset Links",
        code: "asset-error",
        statusCode: 429
    }), false);
});

test("asset URLs are checked for undesirable decoded path characters when asset collection is enabled", () => {
    const pageUrl = `${baseUrl}/assets-page`;
    const badAssetUrl = `${baseUrl}/images/bad%20asset.png`;
    const enabledJob = createJob({includeAssets: true});

    enabledJob.onPageReceived(response, makePage({
        url: pageUrl,
        canonicalUrl: pageUrl,
        body: '<img src="/images/bad%20asset.png" alt="">'
    }));

    assert.ok(issues(enabledJob).some(issue => issue.code === "undesirable-path-character"
        && issue.targetUrl === badAssetUrl
        && issue.sourceUrl === pageUrl
        && issue.decodedPath === "/images/bad asset.png"
        && issue.assetKind === "image"
        && issue.sourceLabel === "img src"));

    const disabledJob = createJob({includeAssets: false});
    disabledJob.onPageReceived(response, makePage({
        url: pageUrl,
        canonicalUrl: pageUrl,
        body: '<img src="/images/bad%20asset.png" alt="">'
    }));

    assert.equal(issues(disabledJob).some(issue => issue.targetUrl === badAssetUrl), false);
});

test("target blank rel findings do not borrow wrapper metadata from matching good nav links", () => {
    const job = createJob();
    const pageAUrl = `${baseUrl}/account`;
    const pageBUrl = `${baseUrl}/mro`;
    const contactUrl = `${baseUrl}/contact`;
    const navSnippet = '<a href="/contact#form">Get Expert Advice</a>';
    const badSnippet = '<a href="/contact#form" target="_blank"><i>Slide team expert</i></a>';

    job.onPageReceived(response, makePage({
        url: pageAUrl,
        canonicalUrl: pageAUrl,
        rawLinks: [
            pageLink({
                rawHref: "/contact#form",
                referer: pageAUrl,
                htmlSnippet: navSnippet,
                normalizedUrl: contactUrl,
                zone: "nav"
            })
        ]
    }));
    job.onPageReceived(response, makePage({
        url: pageBUrl,
        canonicalUrl: pageBUrl,
        rawLinks: [
            pageLink({
                rawHref: "/contact#form",
                referer: pageBUrl,
                htmlSnippet: navSnippet,
                normalizedUrl: contactUrl,
                zone: "nav"
            }),
            pageLink({
                rawHref: "/contact#form",
                referer: pageBUrl,
                htmlSnippet: badSnippet,
                normalizedUrl: contactUrl,
                zone: "main",
                target: "_blank"
            })
        ]
    }));

    const finding = issues(job).find(issue => issue.code === "target-blank-rel");
    assert.equal(finding?.sourceUrl, pageBUrl);
    assert.equal(finding?.rawHref, "/contact#form");
    assert.equal(finding?.htmlSnippet, badSnippet);

    const html = job.getReportHtml();
    assert.match(html, /Anchor HTML: &lt;a href=&quot;\/contact#form&quot; target=&quot;_blank&quot;&gt;&lt;i&gt;Slide team expert&lt;\/i&gt;&lt;\/a&gt;/);
    assert.match(html, /Found on 1 page \(1 occurrence\):/);
    assert.match(html, new RegExp(pageBUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(html, /Wrapper link: likely nav/);
    assert.doesNotMatch(html, new RegExp(pageAUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("target url wrapper fallback still groups plain target status issues", () => {
    const job = createJob();
    const pageAUrl = `${baseUrl}/`;
    const pageBUrl = `${baseUrl}/products`;
    const brokenUrl = `${baseUrl}/old-page`;

    [pageAUrl, pageBUrl].forEach(pageUrl => {
        job.onPageReceived(response, makePage({
            url: pageUrl,
            canonicalUrl: pageUrl,
            rawLinks: [
                pageLink({
                    rawHref: "/old-page",
                    referer: pageUrl,
                    htmlSnippet: '<a href="/old-page">Old page</a>',
                    normalizedUrl: brokenUrl,
                    zone: "nav"
                })
            ]
        }));
    });

    job.onHeadersReceived({status: 404} as AxiosResponse, {
        url: brokenUrl,
        rawUrl: "/old-page",
        referer: pageBUrl,
        htmlSnippet: '<a href="/old-page">Old page</a>',
        statusCode: 404
    });

    const html = job.getReportHtml();
    assert.match(html, /Wrapper link: likely nav; found on 2 of 2 scanned pages \(100%\), 2 occurrences\./);
    assert.match(html, new RegExp(pageAUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(pageBUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("plain target status issues report every source page below the wrapper threshold", () => {
    const job = createJob();
    const pageAUrl = `${baseUrl}/account`;
    const pageBUrl = `${baseUrl}/products`;
    const pageCUrl = `${baseUrl}/contact`;
    const brokenUrl = `${baseUrl}/old-page`;

    [pageAUrl, pageBUrl].forEach(pageUrl => {
        job.onPageReceived(response, makePage({
            url: pageUrl,
            canonicalUrl: pageUrl,
            rawLinks: [
                pageLink({
                    rawHref: "/old-page",
                    referer: pageUrl,
                    htmlSnippet: '<a href="/old-page">Old page</a>',
                    normalizedUrl: brokenUrl,
                    zone: "main"
                })
            ]
        }));
    });
    job.onPageReceived(response, makePage({
        url: pageCUrl,
        canonicalUrl: pageCUrl
    }));

    job.onHeadersReceived({status: 404} as AxiosResponse, {
        url: brokenUrl,
        rawUrl: "/old-page",
        referer: pageAUrl,
        htmlSnippet: '<a href="/old-page">Old page</a>',
        statusCode: 404
    });

    const html = job.getReportHtml();
    assert.match(html, /Found on 2 pages \(2 occurrences\):/);
    assert.match(html, new RegExp(pageAUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(pageBUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(html, /Wrapper link:/);
});

test("incomplete page audits are reported with all target sources and completeness counts", () => {
    const job = createJob();
    const pageAUrl = `${baseUrl}/products/a`;
    const pageBUrl = `${baseUrl}/products/b`;
    const failedUrl = `${baseUrl}/failed-page`;
    const documentUrl = `${baseUrl}/manual.pdf`;

    [pageAUrl, pageBUrl].forEach(pageUrl => {
        job.onPageReceived(response, makePage({
            url: pageUrl,
            canonicalUrl: pageUrl,
            rawLinks: [
                pageLink({
                    rawHref: "/failed-page",
                    referer: pageUrl,
                    htmlSnippet: '<a href="/failed-page">Failed page</a>',
                    normalizedUrl: failedUrl
                })
            ]
        }));
    });

    job.onPageReceived(null, {
        location: {
            url: failedUrl,
            rawUrl: "/failed-page",
            referer: pageAUrl,
            htmlSnippet: '<a href="/failed-page">Failed page</a>'
        },
        links: [],
        rawLinks: [],
        parseWarnings: [],
        contentType: "text/html",
        auditOutcome: {
            status: "failed",
            phase: "body-fetch",
            contentType: "text/html",
            message: "GET request returned HTTP 503.",
            statusCode: 503
        }
    });
    job.onPageReceived(null, {
        location: {
            url: documentUrl,
            rawUrl: "/manual.pdf",
            referer: pageAUrl
        },
        links: [],
        rawLinks: [],
        parseWarnings: [],
        contentType: "application/pdf",
        auditOutcome: {
            status: "non-html",
            contentType: "application/pdf"
        }
    });

    assert.ok(issues(job).some(issue => issue.code === "page-audit-incomplete"
        && issue.targetUrl === failedUrl
        && issue.statusCode === 503));
    const html = job.getReportHtml();
    assert.match(html, /Repeated issue: likely shared layout\/template; found on 2 of 2 scanned pages \(100%\), 2 occurrences\./);
    assert.match(html, new RegExp(pageAUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(pageBUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const reportData = job.getReportData();
    assert.equal(reportData["Scanned Pages"], 2);
    assert.equal(reportData["Incomplete Page Audits"], 1);
    assert.equal(reportData["Confirmed Non-HTML Resources"], 1);
});

test("cross-page fragment checks follow redirects to the final parsed page", () => {
    const sourceUrl = `${baseUrl}/source`;
    const redirectedUrl = `${baseUrl}/old-section`;
    const finalUrl = `${baseUrl}/new-section`;
    const fragmentUrl = `${redirectedUrl}#details`;
    const job = createJob();

    job.onPageReceived(response, makePage({
        url: sourceUrl,
        canonicalUrl: sourceUrl,
        rawLinks: [pageLink({
            rawHref: "/old-section#details",
            referer: sourceUrl,
            htmlSnippet: '<a href="/old-section#details">Details</a>',
            normalizedUrl: fragmentUrl
        })]
    }));
    job.onHeadersReceived({status: 302} as AxiosResponse, {
        url: redirectedUrl,
        rawUrl: "/old-section#details",
        referer: sourceUrl,
        redirectedTo: finalUrl,
        redirectChain: [redirectedUrl, finalUrl],
        statusCode: 302
    });
    job.onPageReceived(response, makePage({
        url: finalUrl,
        canonicalUrl: finalUrl,
        body: '<h2 id="details">Details</h2>',
        referer: redirectedUrl
    }));

    auditDeferredFragments(job);

    assert.equal(issues(job).some(issue => issue.code === "missing-cross-page-fragment"), false);
    assert.equal(issues(job).some(issue => issue.code === "cross-page-fragment-unverified"), false);
});

test("cross-page fragment checks report failed and unresolved targets but skip confirmed non-html targets", () => {
    const sourceUrl = `${baseUrl}/source`;
    const secondSourceUrl = `${baseUrl}/second-source`;
    const failedUrl = `${baseUrl}/failed`;
    const unresolvedUrl = `${baseUrl}/unresolved`;
    const documentUrl = `${baseUrl}/manual.pdf`;
    const job = createJob();

    job.onPageReceived(response, makePage({
        url: sourceUrl,
        canonicalUrl: sourceUrl,
        rawLinks: [
            pageLink({
                rawHref: "/failed#details",
                referer: sourceUrl,
                htmlSnippet: '<a href="/failed#details">Failed details</a>',
                normalizedUrl: `${failedUrl}#details`
            }),
            pageLink({
                rawHref: "/unresolved#details",
                referer: sourceUrl,
                htmlSnippet: '<a href="/unresolved#details">Unresolved details</a>',
                normalizedUrl: `${unresolvedUrl}#details`
            }),
            pageLink({
                rawHref: "/manual.pdf#page=2",
                referer: sourceUrl,
                htmlSnippet: '<a href="/manual.pdf#page=2">Manual page 2</a>',
                normalizedUrl: `${documentUrl}#page=2`
            })
        ]
    }));
    job.onPageReceived(response, makePage({
        url: secondSourceUrl,
        canonicalUrl: secondSourceUrl,
        rawLinks: [pageLink({
            rawHref: "/unresolved#details",
            referer: secondSourceUrl,
            htmlSnippet: '<a href="/unresolved#details">Unresolved details</a>',
            normalizedUrl: `${unresolvedUrl}#details`
        })]
    }));
    job.onPageReceived(null, {
        location: {
            url: failedUrl,
            rawUrl: "/failed",
            referer: sourceUrl
        },
        links: [],
        rawLinks: [],
        parseWarnings: [],
        contentType: "text/html",
        auditOutcome: {
            status: "failed",
            phase: "body-fetch",
            contentType: "text/html",
            message: "GET timed out.",
            errorCode: "ETIMEDOUT"
        }
    });
    job.onPageReceived(null, {
        location: {
            url: documentUrl,
            rawUrl: "/manual.pdf",
            referer: sourceUrl
        },
        links: [],
        rawLinks: [],
        parseWarnings: [],
        contentType: "application/pdf",
        auditOutcome: {
            status: "non-html",
            contentType: "application/pdf"
        }
    });

    auditDeferredFragments(job);

    const unverifiedTargets = issues(job)
        .filter(issue => issue.code === "cross-page-fragment-unverified")
        .map(issue => issue.targetUrl);
    assert.equal(unverifiedTargets.filter(targetUrl => targetUrl === `${failedUrl}#details`).length, 1);
    assert.equal(unverifiedTargets.filter(targetUrl => targetUrl === `${unresolvedUrl}#details`).length, 2);
    assert.equal(unverifiedTargets.includes(`${documentUrl}#page=2`), false);
    assert.equal(issues(job).some(issue => issue.code === "missing-cross-page-fragment"), false);
    assert.equal(job.getReportData()["Unverified Deferred Checks"], 3);
    const html = job.getReportHtml();
    assert.match(html, /Repeated issue: likely shared layout\/template; found on 2 of 2 scanned pages \(100%\), 2 occurrences\./);
    assert.match(html, new RegExp(sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, new RegExp(secondSourceUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("cross-page fragments distinguish a verified missing anchor from an incomplete check", () => {
    const sourceUrl = `${baseUrl}/source`;
    const targetUrl = `${baseUrl}/target`;
    const job = createJob();

    job.onPageReceived(response, makePage({
        url: sourceUrl,
        canonicalUrl: sourceUrl,
        rawLinks: [pageLink({
            rawHref: "/target#missing",
            referer: sourceUrl,
            htmlSnippet: '<a href="/target#missing">Missing section</a>',
            normalizedUrl: `${targetUrl}#missing`
        })]
    }));
    job.onPageReceived(response, makePage({
        url: targetUrl,
        canonicalUrl: targetUrl,
        body: '<h2 id="present">Present section</h2>',
        referer: sourceUrl
    }));

    auditDeferredFragments(job);

    assert.ok(issues(job).some(issue => issue.code === "missing-cross-page-fragment"
        && issue.targetUrl === `${targetUrl}#missing`));
    assert.equal(issues(job).some(issue => issue.code === "cross-page-fragment-unverified"), false);
});

test("missing canonical and redirect final statuses produce explicit unverified findings", () => {
    const pageUrl = `${baseUrl}/source`;
    const canonicalUrl = `${baseUrl}/canonical`;
    const redirectUrl = `${baseUrl}/redirect`;
    const finalUrl = `${baseUrl}/final`;
    const job = createJob();

    job.onPageReceived(response, makePage({url: pageUrl, canonicalUrl}));
    job.onHeadersReceived({status: 302} as AxiosResponse, {
        url: redirectUrl,
        rawUrl: "/redirect",
        referer: pageUrl,
        redirectedTo: finalUrl,
        redirectChain: [redirectUrl, finalUrl],
        statusCode: 302
    });

    auditCanonicalTargets(job);
    auditRedirects(job);

    assert.ok(issues(job).some(issue => issue.code === "canonical-target-unverified"
        && issue.targetUrl === canonicalUrl
        && issue.sourceUrl === pageUrl));
    assert.ok(issues(job).some(issue => issue.code === "redirect-final-target-unverified"
        && issue.targetUrl === redirectUrl
        && issue.finalUrl === finalUrl));
    assert.equal(job.getReportData()["Unverified Deferred Checks"], 2);
});

test("report aggregation traverses target occurrences once per grouped entry", () => {
    const job = createJob();
    const targetUrl = `${baseUrl}/missing`;
    const occurrenceCount = 500;
    const occurrences = Array.from({length: occurrenceCount}, (_value, index) => ({
        referer: `${baseUrl}/source-${index}`,
        zone: "main" as const
    }));
    let occurrenceTraversals = 0;
    const observedOccurrences = new Proxy(occurrences, {
        get(target, property, receiver) {
            if(property === "forEach") {
                return (callback: (occurrence: typeof occurrences[number], index: number) => void) => {
                    occurrenceTraversals++;
                    target.forEach(callback);
                };
            }
            return Reflect.get(target, property, receiver);
        }
    });
    job.issueOccurrences.set(targetUrl, {
        targetUrl,
        occurrenceCount,
        pageUrls: new Set(occurrences.map(occurrence => occurrence.referer)),
        wrapperOccurrenceCount: 0,
        wrapperPageUrls: new Set(),
        zones: {
            nav: 0,
            header: 0,
            footer: 0,
            aside: 0,
            "before-main": 0,
            "after-main": 0,
            main: occurrenceCount,
            unknown: 0
        },
        occurrences: observedOccurrences
    });

    occurrences.forEach(occurrence => {
        job.onHeadersReceived({status: 404} as AxiosResponse, {
            url: targetUrl,
            rawUrl: "/missing",
            referer: occurrence.referer
        });
    });

    const entries = (job as unknown as {
        getReportEntries(rawIssues: IssueLike[]): Array<{count: number; sourceUrls: Set<string>}>;
    }).getReportEntries(issues(job));

    assert.equal(entries.length, 1);
    assert.equal(entries[0].count, occurrenceCount);
    assert.equal(entries[0].sourceUrls.size, occurrenceCount);
    assert.equal(occurrenceTraversals, 1);
});
