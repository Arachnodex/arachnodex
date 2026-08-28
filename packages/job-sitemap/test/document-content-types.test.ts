import assert from "node:assert/strict";
import test from "node:test";

import type {AxiosResponse} from "axios";
import type {PageData} from "@arachnodex/core";

import Sitemap from "../src/index.ts";

const baseUrl = "https://example.test";

function createJob({
    includeDocs = true,
    includeDocPattern = "((x-)?pdf)|(epub\\+zip)"
}: {
    includeDocs?: boolean;
    includeDocPattern?: string;
} = {}): Sitemap {
    const config = {
        getJobConfig: <T extends Record<string, unknown>>(defaults: T): T => ({
            ...defaults,
            includeDocs,
            includeDocPattern
        }) as T
    };
    const runtime = {
        config,
        events: {emit: () => undefined},
        urlHelper: {}
    };
    const job = new Sitemap("sitemap", {arguments: {}} as never, {} as never, runtime as never);
    job.loadConfig();
    return job;
}

function response(status: number, contentType: string, lastModified = "Mon, 01 Jan 2024 00:00:00 GMT") {
    return {
        status,
        headers: {
            "content-type": contentType,
            "last-modified": lastModified
        }
    } as AxiosResponse;
}

function pageData(url: string, contentType: string, auditOutcome: PageData["auditOutcome"]): PageData {
    return {
        location: {url, rawUrl: new URL(url).pathname},
        links: [],
        rawLinks: [],
        parseWarnings: [],
        contentType,
        auditOutcome
    };
}

function flushHeaderCandidates(job: Sitemap): void {
    (job as unknown as {addUnresolvedHeaderDocuments(): void}).addUnresolvedHeaderDocuments();
}

test("authoritative GET document types are matched by includeDocPattern", () => {
    const job = createJob();
    const pdfUrl = `${baseUrl}/manual`;
    const epubUrl = `${baseUrl}/book`;

    job.onHeadersReceived(response(200, "text/plain"), {url: pdfUrl, rawUrl: "/manual"});
    job.onPageReceived(null, pageData(pdfUrl, "application/pdf", {
        status: "non-html",
        contentType: "application/pdf",
        lastModified: "Tue, 02 Jan 2024 00:00:00 GMT"
    }));
    job.onHeadersReceived(response(200, "application/octet-stream"), {url: epubUrl, rawUrl: "/book"});
    job.onPageReceived(null, pageData(epubUrl, "application/epub+zip", {
        status: "non-html",
        contentType: "application/epub+zip"
    }));

    assert.equal(job.docUrlCount, 2);
    assert.deepEqual(job.loggedUrls, [pdfUrl, epubUrl]);
});

test("GET HTML classification overrides a misleading document HEAD response", () => {
    const job = createJob();
    const url = `${baseUrl}/download`;

    job.onHeadersReceived(response(200, "application/pdf"), {url, rawUrl: "/download"});
    job.onPageReceived(response(200, "TEXT/HTML; Charset=UTF-8"), pageData(url, "text/html", {
        status: "complete",
        contentType: "text/html"
    }));
    flushHeaderCandidates(job);

    assert.equal(job.pageUrlCount, 1);
    assert.equal(job.docUrlCount, 0);
    assert.deepEqual(job.loggedUrls, [url]);
});

test("matching HEAD and GET document types produce one document entry", () => {
    const job = createJob();
    const url = `${baseUrl}/manual.pdf`;

    job.onHeadersReceived(response(200, "application/pdf"), {url, rawUrl: "/manual.pdf"});
    job.onPageReceived(null, pageData(url, "application/pdf", {
        status: "non-html",
        contentType: "application/pdf"
    }));
    flushHeaderCandidates(job);

    assert.equal(job.docUrlCount, 1);
    assert.deepEqual(job.loggedUrls, [url]);
});

test("unresolved HEAD document candidates retain legacy includeDocPattern behavior", () => {
    const job = createJob();
    const url = `${baseUrl}/legacy.pdf`;

    job.onHeadersReceived(response(200, "application/pdf"), {url, rawUrl: "/legacy.pdf"});
    flushHeaderCandidates(job);

    assert.equal(job.docUrlCount, 1);
    assert.deepEqual(job.loggedUrls, [url]);
});

test("includeDocs still disables document collection on both HEAD and GET paths", () => {
    const job = createJob({includeDocs: false});
    const url = `${baseUrl}/manual.pdf`;

    job.onHeadersReceived(response(200, "application/pdf"), {url, rawUrl: "/manual.pdf"});
    job.onPageReceived(null, pageData(url, "application/pdf", {
        status: "non-html",
        contentType: "application/pdf"
    }));
    flushHeaderCandidates(job);

    assert.equal(job.docUrlCount, 0);
    assert.deepEqual(job.loggedUrls, []);
});
