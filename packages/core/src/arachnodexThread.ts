"use strict";

import type {Location, PageAuditOutcome} from "./definitions.ts";
import axios from 'axios';
import type {AxiosRequestConfig, AxiosResponse} from 'axios';
import * as https from "https";
import type {Readable} from "stream";
import { setTimeout as sleep } from "timers/promises";
import {OutputHelper} from "./services/outputHelper.js";
import {isHtmlContentType, normalizeContentTypeHeader} from "./services/contentType.js";
import {defaultRequestHeaders} from "./services/requestHeaders.js";
import {ArachnodexRuntime} from "./runtime.js";

const pollMs = 150;
const htmlSniffByteLimit = 8192;
const htmlDocumentPrefixPattern = /^(?:\uFEFF|\s)*(?:(?:<!--[\s\S]*?-->|<\?xml[\s\S]*?\?>)\s*)*(?:<!doctype\s+html(?:\s|>)|<html(?:\s|>))/i;

function responseChunkToBuffer(chunk: unknown): Buffer {
    if(Buffer.isBuffer(chunk)) {
        return chunk;
    }
    if(chunk instanceof Uint8Array || typeof chunk === 'string') {
        return Buffer.from(chunk);
    }
    throw new TypeError('Response stream returned an unsupported chunk type.');
}

function looksLikeHtmlDocument(buffer: Buffer): boolean {
    return buffer.indexOf(0) === -1
        && htmlDocumentPrefixPattern.test(buffer.toString('utf8'));
}

async function inspectUnlabeledResponseStream(stream: Readable): Promise<Buffer|null> {
    const bodyChunks: Buffer[] = [];
    const prefixChunks: Buffer[] = [];
    let prefixLength = 0;
    let htmlDetected = false;

    for await (const chunk of stream) {
        const buffer = responseChunkToBuffer(chunk);
        bodyChunks.push(buffer);

        if(htmlDetected) {
            continue;
        }

        const remainingPrefixBytes = htmlSniffByteLimit - prefixLength;
        if(remainingPrefixBytes > 0) {
            const prefixChunk = buffer.subarray(0, remainingPrefixBytes);
            prefixChunks.push(prefixChunk);
            prefixLength += prefixChunk.length;
        }

        htmlDetected = looksLikeHtmlDocument(Buffer.concat(prefixChunks, prefixLength));
        if(!htmlDetected && prefixLength >= htmlSniffByteLimit) {
            stream.destroy();
            return null;
        }
    }

    return htmlDetected ? Buffer.concat(bodyChunks) : null;
}

type PageDataFetchResult =
    | {
        kind: 'html';
        response: AxiosResponse<string>;
    }
    | {
        kind: 'non-html';
        response: AxiosResponse<Readable>;
        auditOutcome: PageAuditOutcome;
    }
    | {
        kind: 'failed';
        response?: AxiosResponse<Readable>;
        error: unknown;
        auditOutcome: PageAuditOutcome;
    }
    | {
        kind: 'aborted';
    };

export class ArachnodexThread {

    index: number;
    requestDelay: number = 0;
    requestTimeout: number = 30000;
    requestTimeoutMaxRetries: number = 3;
    requestHeadEnabled: boolean = true;
    console: OutputHelper;

    constructor(index: number, private readonly runtime = new ArachnodexRuntime()) {
        this.index = index;
        this.console = new OutputHelper(false, true, this.runtime.config);
        this.requestDelay = Number(this.runtime.config.getConfigNumber('requestDelayMs'));
        if(this.requestDelay < 0) {
            this.requestDelay = 0;
        }
        this.requestTimeout = Number(this.runtime.config.getConfigNumber('requestTimeoutMs'));
        if(!Number.isInteger(this.requestTimeout) || this.requestTimeout <= 0) {
            this.requestTimeout = 30000;
        }
        this.requestTimeoutMaxRetries = Number(this.runtime.config.getConfigNumber('requestTimeoutMaxRetries'));
        if(!Number.isInteger(this.requestTimeoutMaxRetries) || this.requestTimeoutMaxRetries < 0) {
            this.requestTimeoutMaxRetries = 3;
        }
        this.requestHeadEnabled = this.runtime.config.getConfigBoolean('requestHead.enabled', null, true);
    }

    async waitTurn(): Promise<void> {
        // Request delay is global, not per worker. Workers negotiate a fair turn order here
        // so concurrent threads do not burst requests at the same host all at once.
        let done = false;

        do {
            if(this.runtime.aborted) {
                return;
            }

            const myState = this.runtime.activeThreads.get(this);

            if (myState === undefined) {
                throw new Error("ERROR: Thread not found in this.runtime.activeThreads map.");
            }

            // If someone else already claimed the next slot, wait.
            let someoneElseClaimed = false;
            for (const [thread, state] of this.runtime.activeThreads) {
                if (state.claimed && thread !== this) {
                    someoneElseClaimed = true;
                    break;
                }
            }

            if (someoneElseClaimed) {
                await this.sleep(pollMs);
                continue;
            }

            let latestRequest = 0;

            let nullIdleBeforeMe = false;
            let sawMe = false;

            let oldestIdleThread: ArachnodexThread | null = null;
            let oldestIdleTs = Number.POSITIVE_INFINITY;

            for (const [thread, state] of this.runtime.activeThreads) {
                const ts = state.lastRequestTs;

                if (ts !== null && ts > latestRequest) {
                    latestRequest = ts;
                }

                if (thread === this) {
                    sawMe = true;
                }

                // Only idle threads participate in ordering/fairness.
                if (state.inFlight) {
                    continue;
                }

                // First-run ordering rule: an idle null before me blocks me.
                if (!sawMe && thread !== this && ts === null) {
                    nullIdleBeforeMe = true;
                    break;
                }

                // Fairness winner among idle timestamped threads (tie-break by Map order).
                if (ts !== null && ts < oldestIdleTs) {
                    oldestIdleTs = ts;
                    oldestIdleThread = thread;
                }
            }

            if (nullIdleBeforeMe) {
                await this.sleep(pollMs);
                continue;
            }

            const waitTime = Math.max(0, this.requestDelay - (Date.now() - latestRequest));
            if (waitTime > 0) {
                await this.sleep(waitTime);
                continue;
            }

            // Eligibility:
            // - First run (my ts null): allowed by ordering, delay already satisfied.
            // - Not first run: either I'm the oldest idle timestamped thread, OR there are no idle timestamped threads (everyone else inFlight).
            let eligible =
                myState.lastRequestTs === null
                || oldestIdleThread === this
                || oldestIdleThread === null;

            if (!eligible) {
                await this.sleep(pollMs);
                continue;
            }

            // Claim atomically so nobody else can also pass the gate.
            const release = await this.runtime.turnMutex.acquire();
            try {
                // Re-check: someone might have claimed while we awaited mutex
                for (const [thread, state] of this.runtime.activeThreads) {
                    if (state.claimed && thread !== this) {
                        eligible = false;
                        break;
                    }
                }

                if (!eligible) {
                    // fall through to sleep below
                } else {
                    myState.claimed = true;
                    done = true;
                }
            } finally {
                release();
            }

            if (!done) {
                await this.sleep(pollMs);
            }

        } while (!done);
    }

    async fetch(location:Location, visited:Record<string, Location>) {
        if(this.runtime.aborted) {
            this.runtime.events.emit('thread-ready', this);
            return;
        }

        // Replayed referers use cached status metadata. Jobs still receive events so they
        // can attribute the same broken URL to multiple source pages.
        if(typeof visited[location.url] !== 'undefined'
            && visited[location.url].statusCode !== undefined) {

            // bind previous statusCode to new location object
            Object.assign(location, {
                statusCode: visited[location.url].statusCode,
                redirectedTo: visited[location.url].redirectedTo,
                redirectedFrom: visited[location.url].redirectedFrom,
                canonicalUrl: visited[location.url].canonicalUrl,
                headRequestFailure: visited[location.url].headRequestFailure,
                redirectRoot: visited[location.url].redirectRoot,
                redirectChain: visited[location.url].redirectChain,
                redirectCode: visited[location.url].redirectCode,
            });
            try {
                // emit before request event
                this.runtime.events.emit('before-request', location);
                this.runtime.events.emit('location-visited', location.url, location.statusCode);
                this.runtime.events.emit('headers-received', null, location);
                this.runtime.events.emit('page-received', null, location)
            } catch (e) {
                this.runtime.events.emit(
                    'error',
                    e,
                    null,
                    location,
                    false,
                    true
                );
            }

            // Emit ready status to receive URL for next location
            this.runtime.events.emit('thread-ready', this);
            return;
        }

        const state = this.runtime.activeThreads.get(this);
        if (!state) {
            throw new Error("Missing thread state.");
        }


        if(this.requestDelay > 0) {
            // Claiming happens under a small mutex so exactly one worker can pass the
            // request-delay gate and mark itself in flight.
            await this.waitTurn();
            if(this.runtime.aborted) {
                this.runtime.events.emit('thread-ready', this);
                return;
            }
            const release = await this.runtime.turnMutex.acquire();
            try {
                this.runtime.throttledRequestCount++;
                if(this.runtime.throttledRequestCount % 100 === 0) {
                    await this.sleep(2000);
                }
                state.claimed = false;
                state.inFlight = true;
                state.lastRequestTs = Date.now();
            } finally {
                release();
            }
        }

        // emit before request event
        this.runtime.events.emit('before-request', location);

        let locationFinal: Location | undefined;
        const config = this.getRequestConfig(location);

        // HEAD remains the inexpensive status/redirect probe. Successful URLs then use a
        // streaming GET: HTML is buffered for jobs, while non-HTML streams are aborted as
        // soon as their response headers arrive.
        try {
            if(!this.requestHeadEnabled) {
                const directGetResult = await this.fetchPageData(location, config);
                await this.publishStandaloneGetResult(directGetResult, location, visited);
                return;
            }

            const headResponse = await axios.head<void>(location.url, config);
            if(this.runtime.aborted) {
                return;
            }

            if(headResponse.status < 200 || headResponse.status >= 400) {
                location.headRequestFailure = {
                    message: `HEAD request returned HTTP ${headResponse.status}.`,
                    statusCode: headResponse.status
                };
                const fallbackResult = await this.fetchPageData(location, config, headResponse);
                await this.publishStandaloneGetResult(fallbackResult, location, visited);
                return;
            }

            await this.publishHeaders(headResponse, location, visited);
            locationFinal = {...location};
            if(headResponse.status >= 300) {
                return;
            }

            const dataResult = await this.fetchPageData(location, config, headResponse);
            if(dataResult.kind === 'aborted') {
                return;
            }
            if(dataResult.kind === 'failed') {
                if(typeof dataResult.response !== 'undefined'
                    && dataResult.response.status !== headResponse.status) {
                    // A completed GET response is more authoritative than the earlier HEAD.
                    // Publish its failure status so caches and jobs do not retain a false 2xx.
                    await this.publishHeaders(dataResult.response, location, visited);
                }
                this.publishPageAuditFailure(dataResult, location);
                return;
            }

            await this.publishPageDataResult(dataResult, location, visited);

        } catch(nonSuccessResponseError) {
            if(this.runtime.aborted) {
                return;
            }

            const timeoutSeconds = this.requestTimeout / 1000;
            const noResponseMessage = `The server did not respond to the HEAD request after ${timeoutSeconds} seconds.`;

            if (axios.isAxiosError(nonSuccessResponseError) && nonSuccessResponseError.request !== undefined) {
                // The request was made but no response was received
                // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                // http.ClientRequest in node.js
                if(this.isTimeoutError(nonSuccessResponseError) && this.shouldRetryTimeout(location)) {
                    // Timeouts are retried through the main queue so the same de-dupe and
                    // worker scheduling rules apply to retry attempts.
                    const retryAttempt = (location.retryAttempt ?? 0) + 1;
                    this.console.log(
                        `Timed out after ${timeoutSeconds} seconds: ${location.url}; `
                            + `requeueing retry ${retryAttempt}/${this.requestTimeoutMaxRetries}.`,
                        'yellow'
                    );
                    await this.queueRetryLocation({
                        ...location,
                        retryAttempt,
                        statusCode: undefined
                    });
                    return;
                }
                location.headRequestFailure = {
                    message: noResponseMessage,
                    errorCode: typeof nonSuccessResponseError.code === 'string'
                        ? nonSuccessResponseError.code
                        : undefined
                };
                const fallbackResult = await this.fetchPageData(location, config);
                await this.publishStandaloneGetResult(fallbackResult, location, visited);
            } else {
                // Program error
                this.runtime.events.emit(
                    'error',
                    nonSuccessResponseError,
                    null,
                    locationFinal ?? location,
                    false,
                    true
                );
            }
        } finally {
            // Update state
            state.inFlight = false;

            // Emit ready status to receive URL for next location
            this.runtime.events.emit('thread-ready', this);
        }
    }

    private getRequestConfig(location: Location): AxiosRequestConfig {
        return {
            maxRedirects: 0,
            timeout: this.requestTimeout,
            signal: this.runtime.abortSignal,
            validateStatus: () => true,
            headers: {
                ...defaultRequestHeaders,
                ...(typeof location.referer === 'string' ? {referer: location.referer} : {})
            },
            httpsAgent: new https.Agent({
                requestCert: false,
                rejectUnauthorized: this.runtime.config.getConfigBoolean(
                    'requestTls.rejectUnauthorized',
                    null,
                    true
                )
            })
        };
    }

    private async publishStandaloneGetResult(
        result: PageDataFetchResult,
        location: Location,
        visited: Record<string, Location>
    ): Promise<void> {
        if(result.kind === 'aborted') {
            return;
        }
        if(result.kind === 'failed') {
            if(typeof result.response !== 'undefined') {
                await this.publishHeaders(result.response, location, visited);
            } else {
                await this.publishNoResponse(location, visited);
            }
            if(typeof result.response === 'undefined'
                || (result.response.status >= 200 && result.response.status < 300)) {
                this.publishPageAuditFailure(result, location);
            }
            return;
        }

        await this.publishHeaders(result.response, location, visited);
        await this.publishPageDataResult(result, location, visited);
    }

    private async publishNoResponse(location: Location, visited: Record<string, Location>): Promise<void> {
        await this.runtime.lock.forUnlock();
        if(this.runtime.aborted) {
            return;
        }

        this.runtime.lock.lock();
        try {
            location.statusCode = 0;
            if(typeof visited[location.url] !== 'undefined') {
                visited[location.url].statusCode = 0;
                visited[location.url].headRequestFailure = location.headRequestFailure;
            }
            this.runtime.events.emit('location-visited', location.url, 0);
        } finally {
            this.runtime.lock.unlock();
        }

        this.runtime.events.emit('headers-received', null, location);
    }

    private async publishHeaders(
        response: AxiosResponse,
        location: Location,
        visited: Record<string, Location>
    ): Promise<void> {
        await this.runtime.lock.forUnlock();
        if(this.runtime.aborted) {
            return;
        }

        this.runtime.lock.lock();
        try {
            location.statusCode = response.status;
            if(typeof visited[location.url] !== 'undefined') {
                visited[location.url].statusCode = response.status;
                visited[location.url].headRequestFailure = location.headRequestFailure;
            }
            this.runtime.events.emit('location-visited', location.url, response.status);
        } finally {
            this.runtime.lock.unlock();
        }

        this.runtime.events.emit('headers-received', response, location);
    }

    private async publishPageDataResult(
        result: Exclude<PageDataFetchResult, {kind: 'failed'|'aborted'}>,
        location: Location,
        visited: Record<string, Location>
    ): Promise<void> {
        if(result.kind === 'non-html') {
            this.runtime.events.emit('page-received', null, location, result.auditOutcome);
            return;
        }

        await this.runtime.lock.forUnlock();
        if(this.runtime.aborted) {
            return;
        }
        this.runtime.lock.lock();
        try {
            if(typeof visited[location.url] !== 'undefined') {
                visited[location.url].dataReceived = true;
            }
        } finally {
            this.runtime.lock.unlock();
        }

        this.runtime.events.emit('page-received', result.response, location);
    }

    private publishPageAuditFailure(
        result: Extract<PageDataFetchResult, {kind: 'failed'}>,
        location: Location
    ): void {
        this.runtime.events.emit('page-received', null, location, result.auditOutcome);
        this.runtime.events.emit(
            'error',
            result.error,
            'URL Data Request Failed',
            location,
            false,
            false
        );
    }

    private async fetchPageData(
        location: Location,
        config: AxiosRequestConfig,
        headerResponse?: AxiosResponse
    ): Promise<PageDataFetchResult> {
        const fallbackContentType = typeof headerResponse !== 'undefined'
            && headerResponse.status >= 200 && headerResponse.status < 300
            ? normalizeContentTypeHeader(headerResponse.headers['content-type'])
            : '';
        let lastError: unknown = new Error('GET request did not complete.');
        let lastResponse: AxiosResponse<Readable>|undefined;

        for(let attempt = 0; attempt <= this.requestTimeoutMaxRetries; attempt++) {
            if(this.runtime.aborted) {
                return {kind: 'aborted'};
            }

            let response: AxiosResponse<Readable>|undefined;
            try {
                response = await axios.get<Readable>(location.url, {
                    ...config,
                    responseType: 'stream',
                    validateStatus: () => true
                });
                lastResponse = response;
                const responseContentType = normalizeContentTypeHeader(response.headers['content-type']);
                const contentType = responseContentType !== ''
                    ? responseContentType
                    : fallbackContentType;

                if(response.status < 200 || response.status >= 300) {
                    response.data.destroy();
                    lastError = new Error(`GET request returned HTTP ${response.status}.`);
                } else if(contentType !== '' && !isHtmlContentType(contentType)) {
                    // The request reached response headers, but confirmed non-HTML bodies are
                    // never buffered. Destroying the stream keeps document checks inexpensive.
                    response.data.destroy();
                    return {
                        kind: 'non-html',
                        response,
                        auditOutcome: {
                            status: 'non-html',
                            contentType,
                            lastModified: this.getHeaderString(response.headers['last-modified'])
                        }
                    };
                } else {
                    const body = contentType !== ''
                        ? await this.readResponseStream(response.data)
                        : await inspectUnlabeledResponseStream(response.data);
                    if(body === null) {
                        return {
                            kind: 'non-html',
                            response,
                            auditOutcome: {
                                status: 'non-html',
                                contentType: '',
                                lastModified: this.getHeaderString(response.headers['last-modified'])
                            }
                        };
                    }

                    const effectiveContentType = contentType !== '' ? contentType : 'text/html';
                    return {
                        kind: 'html',
                        response: {
                            ...response,
                            data: body.toString('utf8'),
                            headers: {
                                ...response.headers,
                                'content-type': effectiveContentType
                            }
                        }
                    };
                }
            } catch(e) {
                response?.data.destroy();
                lastResponse = response;
                lastError = e;
            }

            if(!this.shouldRetryDataFailure(lastError, lastResponse, attempt)) {
                break;
            }

            const retryNumber = attempt + 1;
            this.console.log(
                `Page body request failed: ${location.url}; `
                    + `retrying ${retryNumber}/${this.requestTimeoutMaxRetries}.`,
                'yellow'
            );
            await this.sleep(Math.min(1000, pollMs * retryNumber));
        }

        const responseContentType = normalizeContentTypeHeader(lastResponse?.headers['content-type']);
        const contentType = responseContentType !== '' ? responseContentType : fallbackContentType;
        const errorCode = axios.isAxiosError(lastError) && typeof lastError.code === 'string'
            ? lastError.code
            : undefined;
        return {
            kind: 'failed',
            response: lastResponse,
            error: lastError,
            auditOutcome: {
                status: 'failed',
                phase: 'body-fetch',
                contentType,
                message: lastError instanceof Error ? lastError.message : String(lastError),
                errorCode,
                statusCode: lastResponse?.status
            }
        };
    }

    private shouldRetryDataFailure(
        error: unknown,
        response: AxiosResponse|undefined,
        attempt: number
    ): boolean {
        if(attempt >= this.requestTimeoutMaxRetries) {
            return false;
        }
        if(typeof response === 'undefined' || (response.status >= 200 && response.status < 300)) {
            return true;
        }

        return response.status === 408
            || response.status === 425
            || response.status === 429
            || response.status >= 500
            || this.isTimeoutError(error);
    }

    private async readResponseStream(stream: Readable): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(responseChunkToBuffer(chunk));
        }
        return Buffer.concat(chunks);
    }

    private getHeaderString(value: unknown): string|undefined {
        if(typeof value === 'string') {
            return value;
        }
        if(Array.isArray(value)) {
            const strings = value.filter((entry): entry is string => typeof entry === 'string');
            return strings.length > 0 ? strings.join(', ') : undefined;
        }
        return undefined;
    }

    private isTimeoutError(e: unknown): boolean {
        return axios.isAxiosError(e)
            && (
                e.code === 'ECONNABORTED'
                || e.code === 'ETIMEDOUT'
                || String(e.message).toLowerCase().includes('timeout')
            );
    }

    private shouldRetryTimeout(location: Location): boolean {
        return (location.retryAttempt ?? 0) < this.requestTimeoutMaxRetries;
    }

    private async sleep(ms: number): Promise<void> {
        if(this.runtime.aborted) {
            return;
        }

        try {
            await sleep(ms, undefined, {signal: this.runtime.abortSignal});
        } catch(e) {
            if(!this.runtime.aborted) {
                throw e;
            }
        }
    }

    private async queueRetryLocation(location: Location): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const handled = this.runtime.events.emit('retry-location', location, resolve, reject);
            if(handled !== true) {
                reject(new Error('No retry-location event listener registered.'));
            }
        });
    }
}
