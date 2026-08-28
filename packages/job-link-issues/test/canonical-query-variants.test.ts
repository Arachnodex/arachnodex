import assert from "node:assert/strict";
import test from "node:test";

import type {AxiosResponse} from "axios";
import {JSDOM} from "jsdom";
import type {PageData, PageLink} from "@arachnodex/core";

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
