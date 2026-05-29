"use strict";
import type {FileHandle} from "fs/promises";
import {open} from "fs/promises";
import {setTimeout} from "timers/promises";
import type EventEmitter from "eventemitter3";
import type {Location} from "@arachnodex/core";

export class StreamWriter {

    // Main function props
    outputFile: string;
    writeBuffer: string[] = [];
    writer?: FileHandle
    events: EventEmitter;

    // Async helpers
    running = false;
    bufferFlushComplete = false;
    readonly ready: Promise<void>;
    private flushPromise?: Promise<void>;
    private failed = false;
    private fatalEmitted = false;

    constructor(outputFile: string, events: EventEmitter) {
        this.outputFile = outputFile;
        this.events = events;
        this.ready = this.init();
    }

    async init(): Promise<void> {
        try {
            this.writer = await open(this.outputFile, 'w');
        } catch(e) {
            this.failed = true;
            this.bufferFlushComplete = true;
            this.emitFatalOnce(
                e instanceof Error ? e : new Error('Unspecified Error'),
                `[sitemap] Unable to create write stream to '${this.outputFile}'!`
            );
            return;
        }

        this.flushPromise = this.flushBuffer();
    }

    async flushBuffer() {

        this.running = true;
        try {
            while ((this.running || this.writeBuffer.length > 0) && !this.failed) {

                // If there is nothing to write wait a bit before recycling the loop
                if(this.writeBuffer.length === 0) {
                    await setTimeout(150);
                    continue;
                }

                // clone and clear write buffer
                const data = [...this.writeBuffer];
                this.writeBuffer = [];

                if(typeof this.writer === 'undefined') {
                    throw new Error('FS FileHandle not open for writing.');
                }

                await this.writer.write(data.join(''));
            }
        } catch(e) {
            this.failed = true;
            this.emitFatalOnce(
                e instanceof Error ? e : new Error('Unspecified Error'),
                `[sitemap] Couldn't write data stream to '${this.outputFile}'!`
            );
        } finally {
            this.running = false;
            try {
                await this.writer?.close();
            } catch(e) {
                this.failed = true;
                this.emitFatalOnce(
                    e instanceof Error ? e : new Error('Unspecified Error'),
                    `[sitemap] Couldn't close data stream to '${this.outputFile}'!`
                );
            }
            this.bufferFlushComplete = true;
        }

    }

    write(entry: string) {
        if(this.failed) {
            return;
        }

        this.writeBuffer.push(entry);
    }

    async terminate() {
        await this.ready;
        this.running = false;
        await this.flushPromise;

        // wait for writing complete
        while (!this.bufferFlushComplete) {
            await setTimeout(150);
        }

    }

    hasFailed(): boolean {
        return this.failed;
    }

    // Error helper
    emitFatal(e:Error, message: string, location?: Location) {
        this.events.emit(
            'error',
            e,
            message,
            location,
            false,
            true);
    }

    private emitFatalOnce(e: Error, message: string, location?: Location): void {
        if(this.fatalEmitted) {
            return;
        }

        this.fatalEmitted = true;
        this.emitFatal(e, message, location);
    }
}
