import type { Location } from "./definitions.ts";
import { OutputHelper } from "./services/outputHelper.js";
import { ArachnodexRuntime } from "./runtime.js";
export declare class ArachnodexThread {
    private readonly runtime;
    index: number;
    requestDelay: number;
    requestTimeout: number;
    requestTimeoutMaxRetries: number;
    console: OutputHelper;
    constructor(index: number, runtime?: ArachnodexRuntime);
    waitTurn(): Promise<void>;
    fetch(location: Location, visited: Record<string, Location>): Promise<void>;
    private isTimeoutError;
    private shouldRetryTimeout;
    private sleep;
    private queueRetryLocation;
}
