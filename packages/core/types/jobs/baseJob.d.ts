import type { Location, PageData, ReportData } from "../definitions.js";
import type { JobCommandParser } from "../command/jobCommandParser.js";
import type { AxiosResponse } from "axios";
import type { Profiler } from "../services/profiler.js";
import { ArachnodexRuntime } from "../runtime.js";
export interface Job {
    name?: string;
    handle: string;
    loadConfig(): void;
    onInit?(): void;
    onBeforeRequest?(_location: Location): void;
    onHeadersReceived?(_response: AxiosResponse | null, _location: Location): void;
    onPageReceived?(_response: AxiosResponse | null, _pageData: PageData): void;
    onEnd?(): void | Promise<void>;
}
export declare abstract class BaseJob implements Job {
    name?: string;
    configRequired: boolean;
    completed: boolean;
    handle: string;
    command: JobCommandParser;
    profiler: Profiler;
    runtime: ArachnodexRuntime;
    verbosityLevel: number;
    emailReportEnabled: boolean;
    constructor(handle: string, command: JobCommandParser, profiler: Profiler, runtime?: ArachnodexRuntime);
    get config(): import("../services/configLoader.js").ConfigLoader;
    get events(): import("eventemitter3")<string | symbol, any>;
    get urlHelper(): import("../services/urlHelper.js").UrlHelperService;
    loadConfig(): void;
    getName(): string;
    announce(): void;
    getReportTitle(): string;
    getReportMessage(): string;
    getReportTemplate(): string;
    getReportData(): ReportData;
    getReportHtml(): string;
    shouldSendEmailReport(): boolean;
}
