import { OutputHelper } from "./outputHelper.js";
export declare class Profiler {
    private readonly startedAt;
    private readonly marks;
    private readonly console;
    private enabled;
    constructor(enabled?: boolean, consoleHelper?: OutputHelper);
    setEnabled(enabled: boolean): void;
    isEnabled(): boolean;
    mark(label: string, message: string): void;
    markJob(jobHandle: string, label: string, message: string): void;
    getDurationSeconds(): number;
    private markEntry;
    private secondsSince;
    private secondsBetween;
}
