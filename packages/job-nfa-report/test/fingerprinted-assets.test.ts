import assert from "node:assert/strict";
import test from "node:test";

import {JSDOM} from "jsdom";
import type {JSONObject, PageData} from "@arachnodex/core";

import NfaReportCmd from "../src/cmd.ts";
import NfaReport from "../src/index.ts";

type FindingLike = {
    targetUrl: string;
};

type JobConfig = Record<string, unknown>;

const baseUrl = "https://slide.local";

function createJob(args: string[] = [], configOverrides: JobConfig = {}): NfaReport {
    const config = {
        getConfigBoolean: (key: string) => key === "disableColorOutput",
        getConfigString: (key: string) => key === "baseUrl" ? baseUrl : "",
        getJobConfig: <T extends JobConfig>(
            defaults: T,
            _command: unknown,
            _required: boolean,
            normalize?: (value: T) => void
        ): T => {
            const value = {
                ...defaults,
                ...configOverrides,
                qsProps: {...defaults.qsProps as JSONObject},
                ignorePatterns: [...defaults.ignorePatterns as string[]],
                assetExtensions: [...defaults.assetExtensions as string[]],
                mediaExtensions: [...defaults.mediaExtensions as string[]],
                documentExtensions: [...defaults.documentExtensions as string[]]
            };
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
    const command = new NfaReportCmd(args, "nfa-report");
    const job = new NfaReport("nfa-report", command, {} as never, runtime as never);
    job.loadConfig();

    return job;
}

function makePage(body: string): PageData {
    const url = `${baseUrl}/`;
    const jsdom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {url});

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

function findings(job: NfaReport): FindingLike[] {
    const state = job as unknown as {findings: Map<string, FindingLike>};
    return Array.from(state.findings.values());
}

test("long readable stems with a separate hash segment are treated as fingerprinted", () => {
    const job = createJob();

    job.onPageReceived(null, makePage(
        '<img src="/assets/blog-images/JanuaryPromotionBetsiBlog.ae26cd8d0d5e.png" alt="">'
    ));

    assert.equal(findings(job).some(finding => finding.targetUrl
        === `${baseUrl}/assets/blog-images/JanuaryPromotionBetsiBlog.ae26cd8d0d5e.png`), false);
});

test("all-letter hash segments are accepted in the configured separator position", () => {
    const job = createJob();

    job.onPageReceived(null, makePage(
        '<script src="/sc-skins/slide2016/assets/compiled/js/pc-bundle.DbPBQRky.js"></script>'
    ));

    assert.equal(findings(job).some(finding => finding.targetUrl
        === `${baseUrl}/sc-skins/slide2016/assets/compiled/js/pc-bundle.DbPBQRky.js`), false);
});

test("named assets without a hash segment are still reported", () => {
    const job = createJob();

    job.onPageReceived(null, makePage('<img src="/assets/blog-images/JanuaryPromotionBetsiBlog.png" alt="">'));

    assert.ok(findings(job).some(finding => finding.targetUrl
        === `${baseUrl}/assets/blog-images/JanuaryPromotionBetsiBlog.png`));
});

test("off-domain assets without hash segments are not reported", () => {
    const job = createJob();

    job.onPageReceived(null, makePage([
        '<img src="https://cdn.example.com/assets/logo.png" alt="">',
        '<script src="//static.example.net/assets/app.js"></script>',
        '<link rel="stylesheet" href="/assets/app.css">'
    ].join("")));

    assert.equal(findings(job).some(finding => finding.targetUrl === "https://cdn.example.com/assets/logo.png"), false);
    assert.equal(findings(job).some(finding => finding.targetUrl === "https://static.example.net/assets/app.js"), false);
    assert.ok(findings(job).some(finding => finding.targetUrl === `${baseUrl}/assets/app.css`));
});

test("hash-only filenames are still reported as non-fingerprinted", () => {
    const job = createJob();

    job.onPageReceived(null, makePage('<img src="/assets/blog-images/ae26cd8d0d5e.png" alt="">'));

    assert.ok(findings(job).some(finding => finding.targetUrl
        === `${baseUrl}/assets/blog-images/ae26cd8d0d5e.png`));
});

test("hash-like segments without dot-hash-dot filename shape are reported", () => {
    const job = createJob();

    job.onPageReceived(null, makePage([
        '<img src="/assets/app-2f4a9c0e.css" alt="">',
        '<script src="/assets/runtime_9A7b6C5d.js"></script>'
    ].join("")));

    assert.ok(findings(job).some(finding => finding.targetUrl === `${baseUrl}/assets/app-2f4a9c0e.css`));
    assert.ok(findings(job).some(finding => finding.targetUrl === `${baseUrl}/assets/runtime_9A7b6C5d.js`));
});

test("configured fingerprint separators can accept dash and underscore hash boundaries", () => {
    const job = createJob([], {fingerprintSeparatorPattern: "[._-]"});

    job.onPageReceived(null, makePage([
        '<img src="/assets/app-2f4a9c0e.css" alt="">',
        '<script src="/assets/runtime_9A7b6C5d.js"></script>'
    ].join("")));

    assert.equal(findings(job).some(finding => finding.targetUrl === `${baseUrl}/assets/app-2f4a9c0e.css`), false);
    assert.equal(findings(job).some(finding => finding.targetUrl === `${baseUrl}/assets/runtime_9A7b6C5d.js`), false);
});

test("plain eight-letter filename words and sku query params do not count as fingerprints", () => {
    const job = createJob();

    job.onPageReceived(null, makePage('<a href="/tds/Slide-Products-TDS_60882.pdf?sku=60882">TDS</a>'));

    assert.ok(findings(job).some(finding => finding.targetUrl
        === `${baseUrl}/tds/Slide-Products-TDS_60882.pdf?sku=60882`));
});

test("default v query parameter accepts unix timestamp cache busting", () => {
    const job = createJob();

    job.onPageReceived(null, makePage('<link rel="stylesheet" href="/assets/app.css?v=1718048501">'));

    assert.equal(findings(job).some(finding => finding.targetUrl === `${baseUrl}/assets/app.css?v=1718048501`), false);
});

test("prompt switch renders grouped copy/paste repair prompts", async () => {
    const job = createJob(["-p"]);
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown): void => {
        output.push(String(message ?? ""));
    };

    try {
        job.onPageReceived(null, makePage('<img src="/assets/blog-images/JanuaryPromotionBetsiBlog.png" alt="">'));
        await job.onEnd();
    } finally {
        console.log = originalLog;
    }

    const text = output.join("\n");
    assert.match(text, /NFA Prompt Report/);
    assert.match(text, /PROMPT: Asset References/);
    assert.match(text, /Task: add stable filename fingerprints/);
    assert.match(text, /https:\/\/slide\.local\/assets\/blog-images\/JanuaryPromotionBetsiBlog\.png/);
});
