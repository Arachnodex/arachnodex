import type { FileHandle } from "fs/promises";
import type EventEmitter from "eventemitter3";
import type { Location } from "@arachnodex/core";
export declare class StreamWriter {
    outputFile: string;
    writeBuffer: string[];
    writer?: FileHandle;
    events: EventEmitter;
    running: boolean;
    bufferFlushComplete: boolean;
    readonly ready: Promise<void>;
    private flushPromise?;
    private failed;
    private fatalEmitted;
    constructor(outputFile: string, events: EventEmitter);
    init(): Promise<void>;
    flushBuffer(): Promise<void>;
    write(entry: string): void;
    terminate(): Promise<void>;
    hasFailed(): boolean;
    emitFatal(e: Error, message: string, location?: Location): void;
    private emitFatalOnce;
}
