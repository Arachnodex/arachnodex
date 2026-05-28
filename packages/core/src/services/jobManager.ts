"use strict";

import type {BaseJob} from '../jobs/baseJob.js'
import type {JobCommand, PageData, Location} from '../definitions.ts';
import type {AxiosResponse} from "axios";

import {JobCommandParser} from "../command/jobCommandParser.js";
import type {Profiler} from "./profiler.js";
import eventBus from '../lib/eventBus.js';
import {getJobModuleName} from "../jobs/jobModules.js";

type BaseJobCtor = new (...args: unknown[]) => BaseJob;
type JcpCtor = new (...args: unknown[]) => JobCommandParser;
type JobModule = {
    default?: BaseJobCtor;
    CommandParser?: JcpCtor;
};
type CallbackKeys =
| 'onInit'
| 'onBeforeRequest'
| 'onHeadersReceived'
| 'onPageReceived'
| 'onEnd';

type EventArgsMap = {
    onInit: [];
    onBeforeRequest: [Location];
    onHeadersReceived: [AxiosResponse|null, Location];
    onPageReceived: [AxiosResponse|null, PageData];
    onEnd: [];
};

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

function hasDefaultCtor(v: unknown): v is { default: BaseJobCtor } {
    return isRecord(v) && typeof v.default === 'function';
}
function isJobModule(v: unknown): v is JobModule {
    return isRecord(v);
}
function hasCallback<K extends CallbackKeys>(
    job: BaseJob,
    key: K
): job is BaseJob & { [P in K]-?: (...a: EventArgsMap[P]) => unknown } {
    const slot = (job as unknown as Record<string, unknown>)[key];
    return typeof slot === 'function';
}

export class JobManager {

    jobCommands: {[k: string]: JobCommand};
    jobs: BaseJob[] = [];
    profiler: Profiler;
    verbosityLevel: number;

    constructor(jobs: {[k: string]: JobCommand}, profiler: Profiler, verbosityLevel = 0) {
        this.jobCommands = jobs;
        this.verbosityLevel = verbosityLevel;
        this.profiler = profiler;
    }

    async importJob() {

        // Get first job in job queue
        const jobHandle = Object.keys(this.jobCommands)[0] ?? null;

        // No more jobs? Signal job loading complete.
        if(jobHandle === null) { return false; }

        // Get full JobCommand object and then remove from queue
        const jobCommand = this.jobCommands[jobHandle];
        delete this.jobCommands[jobHandle];

        try {

            // Job handles are resolved at runtime so core can load bundled jobs,
            // scoped third-party packages, and exact npm: package names with one path.
            const moduleName = getJobModuleName(jobHandle);
            const jobUnknown: unknown = await import(moduleName);
            const jcParser = this.getJobCommandParser(jobUnknown, jobHandle, jobCommand.arguments);
            let job: BaseJob;
            if (hasDefaultCtor(jobUnknown)) {
                const JobClass = jobUnknown.default;
                job = new JobClass(jobHandle, jcParser, this.profiler);
                job.loadConfig();
                job.verbosityLevel = this.verbosityLevel;
            } else {
                throw new Error(`Job module ${moduleName} has no default class export`);
            }

            // Announce loaded
            job.announce();

            // Add the job to the job stack
            this.jobs.push(job);

            // Signal job import success
            return true;


        } catch(e) {
            console.error(e);
            eventBus.emit(
                'error',
                e,
                'An error during job class import.',
                undefined,
                false,
                true);

            return false;

        }

    }

    // Trickle crawler events down to individual jobs
    dispatchEvent<K extends CallbackKeys>(callback: K, ...args: EventArgsMap[K]) {
        for (const job of this.jobs) {
            if (hasCallback(job, callback)) {
                if(callback === 'onEnd') {
                    // Shutdown hooks may be async, so route them through the wrapper that
                    // records profiler state and lets the crawler wait for job.completed.
                    this.dispatchJobShutdown(job);
                    continue;
                }

                (job[callback] as (...a: EventArgsMap[K]) => unknown).call(job, ...args);
            }
        }
    }

    private getJobCommandParser(jobModule: unknown, jobHandle: string, args: string[]): JobCommandParser {
        // Jobs can optionally export their own parser for job-specific switches. Without one,
        // the generic parser still gives the job a config switch and parsed argument shape.
        if(isJobModule(jobModule) && typeof jobModule.CommandParser === 'function') {
            return new jobModule.CommandParser(args, jobHandle);
        }

        return new JobCommandParser(args, {}, jobHandle);
    }

    private dispatchJobShutdown(job: BaseJob): void {
        if(!hasCallback(job, 'onEnd')) {
            return;
        }

        this.profiler.markJob(job.handle, 'shutdown', 'starting job shutdown/reporting process');
        try {
            const result = job.onEnd();
            if(this.isPromiseLike(result)) {
                // Do not await here; the crawler polls running jobs so one slow job does not
                // block dispatching shutdown to later jobs.
                void result.then(() => {
                    this.profiler.markJob(job.handle, 'shutdown', 'job shutdown/reporting process complete');
                }).catch((e: unknown) => {
                    this.profiler.markJob(job.handle, 'shutdown', 'job shutdown/reporting process failed');
                    eventBus.emit(
                        'error',
                        e instanceof Error ? e : new Error(String(e)),
                        'An error occurred during job shutdown/reporting.',
                        undefined,
                        false,
                        true
                    );
                });
                return;
            }

            this.profiler.markJob(job.handle, 'shutdown', 'job shutdown/reporting process complete');
        } catch(e) {
            this.profiler.markJob(job.handle, 'shutdown', 'job shutdown/reporting process failed');
            eventBus.emit(
                'error',
                e instanceof Error ? e : new Error(String(e)),
                'An error occurred during job shutdown/reporting.',
                undefined,
                false,
                true
            );
        }
    }

    private isPromiseLike(value: unknown): value is Promise<unknown> {
        return typeof value === 'object'
            && value !== null
            && typeof (value as {then?: unknown}).then === 'function';
    }

    getRunningJobCount() {
        let count = 0;
        this.jobs.forEach(job => {
            if(!job.completed) {
                count++;
            }
        });

        return count;
    }

}
