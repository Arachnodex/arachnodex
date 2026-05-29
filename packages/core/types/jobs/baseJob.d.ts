import type { Location, PageData, ReportData } from "../definitions.js";
import type { JobCommandParser } from "../command/jobCommandParser.js";
import type { AxiosResponse } from "axios";
import type { Profiler } from "../services/profiler.js";
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
    verbosityLevel: number;
    emailReportEnabled: boolean;
    constructor(handle: string, command: JobCommandParser, profiler: Profiler);
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
