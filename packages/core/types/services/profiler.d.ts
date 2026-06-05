import { OutputHelper } from "./outputHelper.js";
export type ProfilerEntry = {
    namespace: string;
    label: string;
    stepSeconds: number;
    totalSeconds: number;
    message: string;
};
export declare class Profiler {
    private readonly startedAt;
    private readonly marks;
    private readonly entries;
    private readonly console;
    private enabled;
    constructor(enabled?: boolean, consoleHelper?: OutputHelper);
    setEnabled(enabled: boolean): void;
    isEnabled(): boolean;
    mark(label: string, message: string): void;
    markJob(jobHandle: string, label: string, message: string): void;
    getDurationSeconds(): number;
    getEntries(): ProfilerEntry[];
    private markEntry;
    private secondsSince;
    private secondsBetween;
}
