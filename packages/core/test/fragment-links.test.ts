import assert from "node:assert/strict";
import test from "node:test";

import type {AxiosResponse} from "axios";

import {Arachnodex} from "../src/arachnodex.ts";
import type {AppConfig, Location, PageData} from "../src/definitions.ts";
import {ArachnodexRuntime} from "../src/runtime.ts";

function createConfig(): AppConfig {
    return {
        siteName: "Fragment test",
        domain: "example.test",
        baseUrl: "https://example.test",
        pathPrefix: "",
        entryFile: "",
        dontResetUrls: false,
        numThreads: 1,
        requestDelayMs: 0,
        requestTimeoutMs: 1000,
        requestTimeoutMaxRetries: 0,
        requestTls: {rejectUnauthorized: true},
        muteResponseStatus: true,
        muteAll: true,
        disableColorOutput: true,
        urlCantContain: [],
        urlMustContain: [],
        treatHashAsUniquePage: false,
        mail: {
            disabled: true,
            defaultSubject: "",
            developerRecipients: [],
            reportRecipients: [],
            errorRecipients: [],
            from: {},
            replyTo: [],
            transport: {
                host: "",
                port: 0,
                secure: false,
                tls: {rejectUnauthorized: true}
            }
        }
    };
}

test("default crawl deduplication preserves observed fragments for jobs", () => {
    const runtime = new ArachnodexRuntime();
    runtime.config.appConfig = createConfig();
    const command = {
        profilerEnabled: () => false,
        getVerbosityLevel: () => 0,
        getJobs: () => ({})
    };
    const crawler = new Arachnodex(command as never, runtime);
    const queued: Location[] = [];
    crawler.addNewLocation = async location => {
        queued.push({...location});
        return true;
    };

    let receivedPageData: PageData|undefined;
    crawler.jobs.jobs.push({
        onPageReceived: (_response: AxiosResponse|null, pageData: PageData) => {
            receivedPageData = pageData;
        }
    } as never);

    const location: Location = {
        url: "https://example.test/source",
        rawUrl: "/source"
    };
    const response = {
        data: `<!doctype html><html><body>
            <a href="#same-page">Same page</a>
            <a href="/target#section-one">First section</a>
            <a href="/target#section-two">Second section</a>
        </body></html>`,
        status: 200,
        statusText: "OK",
        headers: {"content-type": "text/html"},
        config: {headers: {}}
    } as unknown as AxiosResponse;

    crawler.pageReceivedEvent(response, location);

    assert.ok(receivedPageData);
    assert.deepEqual(
        receivedPageData.rawLinks.map(link => link.normalizedUrl),
        [
            "https://example.test/source#same-page",
            "https://example.test/target#section-one",
            "https://example.test/target#section-two"
        ]
    );
    assert.deepEqual(receivedPageData.rawLinks.map(link => link.isCrawlable), [true, true, true]);
    assert.deepEqual(receivedPageData.links, ["/target#section-one"]);
    assert.equal(queued.length, 1);

    assert.equal(runtime.urlHelper.prepareUrl(queued[0]), true);
    assert.equal(queued[0].url, "https://example.test/target");
    assert.equal(queued[0].hash, "section-one");
});

test("multi-hop redirects preserve the original source page and anchor markup", () => {
    const runtime = new ArachnodexRuntime();
    runtime.config.appConfig = createConfig();
    const command = {
        profilerEnabled: () => false,
        getVerbosityLevel: () => 0,
        getJobs: () => ({})
    };
    const crawler = new Arachnodex(command as never, runtime);
    const queued: Location[] = [];
    crawler.addNewLocation = async location => {
        queued.push({...location, redirectChain: [...(location.redirectChain ?? [])]});
        return true;
    };

    const sourceUrl = "https://example.test/source";
    const anchorHtml = '<a href="/old">Old location</a>';
    const firstRedirect: Location = {
        url: "https://example.test/old",
        rawUrl: "/old",
        referer: sourceUrl,
        htmlSnippet: anchorHtml
    };
    crawler.visited[firstRedirect.url] = {...firstRedirect};

    crawler.headersReceivedEvent({
        status: 301,
        statusText: "Moved Permanently",
        headers: {location: "/intermediate"}
    } as AxiosResponse, firstRedirect);

    const intermediate = queued[0];
    assert.equal(intermediate.referer, sourceUrl);
    assert.equal(intermediate.htmlSnippet, anchorHtml);
    assert.equal(intermediate.redirectedFrom, firstRedirect.url);
    assert.equal(intermediate.redirectRoot, firstRedirect.url);
    assert.deepEqual(intermediate.redirectChain, [
        firstRedirect.url,
        "https://example.test/intermediate"
    ]);

    crawler.headersReceivedEvent({
        status: 302,
        statusText: "Found",
        headers: {location: "/final"}
    } as AxiosResponse, intermediate);

    const finalLocation = queued[1];
    assert.equal(finalLocation.referer, sourceUrl);
    assert.equal(finalLocation.htmlSnippet, anchorHtml);
    assert.equal(finalLocation.redirectedFrom, intermediate.url);
    assert.equal(finalLocation.redirectRoot, firstRedirect.url);
    assert.deepEqual(finalLocation.redirectChain, [
        firstRedirect.url,
        intermediate.url,
        "https://example.test/final"
    ]);
});
