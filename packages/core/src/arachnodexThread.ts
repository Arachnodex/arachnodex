"use strict";

import type { Location } from "./definitions.ts";
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import * as https from "https";
import { setTimeout as sleep } from "timers/promises";
import {OutputHelper} from "./services/outputHelper.js";
import {defaultRequestHeaders} from "./services/requestHeaders.js";
import {ArachnodexRuntime} from "./runtime.js";

const pollMs = 150;

export class ArachnodexThread {

    index: number;
    requestDelay: number = 0;
    requestTimeout: number = 30000;
    requestTimeoutMaxRetries: number = 3;
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

        let locationFinal: Location | undefined = undefined;
        let statusCode: number | undefined = undefined;
        let requestPhase: 'headers'|'data' = 'headers';

        // Perform a cheap HEAD request first. Full HTML is downloaded only after headers
        // confirm a successful HTML response.
        try {

            const config: AxiosRequestConfig = {
                maxRedirects: 0,
                timeout: this.requestTimeout,
                signal: this.runtime.abortSignal,
                headers: {
                    ...defaultRequestHeaders
                }
            }
            config.httpsAgent = new https.Agent({
                requestCert: false,
                rejectUnauthorized: this.runtime.config.getConfigBoolean('requestTls.rejectUnauthorized', null, true)
            });
            if(typeof location.referer !== 'undefined' && location.referer !== null) {
                config.headers = {
                    ...(config.headers ?? {}),
                    referer: location.referer
                }
            }

            // this will throw and error for all non-successful response codes!
            const response: AxiosResponse<void> = await axios.head<void>(location.url, config);
            if(this.runtime.aborted) {
                return;
            }

            await this.runtime.lock.forUnlock();
            if(this.runtime.aborted) {
                return;
            }
            this.runtime.lock.lock();
            locationFinal = {...location};
            if(response?.status > 0) {
                statusCode = locationFinal.statusCode = response.status;
                this.runtime.events.emit('location-visited', location.url, statusCode);
            }
            this.runtime.lock.unlock();

            this.runtime.events.emit('headers-received', response, location);

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
                if(this.runtime.aborted) {
                    return;
                }

                await this.runtime.lock.forUnlock();
                if(this.runtime.aborted) {
                    return;
                }
                this.runtime.lock.lock();
                if(typeof visited[location.url] !== 'undefined') {
                    visited[location.url].dataReceived = true;
                }
                this.runtime.lock.unlock();

                // Emit page data received event
                this.runtime.events.emit('page-received', dataResponse, location);
            }

        } catch(nonSuccessResponseError) {
            if(this.runtime.aborted) {
                return;
            }

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
                    await this.runtime.lock.forUnlock();
                    if(this.runtime.aborted) {
                        return;
                    }
                    this.runtime.lock.lock();
                    locationFinal = {...location};
                    if(nonSuccessResponseError.response?.status > 0) {
                        statusCode = locationFinal.statusCode = nonSuccessResponseError.response.status;
                        this.runtime.events.emit('location-visited', location.url, statusCode);
                    }
                    this.runtime.lock.unlock();
                    this.runtime.events.emit('headers-received', nonSuccessResponseError.response, location);
                } else {
                    this.runtime.events.emit('error', nonSuccessResponseError, 'URL Data Request Failed', location);
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

                this.runtime.events.emit('location-visited', location.url, 0);

                this.runtime.events.emit(
                    'error',
                    nonSuccessResponseError,
                    noResponseMessage,
                    locationFinal ?? location,
                    false,
                    false
                );
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
