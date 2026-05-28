"use strict";

import type { Location } from "./definitions.ts";
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import * as https from "https";
import eventBus from './lib/eventBus.js';
import sharedLock from './lib/lock.js';
import { setTimeout as sleep } from "timers/promises";
import {ConfigService} from "./services/configLoader.js";
import { activeThreads } from "./activeThreads.js";
import { turnMutex } from "./lib/turnMutex.js";
import {OutputHelper} from "./services/outputHelper.js";
import {defaultRequestHeaders} from "./services/requestHeaders.js";

const pollMs = 150;
let throttledRequestCount = 0;

export class ArachnodexThread {

    index: number;
    requestDelay: number = 0;
    requestTimeout: number = 30000;
    requestTimeoutMaxRetries: number = 3;
    console: OutputHelper;

    constructor(index: number) {
        this.index = index;
        this.console = new OutputHelper();
        this.requestDelay = Number(ConfigService.getConfigNumber('requestDelayMs'));
        if(this.requestDelay < 0) {
            this.requestDelay = 0;
        }
        this.requestTimeout = Number(ConfigService.getConfigNumber('requestTimeoutMs'));
        if(!Number.isInteger(this.requestTimeout) || this.requestTimeout <= 0) {
            this.requestTimeout = 30000;
        }
        this.requestTimeoutMaxRetries = Number(ConfigService.getConfigNumber('requestTimeoutMaxRetries'));
        if(!Number.isInteger(this.requestTimeoutMaxRetries) || this.requestTimeoutMaxRetries < 0) {
            this.requestTimeoutMaxRetries = 3;
        }
    }

    async waitTurn(): Promise<void> {
        // Request delay is global, not per worker. Workers negotiate a fair turn order here
        // so concurrent threads do not burst requests at the same host all at once.
        let done = false;

        do {
            const myState = activeThreads.get(this);

            if (myState === undefined) {
                throw new Error("ERROR: Thread not found in activeThreads map.");
            }

            // If someone else already claimed the next slot, wait.
            let someoneElseClaimed = false;
            for (const [thread, state] of activeThreads) {
                if (state.claimed && thread !== this) {
                    someoneElseClaimed = true;
                    break;
                }
            }

            if (someoneElseClaimed) {
                await sleep(pollMs);
                continue;
            }

            let latestRequest = 0;

            let nullIdleBeforeMe = false;
            let sawMe = false;

            let oldestIdleThread: ArachnodexThread | null = null;
            let oldestIdleTs = Number.POSITIVE_INFINITY;

            for (const [thread, state] of activeThreads) {
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
                await sleep(pollMs);
                continue;
            }

            const waitTime = Math.max(0, this.requestDelay - (Date.now() - latestRequest));
            if (waitTime > 0) {
                await sleep(waitTime);
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
                await sleep(pollMs);
                continue;
            }

            // Claim atomically so nobody else can also pass the gate.
            const release = await turnMutex.acquire();
            try {
                // Re-check: someone might have claimed while we awaited mutex
                for (const [thread, state] of activeThreads) {
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
                await sleep(pollMs);
            }

        } while (!done);
    }

    async fetch(location:Location, visited:Record<string, Location>) {

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
                redirectRoot: visited[location.url].redirectRoot,
                redirectChain: visited[location.url].redirectChain,
                redirectCode: visited[location.url].redirectCode,
            });
            try {
                // emit before request event
                eventBus.emit('before-request', location);
                eventBus.emit('location-visited', location.url, location.statusCode);
                eventBus.emit('headers-received', null, location);
                eventBus.emit('page-received', null, location)
            } catch (e) {
                eventBus.emit(
                    'error',
                    e,
                    null,
                    location,
                    false,
                    true
                );
            }

            // Emit ready status to receive URL for next location
            eventBus.emit('thread-ready', this);
            return;
        }

        const state = activeThreads.get(this);
        if (!state) {
            throw new Error("Missing thread state.");
        }


        if(this.requestDelay > 0) {
            // Claiming happens under a small mutex so exactly one worker can pass the
            // request-delay gate and mark itself in flight.
            await this.waitTurn();
            const release = await turnMutex.acquire();
            try {
                throttledRequestCount++;
                if(throttledRequestCount % 100 === 0) {
                    await sleep(2000);
                }
                state.claimed = false;
                state.inFlight = true;
                state.lastRequestTs = Date.now();
            } finally {
                release();
            }
        }

        // emit before request event
        eventBus.emit('before-request', location);

        let locationFinal: Location | undefined = undefined;
        let statusCode: number | undefined = undefined;
        let requestPhase: 'headers'|'data' = 'headers';

        // Perform a cheap HEAD request first. Full HTML is downloaded only after headers
        // confirm a successful HTML response.
        try {

            const config: AxiosRequestConfig = {
                maxRedirects: 0,
                timeout: this.requestTimeout,
                headers: {
                    ...defaultRequestHeaders
                }
            }
            config.httpsAgent = new https.Agent({
                requestCert: false,
                rejectUnauthorized: false
            });
            if(typeof location.referer !== 'undefined' && location.referer !== null) {
                config.headers = {
                    ...(config.headers ?? {}),
                    referer: location.referer
                }
            }

            // this will throw and error for all non-successful response codes!
            const response: AxiosResponse<void> = await axios.head<void>(location.url, config);

            await sharedLock.forUnlock();
            sharedLock.lock();
            locationFinal = {...location};
            if(response?.status > 0) {
                statusCode = locationFinal.statusCode = response.status;
                eventBus.emit('location-visited', location.url, statusCode);
            }
            sharedLock.unlock();

            eventBus.emit('headers-received', response, location);

            // Non-HTML resources still fire header events for jobs, but are not downloaded
            // unless a future job capability asks the crawler to fetch additional MIME types.
            let contentTypes:unknown = response.headers['content-type'] ?? '';
            contentTypes = Array.isArray(contentTypes) ? contentTypes.join(' ') : String(contentTypes);
            if(!String(contentTypes).match(/text\/html/)
                || statusCode === undefined
                || (statusCode < 200)
                || (statusCode >= 300)
            ) {
                // todo allow jobs to specify a list mime types besides text/html
                // todo they would like the spider to download.
            } else {
                // Fetch HTML data
                config.maxRedirects = 0;
                requestPhase = 'data';
                const dataResponse = await axios.get(location.url, config);

                await sharedLock.forUnlock();
                sharedLock.lock();
                if(typeof visited[location.url] !== 'undefined') {
                    visited[location.url].dataReceived = true;
                }
                sharedLock.unlock();

                // Emit page data received event
                eventBus.emit('page-received', dataResponse, location);
            }

        } catch(nonSuccessResponseError) {

            const timeoutSeconds = this.requestTimeout / 1000;
            const noResponseMessage = requestPhase === 'data'
                ? `URL data request failed after successful HEAD request after ${timeoutSeconds} seconds.`
                : `The server did not respond to the request after ${timeoutSeconds} seconds.`;

            // Emit non-successful status responses as 'headers-received' events
            // Arachnodex can then decide what to do with each.
            if (axios.isAxiosError(nonSuccessResponseError) && nonSuccessResponseError.response !== undefined) {
                // The request was made and the server responded with a status code
                // that falls out of the range of 2xx
                if(statusCode === undefined) {
                    await sharedLock.forUnlock();
                    sharedLock.lock();
                    locationFinal = {...location};
                    if(nonSuccessResponseError.response?.status > 0) {
                        statusCode = locationFinal.statusCode = nonSuccessResponseError.response.status;
                        eventBus.emit('location-visited', location.url, statusCode);
                    }
                    sharedLock.unlock();
                    eventBus.emit('headers-received', nonSuccessResponseError.response, location);
                } else {
                    eventBus.emit('error', nonSuccessResponseError, 'URL Data Request Failed', location);
                }
            } else if (axios.isAxiosError(nonSuccessResponseError) && nonSuccessResponseError.request !== undefined) {
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

                eventBus.emit('location-visited', location.url, 0);

                eventBus.emit(
                    'error',
                    nonSuccessResponseError,
                    noResponseMessage,
                    locationFinal ?? location,
                    false,
                    false
                );
            } else {
                // Program error
                eventBus.emit(
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
            eventBus.emit('thread-ready', this);
        }
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

    private async queueRetryLocation(location: Location): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const handled = eventBus.emit('retry-location', location, resolve, reject);
            if(handled !== true) {
                reject(new Error('No retry-location event listener registered.'));
            }
        });
    }
}
