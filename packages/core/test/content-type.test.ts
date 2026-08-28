import assert from "node:assert/strict";
import {Readable} from "node:stream";
import test from "node:test";

import axios, {type AxiosResponse} from "axios";
import EventEmitter from "eventemitter3";

import {ArachnodexThread} from "../src/arachnodexThread.ts";
import type {Location, PageAuditOutcome} from "../src/definitions.ts";
import {isHtmlContentType, normalizeContentTypeHeader} from "../src/services/contentType.ts";

const testUrl = "https://example.test/page";

function response<T>(status: number, contentType: string, data: T): AxiosResponse<T> {
    return {
        data,
        status,
        statusText: String(status),
        headers: {'content-type': contentType},
        config: {headers: {}}
    } as unknown as AxiosResponse<T>;
}

function createThread(maxRetries = 0) {
    const events = new EventEmitter();
    const abortController = new AbortController();
    const runtime = {
        aborted: false,
        abortSignal: abortController.signal,
        activeThreads: new Map(),
        throttledRequestCount: 0,
        events,
        config: {
            getConfigBoolean: (_key: string, _scope?: unknown, fallback = false) => fallback,
            getConfigNumber: (key: string) => {
                if(key === 'requestTimeoutMs') {
                    return 1000;
                }
                if(key === 'requestTimeoutMaxRetries') {
                    return maxRetries;
                }
                return 0;
            }
        },
        lock: {
            forUnlock: async () => undefined,
            lock: () => undefined,
            unlock: () => undefined
        },
        turnMutex: {
            acquire: async () => () => undefined
        }
    };
    const thread = new ArachnodexThread(0, runtime as never);
    runtime.activeThreads.set(thread, {
        lastRequestTs: null,
        inFlight: false,
        claimed: false
    });
    const location: Location = {
        url: testUrl,
        rawUrl: "/page",
        referer: "https://example.test/"
    };
    const visited: Record<string, Location> = {[testUrl]: location};

    return {events, location, runtime, thread, visited};
}

test("HTML content types are normalized case-insensitively with standard and legacy variants", () => {
    [
        "text/html",
        "TEXT/HTML; Charset=UTF-8",
        "application/xhtml+xml",
        "Application/XHTML+XML; charset=utf-8",
        "application/html",
        "text/xhtml",
        "application/xhtml",
        "text/x-html",
        "text/x-server-parsed-html",
        "application/vnd.wap.xhtml+xml"
    ].forEach(contentType => assert.equal(isHtmlContentType(contentType), true, contentType));

    ["application/json", "application/xml", "text/plain", "application/pdf"]
        .forEach(contentType => assert.equal(isHtmlContentType(contentType), false, contentType));
    assert.equal(normalizeContentTypeHeader(" Text/HTML ; charset=UTF-8"), "text/html");
});

test("GET content type overrides a misleading non-HTML HEAD content type", async t => {
    const {events, location, thread, visited} = createThread();
    let pageResponse: AxiosResponse|null = null;
    events.on('page-received', (received: AxiosResponse|null) => {
        pageResponse = received;
    });

    t.mock.method(axios, 'head', async () => response(200, "application/pdf", undefined));
    t.mock.method(axios, 'get', async () => response(
        200,
        "Application/XHTML+XML; Charset=UTF-8",
        Readable.from(["<html><body>ok</body></html>"])
    ));

    await thread.fetch(location, visited);

    assert.equal(pageResponse?.data, "<html><body>ok</body></html>");
    assert.equal(visited[testUrl].dataReceived, true);
});

test("confirmed non-HTML GET responses are destroyed without buffering", async t => {
    const {events, location, thread, visited} = createThread();
    let readCount = 0;
    const body = new Readable({
        read() {
            readCount++;
            this.push(Buffer.alloc(1024));
            this.push(null);
        }
    });
    let outcome: PageAuditOutcome|undefined;
    events.on('page-received', (_response: AxiosResponse|null, _location: Location, value?: PageAuditOutcome) => {
        outcome = value;
    });

    t.mock.method(axios, 'head', async () => response(200, "application/pdf", undefined));
    t.mock.method(axios, 'get', async () => response(200, "application/pdf", body));

    await thread.fetch(location, visited);

    assert.equal(outcome?.status, "non-html");
    assert.equal(body.destroyed, true);
    assert.equal(readCount, 0);
    assert.equal(visited[testUrl].dataReceived, undefined);
});

test("GET replaces HEAD when the server rejects HEAD", async t => {
    const {events, location, thread, visited} = createThread();
    const statuses: number[] = [];
    let pageResponse: AxiosResponse|null = null;
    events.on('headers-received', (received: AxiosResponse) => statuses.push(received.status));
    events.on('page-received', (received: AxiosResponse|null) => {
        pageResponse = received;
    });

    t.mock.method(axios, 'head', async () => response(405, "text/plain", undefined));
    t.mock.method(axios, 'get', async () => response(
        200,
        "text/html; charset=utf-8",
        Readable.from(["<html></html>"])
    ));

    await thread.fetch(location, visited);

    assert.deepEqual(statuses, [200]);
    assert.equal(pageResponse?.data, "<html></html>");
});

test("body failures retry independently and emit an incomplete audit outcome", async t => {
    const {events, location, thread, visited} = createThread(1);
    let getCount = 0;
    let outcome: PageAuditOutcome|undefined;
    events.on('page-received', (_response: AxiosResponse|null, _location: Location, value?: PageAuditOutcome) => {
        outcome = value;
    });

    t.mock.method(axios, 'head', async () => response(200, "text/html", undefined));
    t.mock.method(axios, 'get', async () => {
        getCount++;
        return response(503, "text/html", Readable.from(["unavailable"]));
    });

    await thread.fetch(location, visited);

    assert.equal(getCount, 2);
    assert.equal(outcome?.status, "failed");
    if(outcome?.status === 'failed') {
        assert.equal(outcome.phase, "body-fetch");
        assert.equal(outcome.statusCode, 503);
    }
    assert.equal(visited[testUrl].statusCode, 200);
    assert.equal(visited[testUrl].dataReceived, undefined);
});
