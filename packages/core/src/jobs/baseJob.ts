"use strict";


import type {Location, PageData, ReportData} from "../definitions.js";
import type {JobCommandParser} from "../command/jobCommandParser.js";
import type {AxiosResponse} from "axios";

import type {Profiler} from "../services/profiler.js";
import {ArachnodexRuntime} from "../runtime.js";

export interface Job {
    // Jobs implement whichever lifecycle hooks they need. The crawler checks for
    // each hook before dispatching events, so most jobs only override a few.
    name?: string;
    handle: string;
    loadConfig(): void;
    onInit?(): void;
    onBeforeRequest?(_location: Location): void;
    onHeadersReceived?(_response: AxiosResponse|null, _location: Location): void;
    onPageReceived?(_response: AxiosResponse|null, _pageData: PageData): void;
    onEnd?(): void | Promise<void>;
}

export abstract class BaseJob implements Job {

    name?: string;

    // Override these in child classes when the job has required config or async work.
    configRequired: boolean = false;
    completed: boolean = false;

    // Internal use, do not override
    handle: string;
    command: JobCommandParser;
    profiler: Profiler;
    runtime: ArachnodexRuntime;
    verbosityLevel = 0;
    emailReportEnabled = true;

    constructor(handle: string, command: JobCommandParser, profiler: Profiler, runtime = new ArachnodexRuntime()) {
        this.handle = handle;
        this.command = command;
        this.profiler = profiler;
        this.runtime = runtime;
    }

    get config() {
        return this.runtime.config;
    }

    get events() {
        return this.runtime.events;
    }

    get urlHelper() {
        return this.runtime.urlHelper;
    }

    loadConfig() {
        // Default config keeps email reporting enabled. Jobs with more config should
        // override this and call this.config.getJobConfig with their own defaults.
        const config = this.config.getJobConfig({emailReportEnabled: true}, this.command, false, () => {});
        this.emailReportEnabled = config.emailReportEnabled;
    }

    getName(): string {
        return this.name ?? this.handle;
    }


    announce():void {
        console.log(this.getName()+ ' Job Loaded');
    }

    getReportTitle(): string {
        return this.getName() + ' Report';
    }

    getReportMessage(): string {
        return "";
    }

    getReportTemplate(): string {
        return "";
    }


    getReportData(): ReportData {
        // Report methods are intentionally no-ops by default so simple jobs can opt into
        // only console output, email summaries, or both.
        return {};
    }

    getReportHtml(): string {
        return "";
    }

    shouldSendEmailReport(): boolean {
        return this.emailReportEnabled;
    }

}
