import assert from "node:assert/strict";
import test from "node:test";

import type {AxiosResponse} from "axios";
import {JSDOM} from "jsdom";
import type {PageData, PageLink} from "@arachnodex/core";

import LinkIssues from "../src/index.ts";

type IssueLike = {
    code: string;
    targetUrl?: string;
    sourceUrl?: string;
    finalUrl?: string;
    decodedPath?: string;
    assetKind?: string;
    sourceLabel?: string;
};

type AssetLike = {
    targetUrl: string;
    sourceUrl: string;
};

type JobConfigOverrides = {
    ignoredIssuePatterns?: Array<{
        codes?: string[];
        groups?: string[];
        severities?: string[];
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
    rawLinks = []
}: {
    url: string;
    canonicalUrl: string;
    body?: string;
    rawLinks?: PageLink[];
}): PageData {
    const jsdom = new JSDOM(
        `<!doctype html><html><head><link rel="canonical" href="${canonicalUrl}"></head><body>${body}</body></html>`,
        {url}
    );

    return {
        location: {
            url,
            rawUrl: url,
            referer: `${baseUrl}/source`,
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

function issues(job: LinkIssues): IssueLike[] {
    return job.issues as IssueLike[];
}

function assets(job: LinkIssues): AssetLike[] {
    return Array.from(job.assetLinks.values()) as AssetLike[];
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
    assert.ok(job.processedPageUrls.has(variantUrl));
});

test("path-level non-canonical duplicates still skip outgoing auditing after canonical page was processed", () => {
    const job = createJob({includeAssets: true});
    const canonicalUrl = `${baseUrl}/canonical`;
    const duplicateUrl = `${baseUrl}/duplicate`;

    job.onPageReceived(response, makePage({url: canonicalUrl, canonicalUrl}));
    job.onPageReceived(response, makePage({
        url: duplicateUrl,
        canonicalUrl,
        body: '<img src="/duplicate-only.jpg" alt="">',
        rawLinks: [javascriptLink(duplicateUrl)]
    }));

    assert.ok(issues(job).some(issue => issue.code === "non-canonical-internal-link" && issue.targetUrl === duplicateUrl));
    assert.equal(issues(job).some(issue => issue.code === "javascript-href" && issue.sourceUrl === duplicateUrl), false);
    assert.equal(assets(job).some(asset => asset.targetUrl === `${baseUrl}/duplicate-only.jpg` && asset.sourceUrl === duplicateUrl), false);
    assert.equal(job.processedPageUrls.has(duplicateUrl), false);
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
