"use strict";

// Definitions
import type {
    Location,
    CrawlerError,
    PageData,
    CrawlerStats,
    PageLink,
    PageParseWarning,
    LinkZone,
    PageAuditOutcome
} from "./definitions.ts";

// Internal packages and helpers
import {ArachnodexThread} from "./arachnodexThread.js";
import {OutputHelper} from "./services/outputHelper.js";
import {JobManager} from "./services/jobManager.js";
import type {MainCommandParser} from "./command/mainCommandParser.js";
import {Profiler} from "./services/profiler.js";
import {ReportManager} from "./services/reportManager.js";
import {ArachnodexRuntime} from "./runtime.js";
import {isHtmlContentType, normalizeContentTypeHeader} from "./services/contentType.js";

// External deps
import type {AxiosResponse} from "axios";
import { setTimeout as sleep } from "timers/promises";
import {JSDOM, VirtualConsole} from "jsdom";
import crypto from "crypto";

const pollMs = 25;
const pollMsExt = 150;
const hostnameWwwPattern = /^www\./i;

function getObservedLinkUrl(preparedUrl: string, observedUrl?: string): string {
    // The crawl identity normally excludes fragments so each document is fetched once,
    // but jobs still need the observed fragment to audit same- and cross-page anchors.
    if(typeof observedUrl === 'undefined') {
        return preparedUrl;
    }

    const fragmentIndex = observedUrl.indexOf('#');
    if(fragmentIndex === -1 || preparedUrl.indexOf('#') !== -1) {
        return preparedUrl;
    }

    return `${preparedUrl}${observedUrl.substring(fragmentIndex)}`;
}

export class Arachnodex {

    // Core collaborators are created once and shared through the crawl lifecycle.
    jobs: JobManager;
    profiler: Profiler;
    fatalShutdownStarted = false;
    fatalShutdownPromise?: Promise<void>;

    errors: CrawlerError[] = [];

    // Worker Threads
    threadCount= 0;

    // URL Queue / Visited Logs
    pending: Location[] = [];
    pendingDelayed: Location[] = [];
    visited: Record<string, Location> = {};
    canonicalAliases: Record<string, string> = {};

    // Hashed pending location indexes keep duplicate URL+referer combinations out of the queue.
    pendingUrlHashes: string[] = [];
    pendingUrls: string[] = [];

    // Local options storage
    // Needed by code in this class throughout
    crawlStarted: boolean = false;
    maxThreadsCreated: boolean = false;
    maxThreads = 0;
    verbosityLevel = 0;
    muteResponseStatus: boolean = false;
    baseUrl = '';

    console: OutputHelper;

    // Crawl Statistics
    stats: CrawlerStats = {
        totals: {
            requestedHead: 0,
            downloadedData: 0,
            pagesScraped: 0,
        },
        logs: {
            requestedHead: <string[]>[],
            downloadedData: <string[]>[],
            pagesScraped: <string[]>[],
        }
    }

    // Initialization validates required config before any worker can start.
    constructor(command: MainCommandParser, private readonly runtime = new ArachnodexRuntime()) {
        this.console = new OutputHelper(false, true, this.runtime.config);
        this.profiler = new Profiler(command.profilerEnabled(), this.console);

        // Validate Config
        this.baseUrl = this.runtime.config.getConfigString('baseUrl');
        const domain = this.runtime.config.getConfigString('domain').toLowerCase();
        if(domain === '') {
            this.emitConfigError(new Error('Config option `domain` must be set.'));
        }
        if(domain.match(hostnameWwwPattern)) {
            this.emitConfigError(new Error('Config option `domain` cannot start with "www.".'));
        }

        let baseUrl: URL;
        try {
            baseUrl = new URL(this.baseUrl);
        } catch {
            this.emitConfigError(new Error('Crawler config for `baseUrl` must be a valid URL.'));
        }
        if(baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
            this.emitConfigError(new Error('Crawler config for `baseUrl` must start with http:// or https://.'));
        }
        if(baseUrl.pathname !== '/' || baseUrl.search !== '' || baseUrl.hash !== '') {
            this.emitConfigError(new Error('Crawler config for `baseUrl` may not include a path, query string, or hash.'));
        }
        if(this.normalizeHostname(baseUrl.hostname) !== domain) {
            this.emitConfigError(new Error('Crawler config for `baseUrl` hostname must match `domain`, allowing only an optional leading "www.".'));
        }
        this.runtime.urlHelper.loadConfig();

        // Get local Options
        this.verbosityLevel = command.getVerbosityLevel();
        this.muteResponseStatus = this.runtime.config.getConfigBoolean('muteResponseStatus');
        this.maxThreads = Number(this.runtime.config.getConfigNumber('numThreads'));
        if(this.maxThreads <= 1) {
            this.maxThreads = 1;
        }

        // Initialize job manager
        this.jobs = new JobManager(command.getJobs(), this.profiler, this.verbosityLevel, this.runtime);

        this.errorEventHandler = this.errorEventHandler.bind(this);
    }

    private normalizeHostname(hostname: string): string {
        return hostname.toLowerCase().replace(hostnameWwwPattern, '');
    }

    private emitConfigError(error: Error): never {
        this.runtime.events.emit('boot-error', error);
        throw error;
    }

    // ====================
    // START UP & SHUT DOWN
    // ====================

    async start(): Promise<number> {
        this.profiler.mark('crawl', 'starting crawl');

        // Import each requested job before crawling so job-specific config errors fail early.
        let hasMoreJobs = true;
        while(hasMoreJobs) {
           hasMoreJobs = await this.jobs.importJob()
        }
        this.profiler.mark('crawl', 'jobs imported');

        // Trigger callback on any jobs with onInit set.
        this.jobs.dispatchEvent('onInit');
        this.profiler.mark('crawl', 'job onInit dispatched');

        // Add the entry location (starts crawl / spawns worker threads)
        const pathPrefix = this.runtime.config.getConfigString('pathPrefix');
        const entryFile = this.runtime.config.getConfigString('entryFile');
        await this.addNewLocation({
            url: this.runtime.urlHelper.baseUrl + pathPrefix + entryFile,
            rawUrl: '/' + pathPrefix + entryFile,
        });

        // The main process only coordinates workers. Actual request work happens in ArachnodexThread.

        //while (!this.crawlStarted || this.pending.length > 0 || this.pendingDelayed.length > 0 || this.workerInFlight()) {
        while (!this.fatalShutdownStarted && (!this.crawlStarted || this.threadCount > 0)) {
            //console.log('Main thread loop', 'Pending URLs (Priority/Delayed): ' + this.pending.length + '/' + this.pendingDelayed.length, 'Active Threads: ' + this.runtime.activeThreads.length);
            await sleep(pollMsExt);
        }

        //await sleep(2000);

        if(this.fatalShutdownStarted) {
            return await this.finalizeFatalShutdown();
        }

        // Send reports and shut down
        await this.shutdown();
        if(this.fatalShutdownStarted) {
            return await this.finalizeFatalShutdown();
        }

        return 0;
    }


    // Send reports, write logs and shut down.
    async shutdown() {

        this.console.log("\nSHUTTING DOWN...\n", 'white.bold');
        this.profiler.mark('shutdown', 'starting shutdown');

        // Trigger callback on any jobs with onEnd set.
        this.jobs.dispatchEvent('onEnd');
        this.profiler.mark('shutdown', 'job onEnd dispatched');

        // Wait for all jobs to finish
        while (this.jobs.getRunningJobCount() > 0) {
            await sleep(pollMsExt);
        }
        this.profiler.mark('shutdown', 'jobs completed');
        if(this.fatalShutdownStarted) {
            return;
        }

        this.profiler.mark('shutdown', 'regular report email send starting');
        await new ReportManager(this.profiler, this.runtime.config).sendReport(this.stats, this.jobs.jobs);
        this.profiler.mark('shutdown', 'regular report email send complete');
        if(this.fatalShutdownStarted) {
            return;
        }

        this.profiler.mark('shutdown', 'accumulated error report email send starting');
        await new ReportManager(this.profiler, this.runtime.config).sendErrorReport(this.errors, this.stats, this.jobs.jobs);
        this.profiler.mark('shutdown', 'accumulated error report email send complete');
        if(this.fatalShutdownStarted) {
            return;
        }


        // (-vvv)
        if(this.verbosityLevel === 3) {
            this.stats.logs.requestedHead.sort();
            this.stats.logs.downloadedData.sort();
            this.stats.logs.pagesScraped.sort();
        }
        this.profiler.mark('shutdown', 'verbose log sorting complete');

        // (-vv, -vvv)
        if(this.verbosityLevel >= 2) {
            this.console.log('', undefined, true);
            this.console.log('URL Headers Requested List', 'yellow.bold', true);
            this.stats.logs.requestedHead.forEach(url => this.console.log(url, undefined, true));
            this.console.log('', undefined, true);
            this.console.log('URL Fully Downloaded List', 'yellow.bold', true);
            this.stats.logs.downloadedData.forEach(url => this.console.log(url, undefined, true));
            this.console.log('', undefined, true);
            this.console.log('Pages Scraped List', 'yellow.bold', true);
            this.stats.logs.pagesScraped.forEach(url => this.console.log(url, undefined, true));
        }
        this.profiler.mark('shutdown', 'verbose URL output complete');

        // Output  (-v, -vv, -vvv)
        if(this.verbosityLevel >= 1) {
            this.console.log('', undefined, true);
            this.console.logObject({
                'URL Headers Requested': this.stats.totals.requestedHead,
                'URL Fully Downloaded': this.stats.totals.downloadedData,
                'Pages Scraped': this.stats.totals.pagesScraped,
            }, 40, false, true, {prop: 'magenta.bold', value: 'green'});
        }
        this.profiler.mark('shutdown', 'summary statistics output complete');


        // output complete message with duration in seconds.
        this.console.log('', undefined, true);
        this.console.log('Execution Complete.', 'green.bold', true);
        this.console.log('Duration ' + this.profiler.getDurationSeconds() + ' seconds', undefined, true);

    }

    async sendTestReportEmail(): Promise<void> {
        this.profiler.mark('report-email', 'starting test report email');

        let hasMoreJobs = true;
        while(hasMoreJobs) {
            hasMoreJobs = await this.jobs.importJob();
        }

        if(this.jobs.jobs.length === 0) {
            throw new Error('No jobs were loaded for the test report email.');
        }

        await new ReportManager(this.profiler, this.runtime.config).sendReport(this.getTestReportStats(), this.jobs.jobs);
        this.profiler.mark('report-email', 'test report email complete');
    }

    private getTestReportStats(): CrawlerStats {
        return {
            totals: {
                requestedHead: 12,
                downloadedData: 8,
                pagesScraped: 6
            },
            logs: {
                requestedHead: [
                    'https://example.test/',
                    'https://example.test/about'
                ],
                downloadedData: [
                    'https://example.test/',
                    'https://example.test/about'
                ],
                pagesScraped: [
                    'https://example.test/',
                    'https://example.test/about'
                ]
            }
        };
    }

    locationHash(loc: Location): string {
        // The same URL can be discovered from different referers. Include raw input and referer
        // so queue de-duping does not hide useful per-source link issue data.
        const url = String(loc.url);
        const rawUrl = String(loc.rawUrl);
        const referer = loc.referer === undefined ? null : String(loc.referer);
        const payload = { url, rawUrl, referer } as const;
        const json = JSON.stringify(payload);
        return crypto.createHash("sha256").update(json, "utf8").digest("hex");
    }
    // locationHashDebug(loc: Location): void {
    //     const url = String(loc.url);
    //     const rawUrl = String(loc.rawUrl);
    //     const referer = loc.referer === undefined ? null : String(loc.referer);
    //
    //     const payload = { url, rawUrl, referer } as const;
    //
    //     const json = JSON.stringify(payload);
    //     console.log("hash input json:", json);
    //     console.log("hash output:", crypto.createHash("sha256").update(json, "utf8").digest("hex"));
    // }

    // =========================
    // LOCATION QUEUE MANAGEMENT
    // =========================
    async addNewLocation(location: Location) {
        if(this.runtime.aborted) {
            return false;
        }

        // Normalize and filter before touching shared queue state.
        if (!this.runtime.urlHelper.prepareUrl(location)) {
            // force death if no threads are active
            if (this.runtime.activeThreads.size <= 0) {
                console.error('Ended because no location could be added while no workers had been activated. Config problem?');
                throw new Error('No location could be added while no workers had been activated. Check crawler config.');
            }
            // Discard off-site, incompatible or invalid url
            return false;
        }

        // Handle cant/must contain conditions,
        if(!this.runtime.urlHelper.validateLocation(location.url, 'urlCantContain')) {
            return false;
        }
        if(!this.runtime.urlHelper.validateLocation(location.url, 'urlMustContain')) {
            return false;
        }
        if(this.isCanonicalAliasAlreadyProcessed(location)) {
            return false;
        }

        let locationAdded = false;

        while(!locationAdded) {
            // Wait here if URL is currently being processed. Do not hold the
            // shared lock while waiting; the active request needs it to finish.
            while(!this.isFetchReady(location.url)) {
                if(this.runtime.aborted) {
                    return false;
                }
                await sleep(pollMs);
            }

            // Wait for unlock before proceeding
            await this.runtime.lock.forUnlock();
            if(this.runtime.aborted) {
                return false;
            }

            this.runtime.lock.lock();
            try {
                if(!this.isFetchReady(location.url)) {
                    continue;
                }
                if(this.isCanonicalAliasAlreadyProcessed(location)) {
                    return false;
                }

                // Do not requeue cached requests for URLs that were 200/OK.
                if(this.visited[location.url]?.statusCode === 200) {
                    return false;
                }

                // Ensure location URL+raw URL+referer is not already queued.
                const locHash = this.locationHash(location);
                if(this.pendingUrlHashes.indexOf(locHash) !== -1) {
                    return false;
                }

                this.pendingUrlHashes.push(locHash);

                // If this URL is already in-flight, hold this referer in the delayed queue.
                // Non-200 results can later replay delayed referers without a duplicate network request.
                if(this.pendingUrls.indexOf(location.url) !== -1) {
                    this.pendingDelayed.push(location);
                } else {
                    this.pendingUrls.push(location.url);
                    this.pending.push(location);
                }

                locationAdded = true;
            } finally {
                this.runtime.lock.unlock();
            }
        }

        // Notify Arachnodex that a new location has been added
        // so a worker can be assigned (Until max threads is reached)
        this.runtime.events.emit('new-locations-added');

    }

    isFetchReady(locationUrl: string): boolean
    {
        // Allow fetch if URL has not been visited or a fetch has been previously completed for the URL
        // indicated by the presence of a statusCode value. Once a status code is present we still queue
        // the fetch but a real fetch will not be performed. Instead, the previously returned status code will
        // be used for the headersReceived event (and the onPageReceived event will not be fired).
        return typeof this.visited[locationUrl] === 'undefined'
            || this.visited[locationUrl].statusCode !== undefined;
    }

    removePendingHash(location: Location): void {
        let hasDelayed = false;
        this.pendingDelayed.every(loc => {
            if(loc.url === location.url) {
                hasDelayed = true;
                return false;
            }
            return true;
        });
        if(this.pendingUrls.indexOf(location.url) === -1 && !hasDelayed) {
            const hash = this.locationHash(location);
            const hashIndex = this.pendingUrlHashes.indexOf(hash);
            if (hashIndex !== -1) {
                this.pendingUrlHashes.splice(hashIndex, 1);
            }
        }
    }

    locationLogVisitedEvent(locationUrl: string, statusCode: number) {
        if(typeof this.visited[locationUrl] !== 'undefined') {

            if(this.visited[locationUrl].statusCode === undefined) {
                this.visited[locationUrl].statusCode = statusCode;
            }

            // A 200 response satisfies all delayed referers for this URL. Non-200 results are
            // replayed so jobs can attribute the same broken target to each source page.
            const newDelayed: Location[] = [];
            const clearHashes: Location[] = [];
            if(statusCode === 200) {
                for(const loc of this.pendingDelayed) {
                    if(loc.url === locationUrl) {
                        const index = this.pendingUrls.indexOf(locationUrl);
                        if (index !== -1) {
                            this.pendingUrls.splice(index, 1);
                            this.pending.splice(index, 1);
                        }
                        clearHashes.push(loc);
                    } else {
                        newDelayed.push(loc);
                    }
                }

            } else {
                // Move pending delayed to actual queue
                for(const loc of this.pendingDelayed) {
                    if(loc.url === locationUrl) {
                        this.pending.push(loc);
                        this.pendingUrls.push(loc.url);
                    } else {
                        newDelayed.push(loc);
                    }
                }
            }
            this.pendingDelayed = newDelayed;
            clearHashes.forEach(loc => this.removePendingHash(loc));
        }
    }

    async retryLocationEvent(location: Location) {
        if(this.runtime.aborted) {
            return;
        }

        // Timeout retries deliberately remove the half-visited record so the next worker
        // performs a fresh request instead of treating the previous timeout as cached.
        await this.runtime.lock.forUnlock();
        if(this.runtime.aborted) {
            return;
        }
        this.runtime.lock.lock();

        try {
            if(this.visited[location.url]?.dataReceived === true) {
                return;
            }

            delete this.visited[location.url];

            const hash = this.locationHash(location);
            const hashIndex = this.pendingUrlHashes.indexOf(hash);
            if(hashIndex !== -1) {
                this.pendingUrlHashes.splice(hashIndex, 1);
            }

            if(this.pendingUrls.indexOf(location.url) === -1) {
                this.pendingUrlHashes.push(hash);
                this.pendingUrls.push(location.url);
                this.pending.push(location);
            }
        } finally {
            this.runtime.lock.unlock();
        }

        this.runtime.events.emit('new-locations-added');
    }

    updateVisitedLocation(location: Location): void {
        if(typeof this.visited[location.url] !== 'undefined') {
            // Preserve status code as we would not expect that to change
            location.statusCode = this.visited[location.url].statusCode;
            location.dataReceived = this.visited[location.url].dataReceived;
            location.redirectedTo = this.visited[location.url].redirectedTo;
            location.redirectedFrom = this.visited[location.url].redirectedFrom;
            location.canonicalUrl = this.visited[location.url].canonicalUrl;
            location.redirectRoot = this.visited[location.url].redirectRoot;
            location.redirectChain = this.visited[location.url].redirectChain;
            location.redirectCode = this.visited[location.url].redirectCode;
        }
        this.visited[location.url] = location;
    }

    // Responsible for spinning up crawler workers as new URLs are added to the queue.
    // Once the configured worker limit exists, workers recycle themselves through threadReadyEvent.
    async locationsAddedEvent() {
        if(this.runtime.aborted) {
            return;
        }

        // lock crawler during this loop
        // so we don't end up in a race condition.
        await this.runtime.lock.forUnlock();
        if(this.runtime.aborted) {
            return;
        }
        this.runtime.lock.lock();

        try {
            // Loop and spin up a crawler for each location listed in the pending array
            // until we run out of pending locations or thread limit is reached.

            while (this.pending.length > 0
            && this.runtime.activeThreads.size < this.maxThreads) {

                // first in, first out
                const location = this.pending[0] ?? undefined;

                // spin up new crawler
                if (typeof location !== 'undefined') {

                    if(this.isFetchReady(location.url)) {

                        // Remove location from queue since we are processing it.
                        this.pending.shift();
                        this.pendingUrls.shift();

                        // Immediately save it to the visited array; prevents
                        // double visits to urls in multithreaded environment
                        this.updateVisitedLocation(location);

                        // Create new worker thread
                        const thread = new ArachnodexThread(this.threadCount++, this.runtime);

                        // Add thread to this.runtime.activeThreads map.
                        this.runtime.activeThreads.set(thread, {
                            lastRequestTs: null,
                            inFlight: false,
                            claimed: false
                        });

                        // Dispatch location to worker
                        void thread.fetch(location, this.visited);
                        if(thread.requestHeadEnabled) {
                            this.stats.totals.requestedHead++;
                            this.stats.logs.requestedHead.push(location.url);
                        }
                    }
                }

            }
        } finally {
            // unlock crawler
            this.runtime.lock.unlock();
        }

        if (this.runtime.activeThreads.size === this.maxThreads) {
            this.maxThreadsCreated = true;
            this.runtime.events.removeListener('new-locations-added');
        }
    }


    workerInFlight(): boolean {
        for(const [,state] of this.runtime.activeThreads) {
            if(state.inFlight) {
                return true;
            }
        }
        return false;
    }

    // ============================
    // Core Function Event Handlers
    // ============================

    // Manage workers as they finish work by issuing the next URL. The wait loop gives
    // in-flight workers a short window to discover more links before a worker exits.
    async threadReadyEvent(thread: ArachnodexThread) {
        if(this.runtime.aborted) {
            if(this.runtime.activeThreads.delete(thread)) {
                this.threadCount = Math.max(0, this.threadCount - 1);
            }
            return;
        }

        this.crawlStarted = true;

        let location : Location | undefined;

        const start = Date.now();
        const timeout = 5000; // 5s
        const maxAttempts = 10;
        let attempt = 0;

        let inFlight = this.workerInFlight();
        while(
            location === undefined
            && (
                attempt < maxAttempts
                || inFlight
                || (!this.maxThreadsCreated && Date.now() - start < timeout)
            )
        ) {
            if(this.pending.length > 0) {
                await this.runtime.lock.forUnlock();
                if(this.runtime.aborted) {
                    if(this.runtime.activeThreads.delete(thread)) {
                        this.threadCount = Math.max(0, this.threadCount - 1);
                    }
                    return;
                }
                this.runtime.lock.lock();
                location = this.pending.shift();
                this.pendingUrls.shift();
                this.runtime.lock.unlock();
            }
            if(location === undefined) {
                // Execute loop again
                inFlight = this.workerInFlight();
                if(!inFlight) {
                    // Only increment attempt if workers are not in flight.
                    attempt++;
                }
                await sleep(pollMsExt);
            }
        }

        if(location !== undefined) {
            // Avoids double requesting URLs, will use cached response
            while(!this.isFetchReady(location.url)) {
                if(this.runtime.aborted) {
                    if(this.runtime.activeThreads.delete(thread)) {
                        this.threadCount = Math.max(0, this.threadCount - 1);
                    }
                    return;
                }
                await sleep(pollMs);
            }

            // Immediately save it to the visited array; prevents
            // double visits to urls in multithreaded environment
            this.updateVisitedLocation(location);

            // Start next fetch op (no await)
            void thread.fetch(location, this.visited);

            // Logging
            if(thread.requestHeadEnabled) {
                this.stats.totals.requestedHead++;
                this.stats.logs.requestedHead.push(location.url);
            }
        } else {
            this.runtime.activeThreads.delete(thread);
            this.threadCount--;
        }
    }


    beforeRequestEvent(location: Location): void {
        if(!this.isLocationInScope(location)) {
            return;
        }

        // Trigger callback on any jobs with onBeforeRequest set.
        this.jobs.dispatchEvent('onBeforeRequest', location);
    }


    headersReceivedEvent(response: AxiosResponse|null, location: Location): void {
        if(!this.isLocationInScope(location)) {
            return;
        }

        // Cached responses pass a null Axios response, so normalize status from the Location.
        const statusCode = response?.status ?? location.statusCode ?? 0;
        const statusText = response?.statusText ?? 'CACHED';
        const redirectUrl = String(response?.headers.location ?? "");

        if (statusCode >= 200 && statusCode < 300) {
            if(!this.muteResponseStatus) {
                this.console.log(`${statusCode} ${statusText}: ${location.url}`, 'green.bold');
            }
        } else if (statusCode >= 300 && statusCode < 400) {
            const theme = statusCode === 302 ? 'cyan.bold' : 'yellow.bold';
            if (redirectUrl !== "") {
                // Store redirect chain metadata on both the source and target locations so jobs
                // can report the original link, the next hop, and later final-target health.
                const redirectLocation = this.runtime.urlHelper.createLocationFromLink(redirectUrl, location);
                if(redirectLocation) {
                    const redirectRoot = location.redirectRoot ?? location.url;
                    const redirectChain = [...(location.redirectChain ?? [location.url]), redirectLocation.url];
                    location.redirectedTo = redirectLocation.url;
                    location.redirectRoot = redirectRoot;
                    location.redirectChain = redirectChain;
                    if(typeof this.visited[location.url] !== 'undefined') {
                        this.visited[location.url].redirectedTo = redirectLocation.url;
                        this.visited[location.url].redirectRoot = redirectRoot;
                        this.visited[location.url].redirectChain = redirectChain;
                    }
                    // Carry the original page occurrence through every hop. Redirect chain
                    // checks need to point back to the source markup, not lose attribution at
                    // the first intermediate URL.
                    redirectLocation.referer = location.referer;
                    redirectLocation.htmlSnippet = location.htmlSnippet;
                    redirectLocation.redirectedFrom = location.url;
                    redirectLocation.redirectRoot = redirectRoot;
                    redirectLocation.redirectChain = redirectChain;
                    redirectLocation.redirectCode = statusCode;
                    // Report redirect to console
                    if (statusCode !== 302 && !this.muteResponseStatus) {
                        const referral = location.referer !== null ? ` Referred by: ${location.referer}` : '';
                        this.console.log(`${redirectLocation.redirectCode} ${statusText}`
                            + ` ${redirectLocation.redirectedFrom} => ${redirectLocation.url}${referral}`, theme);
                    }
                    // Add redirected URL to pending queue
                    void this.addNewLocation(redirectLocation);
                }
            }
        } else if (statusCode === 403 || statusCode === 401) {
            if(!this.muteResponseStatus) {
                this.console.log(`${statusCode} ${statusText}: ${location.url}`, 'yellow.bold');
            }
        } else if (statusCode == 404) {
            if(!this.muteResponseStatus) {
                const referral = location.referer !== null ? ` Referred by: ${location.referer}` : '';
                this.console.log(`${statusCode} ${statusText}: ${location.url}${referral}`, 'red.bold');
            }
        } else if (statusCode >= 500) {
            //console.dir(response);
            if(!this.muteResponseStatus) {
                this.console.log(`${statusCode} ${statusText}: ${location.url}`, 'bgRed.white.bold');
            }
        } else if (statusCode >= 400) {
            if(!this.muteResponseStatus) {
                this.console.log(`${statusCode} ${statusText}: ${location.url}`, 'red.bold');
            }
            if(statusCode === 429) {
                const e = new Error('HTTP 429 Received (Too fast!) - Increase request delay and try again.');
                this.runtime.events.emit('error', e, undefined, undefined, false, true);
            }
        } else {
            if(!this.muteResponseStatus) {
                this.console.log(`${statusCode} ${statusText}: ${location.url}`, 'magenta.bold');
            }
        }

        // Trigger callback on any jobs with onHeadersReceived set.
        this.jobs.dispatchEvent('onHeadersReceived', response, location);
    }

    pageReceivedEvent(
        response: AxiosResponse|null,
        location: Location,
        auditOutcome?: PageAuditOutcome
    ): void {
        if(!this.isLocationInScope(location)) {
            return;
        }

        // PageData is the normalized payload sent to jobs. It contains both crawlable links
        // and raw anchor observations so jobs can audit markup quality.
        const pageData: PageData = {
            location: location,
            links: [],
            rawLinks: [],
            parseWarnings: [],
            contentType: auditOutcome?.contentType ?? '',
            auditOutcome
        };

        if(response) {

            const foundLinks: string[] = [location.url];

            // Scrape page for links to queue
            const contentTypeHeader: unknown = response.headers['content-type'] ?? '';
            pageData.contentType = normalizeContentTypeHeader(contentTypeHeader);

            // todo - count how many requested resources were not downloaded due to mime type & redirect (separately)

            this.stats.totals.downloadedData++;
            this.stats.logs.downloadedData.push(location.url);

            if (isHtmlContentType(pageData.contentType)) {

                this.stats.totals.pagesScraped++;
                this.stats.logs.pagesScraped.push(location.url);

                // JSDOM emits noisy stylesheet parse warnings for real-world sites; suppress
                // that known noise but surface other parser errors to the central handler.
                const vc = new VirtualConsole();
                vc.on('jsdomError', (err) => {
                    const msg = String(err?.message ?? err);
                    if (msg.includes('Could not parse CSS stylesheet')) {
                        // do nothing
                    } else {
                        this.runtime.events.emit('error', err, null, location);
                    }
                });

                try {
                    const dom = new JSDOM(String(response.data), {virtualConsole: vc});
                    const document = dom.window.document;

                    // Canonicals are crawled and tracked so jobs can compare source links,
                    // canonical targets, and final fetch health.
                    const canonicalElement: HTMLAnchorElement | null = document.querySelector('head link[rel="canonical"]');
                    if (canonicalElement !== null) {
                        const canonicalHref = canonicalElement.getAttribute('href');
                        if(canonicalHref !== null && canonicalHref !== "") {
                            let decodedCanonical = '';
                            try {
                                decodedCanonical = decodeURIComponent(canonicalHref).trim();
                            } catch (e) {
                                pageData.parseWarnings.push(this.createParseWarning(
                                    'malformed-canonical',
                                    canonicalHref,
                                    location,
                                    e
                                ));
                            }
                            const canonLoc = decodedCanonical !== ''
                                ? this.runtime.urlHelper.createLocationFromLink(decodedCanonical, location)
                                : null;
                            if(canonLoc && this.isLocationInScope(canonLoc)) {
                                canonLoc.referredAsCanonical = true;
                                pageData.canonical = canonLoc;
                                this.registerCanonicalAlias(location, canonLoc);
                                // Add Canonical URL to list of URLs to download
                                void this.addNewLocation(pageData.canonical);
                            }
                        }
                    }

                    // Record every anchor for jobs, then queue only normalized in-scope links.
                    document.querySelectorAll('a').forEach(element => {
                        const href = element.getAttribute('href');
                        const pageLink = this.createPageLink(element, href, location);
                        if(pageLink === null) {
                            return;
                        }
                        pageData.rawLinks.push(pageLink);
                        if(typeof pageLink.parseWarnings !== 'undefined') {
                            pageData.parseWarnings.push(...pageLink.parseWarnings);
                        }

                        if (href !== null && href !== '' && pageLink.parseWarnings === undefined) {
                            const newLocation = this.runtime.urlHelper.createLocationFromLink(decodeURIComponent(href).trim(), location);
                            const previewLocation = newLocation !== null ? {...newLocation} : null;
                            if(newLocation !== null
                                && previewLocation !== null
                                && this.runtime.urlHelper.prepareUrl(previewLocation)
                                && this.runtime.urlHelper.validateLocation(previewLocation.url, 'urlCantContain')
                                && this.runtime.urlHelper.validateLocation(previewLocation.url, 'urlMustContain')
                            ) {
                                newLocation.htmlSnippet = pageLink.htmlSnippet;
                                pageLink.normalizedUrl = getObservedLinkUrl(
                                    previewLocation.url,
                                    pageLink.normalizedUrl
                                );
                                pageLink.isExternal = false;
                                pageLink.isCrawlable = true;

                                if(foundLinks.indexOf(previewLocation.url) === -1) {
                                    // Prevent duplicates
                                    foundLinks.push(previewLocation.url);
                                    // log link to send to job callbacks
                                    pageData.links.push(href);
                                    // Add link URL to list of URLs to download
                                    void this.addNewLocation(newLocation);
                                }
                            }
                        }
                    });

                    pageData.jsdom = document;
                    pageData.auditOutcome = {
                        status: 'complete',
                        contentType: pageData.contentType
                    };

                } catch (e) {
                    const message = "An Error occurred while parsing page data!";
                    pageData.auditOutcome = {
                        status: 'failed',
                        phase: 'parse',
                        contentType: pageData.contentType,
                        message: e instanceof Error ? e.message : String(e),
                        statusCode: response.status
                    };
                    this.runtime.events.emit('error', e, message, location);
                }
            }
        }

        // Trigger callback on any jobs with onPageReceived set.
        this.jobs.dispatchEvent('onPageReceived', response, pageData);

    }

    private registerCanonicalAlias(location: Location, canonicalLocation: Location): void {
        // Remember canonical relationships so a non-canonical URL does not get fully
        // reprocessed after the canonical target has already been downloaded.
        const canonicalUrl = this.getPreparedLocationUrl(canonicalLocation);
        if(canonicalUrl === null || canonicalUrl === location.url) {
            return;
        }

        location.canonicalUrl = canonicalUrl;
        this.canonicalAliases[location.url] = canonicalUrl;
        if(typeof this.visited[location.url] !== 'undefined') {
            this.visited[location.url].canonicalUrl = canonicalUrl;
        }
    }

    private isCanonicalAliasAlreadyProcessed(location: Location): boolean {
        const canonicalUrl = this.canonicalAliases[location.url];
        return typeof canonicalUrl === 'string'
            && canonicalUrl !== location.url
            && this.visited[canonicalUrl]?.dataReceived === true;
    }

    private getPreparedLocationUrl(location: Location): string|null {
        const preparedLocation = {...location};
        if(!this.runtime.urlHelper.prepareUrl(preparedLocation)) {
            return null;
        }
        if(!this.runtime.urlHelper.validateLocation(preparedLocation.url, 'urlCantContain')
            || !this.runtime.urlHelper.validateLocation(preparedLocation.url, 'urlMustContain')) {
            return null;
        }

        return preparedLocation.url;
    }

    private createParseWarning(
        type: PageParseWarning['type'],
        rawValue: string,
        location: Location,
        e: unknown
    ): PageParseWarning {
        const message = e instanceof Error ? e.message : String(e);
        return {
            type,
            message,
            rawValue,
            referer: location.url
        };
    }

    private createPageLink(element: HTMLAnchorElement, href: string|null, location: Location): PageLink|null {
        // PageLink keeps raw markup facts separate from crawlability decisions. Jobs can report
        // malformed hrefs even when the crawler cannot turn them into fetchable locations.
        const rawHref = href ?? '';
        const pageLink: PageLink = {
            rawHref,
            hasHref: href !== null,
            htmlSnippet: this.getAnchorHtmlSnippet(element),
            referer: location.url,
            text: String(element.textContent ?? '').trim(),
            target: element.getAttribute('target') ?? undefined,
            rel: element.getAttribute('rel') ?? undefined,
            zone: this.classifyLinkZone(element),
            isExternal: false,
            isCrawlable: false
        };

        if(href === null || href === '') {
            return pageLink;
        }

        let decodedHref = '';
        try {
            decodedHref = decodeURIComponent(href).trim();
        } catch (e) {
            const warning = this.createParseWarning('malformed-href', href, location, e);
            warning.htmlSnippet = pageLink.htmlSnippet;
            pageLink.parseWarnings = [warning];
            return pageLink;
        }

        try {
            const normalizedUrl = new URL(decodedHref, location.url);
            if(this.isFilteredInternalUrl(normalizedUrl)) {
                return null;
            }
            pageLink.normalizedUrl = normalizedUrl.href;
            pageLink.isExternal = this.isExternalUrl(normalizedUrl);
        } catch (e) {
            const warning = this.createParseWarning('malformed-href', href, location, e);
            warning.htmlSnippet = pageLink.htmlSnippet;
            pageLink.parseWarnings = [warning];
        }

        return pageLink;
    }

    private getAnchorHtmlSnippet(element: HTMLAnchorElement): string {
        const innerHtml = element.innerHTML;
        if(Buffer.byteLength(innerHtml, 'utf8') <= 128) {
            return element.outerHTML.trim();
        }

        const emptyAnchor = element.cloneNode(false) as HTMLAnchorElement;
        const openingTag = emptyAnchor.outerHTML.trim().replace(/><\/a>$/i, '>');
        const renderedContent = this.getTrimmedAnchorRenderedContent(element);
        const summary = renderedContent === ''
            ? 'inner HTML trimmed; no rendered text or images detected'
            : `inner HTML trimmed; rendered content: ${renderedContent}`;

        return `${openingTag}[${summary}]</a>`;
    }

    private getTrimmedAnchorRenderedContent(element: HTMLAnchorElement): string {
        const content: string[] = [];
        const text = String(element.textContent ?? '').replace(/\s+/g, ' ').trim();
        if(text !== '') {
            const trimmedText = this.trimUtf8Bytes(text, 128);
            content.push(`text "${trimmedText.value}${trimmedText.trimmed ? '...' : ''}"`);
        }

        const imageLabels = Array.from(element.querySelectorAll('img')).map(image => {
            const label = image.getAttribute('alt')
                ?? image.getAttribute('title')
                ?? image.getAttribute('aria-label')
                ?? image.getAttribute('src')
                ?? '';
            const trimmedLabel = this.trimUtf8Bytes(label.replace(/\s+/g, ' ').trim(), 96);
            return trimmedLabel.value === ''
                ? 'image'
                : `image "${trimmedLabel.value}${trimmedLabel.trimmed ? '...' : ''}"`;
        });
        if(imageLabels.length > 0) {
            const visibleImages = imageLabels.slice(0, 5).join(', ');
            const suffix = imageLabels.length > 5 ? `, ... ${imageLabels.length - 5} more` : '';
            content.push(`images ${visibleImages}${suffix}`);
        }

        return content.join('; ');
    }

    private trimUtf8Bytes(value: string, maxBytes: number): { value: string; trimmed: boolean } {
        let bytes = 0;
        let output = '';
        for(const character of value) {
            const characterBytes = Buffer.byteLength(character, 'utf8');
            if(bytes + characterBytes > maxBytes) {
                return {value: output, trimmed: true};
            }
            bytes += characterBytes;
            output += character;
        }
        return {value: output, trimmed: false};
    }

    private isLocationInScope(location: Location): boolean {
        const normalizedLocation = {...location};
        if(!this.runtime.urlHelper.prepareUrl(normalizedLocation)) {
            return false;
        }

        return this.runtime.urlHelper.validateLocation(normalizedLocation.url, 'urlCantContain')
            && this.runtime.urlHelper.validateLocation(normalizedLocation.url, 'urlMustContain');
    }

    private isFilteredInternalUrl(url: URL): boolean {
        if(this.isExternalUrl(url) || url.protocol.match(/^https?:$/) === null) {
            return false;
        }

        const normalizedLocation: Location = {
            url: url.href,
            rawUrl: url.href
        };
        if(!this.runtime.urlHelper.prepareUrl(normalizedLocation)) {
            return true;
        }

        return !this.runtime.urlHelper.validateLocation(normalizedLocation.url, 'urlCantContain')
            || !this.runtime.urlHelper.validateLocation(normalizedLocation.url, 'urlMustContain');
    }

    private isExternalUrl(url: URL): boolean {
        const base = new URL(this.baseUrl);
        return url.protocol.match(/^https?:$/) !== null
            && url.hostname.replace(/^www\./i, '') !== base.hostname.replace(/^www\./i, '');
    }

    private classifyLinkZone(element: HTMLAnchorElement): LinkZone {
        // A coarse DOM zone helps reports distinguish likely shared wrapper links
        // from one-off links inside page body content.
        if(element.closest('nav,[role="navigation"]') !== null) { return 'nav'; }
        if(element.closest('header,[role="banner"]') !== null) { return 'header'; }
        if(element.closest('footer,[role="contentinfo"]') !== null) { return 'footer'; }
        if(element.closest('aside') !== null) { return 'aside'; }
        if(element.closest('main') !== null) { return 'main'; }

        const main = element.ownerDocument.querySelector('main');
        if(main !== null) {
            const position = element.compareDocumentPosition(main);
            if((position & 4) !== 0) { return 'before-main'; }
            if((position & 2) !== 0) { return 'after-main'; }
        }

        return 'unknown';
    }

    // Error Event Handler (Should catch error events emitted in jobs as well)
    errorEventHandler(e: Error, message?: string, location?: Location, suppressEmail?: boolean, fatal?: boolean): void {

        // Log the error data locally
        const error: CrawlerError = {
            error: e,
            message: message ?? e.message,
            location: location,
            suppressEmail: suppressEmail,
            fatal: fatal,
        };

        // Log error for report email
        this.errors.push(error);

        // Display log to console
        this.console.log('-------------------------------------------------', 'red');
        this.console.log(error.message, 'red.bold');
        if(typeof location !== 'undefined') {
            this.console.logObject(location, 40);
        }
        console.log(' '); // blank line
        //console.error(e);
        this.console.log('-------------------------------------------------', 'red');


        // Terminate execution on fatal flag.
        if(fatal === true) {
            if(this.fatalShutdownStarted) {
                return;
            }
            this.fatalShutdownStarted = true;

            // Stop all workers and cancel in-flight requests.
            this.runtime.abort(error.message);
            this.runtime.lock.lock(true);

            this.fatalShutdownPromise = this.sendFatalErrorReport();
        }
    }

    private async finalizeFatalShutdown(): Promise<number> {
        await this.fatalShutdownPromise;
        const settleResult = await this.waitForActiveThreadsToSettle();
        if(!settleResult.settled) {
            this.console.log(
                `Fatal shutdown continued with ${settleResult.remaining} active worker(s) still unsettled after 5 seconds.`,
                'yellow.bold',
                true
            );
        }
        this.runtime.dispose();

        return 1;
    }

    private async waitForActiveThreadsToSettle(): Promise<{settled: boolean; remaining: number}> {
        const deadline = Date.now() + 5000;
        while(this.runtime.activeThreads.size > 0 && Date.now() < deadline) {
            await sleep(pollMsExt);
        }

        const remaining = this.runtime.activeThreads.size;
        return {
            settled: remaining === 0,
            remaining
        };
    }

    private async sendFatalErrorReport(): Promise<void> {
        try {
            this.profiler.mark('error-report-email', 'fatal error report email send starting');
            await new ReportManager(this.profiler, this.runtime.config).sendErrorReport(this.errors, this.stats, this.jobs.jobs, true);
            this.profiler.mark('error-report-email', 'fatal error report email send complete');
        } catch(e) {
            this.console.log('Fatal error report email failed to send.', 'red.bold');
            if(e instanceof Error) {
                this.console.log(e.message, 'red');
            }
        }
    }
}
