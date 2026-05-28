"use strict";

import {OutputHelper} from "./outputHelper.js";

type MarkState = {
    last: bigint;
}

export class Profiler {

    private readonly startedAt = process.hrtime.bigint();
    private readonly marks = new Map<string, MarkState>();
    private readonly console: OutputHelper;
    private enabled: boolean;

    constructor(enabled = false, consoleHelper?: OutputHelper) {
        this.enabled = enabled;
        this.console = consoleHelper ?? new OutputHelper();
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    mark(label: string, message: string): void {
        this.markEntry('main', label, message);
    }

    markJob(jobHandle: string, label: string, message: string): void {
        this.markEntry(`job:${jobHandle}`, label, message);
    }

    getDurationSeconds(): number {
        return this.secondsSince(this.startedAt);
    }

    private markEntry(namespace: string, label: string, message: string): void {
        if(!this.enabled) {
            return;
        }

        const now = process.hrtime.bigint();
        const key = `${namespace}:${label}`;
        const state = this.marks.get(key);
        const stepSeconds = typeof state === 'undefined'
            ? 0
            : this.secondsBetween(state.last, now);

        this.marks.set(key, {last: now});
        this.console.log(
            `[profiler] ${namespace} ${label} +${stepSeconds.toFixed(2)}s (${this.secondsSince(this.startedAt).toFixed(2)}s total): ${message}`,
            'gray',
            true
        );
    }

    private secondsSince(start: bigint): number {
        return this.secondsBetween(start, process.hrtime.bigint());
    }

    private secondsBetween(start: bigint, end: bigint): number {
        return Number(end - start) / 1000000000;
    }

}
