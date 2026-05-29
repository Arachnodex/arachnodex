import type { BaseJob } from '../jobs/baseJob.js';
import type { JobCommand, PageData, Location } from '../definitions.ts';
import type { AxiosResponse } from "axios";
import type { Profiler } from "./profiler.js";
import { ArachnodexRuntime } from "../runtime.js";
type CallbackKeys = 'onInit' | 'onBeforeRequest' | 'onHeadersReceived' | 'onPageReceived' | 'onEnd';
type EventArgsMap = {
    onInit: [];
    onBeforeRequest: [Location];
    onHeadersReceived: [AxiosResponse | null, Location];
    onPageReceived: [AxiosResponse | null, PageData];
    onEnd: [];
};
export declare class JobManager {
    jobCommands: {
        [k: string]: JobCommand;
    };
    jobs: BaseJob[];
    profiler: Profiler;
    verbosityLevel: number;
    runtime: ArachnodexRuntime;
    constructor(jobs: {
        [k: string]: JobCommand;
    }, profiler: Profiler, verbosityLevel?: number, runtime?: ArachnodexRuntime);
    importJob(): Promise<boolean>;
    dispatchEvent<K extends CallbackKeys>(callback: K, ...args: EventArgsMap[K]): void;
    private getJobCommandParser;
    private dispatchJobShutdown;
    private isPromiseLike;
    getRunningJobCount(): number;
}
export {};
