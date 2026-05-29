import type { Location } from "./definitions.ts";
import { OutputHelper } from "./services/outputHelper.js";
export declare class ArachnodexThread {
    index: number;
    requestDelay: number;
    requestTimeout: number;
    requestTimeoutMaxRetries: number;
    console: OutputHelper;
    constructor(index: number);
    waitTurn(): Promise<void>;
    fetch(location: Location, visited: Record<string, Location>): Promise<void>;
    private isTimeoutError;
    private shouldRetryTimeout;
    private queueRetryLocation;
}
