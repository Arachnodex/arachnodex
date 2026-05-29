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

    constructor(outputFile: string, events: EventEmitter) {
        this.outputFile = outputFile;
        this.events = events;
        void this.init();
    }

    async init() {
        try {
            this.writer = await open(this.outputFile, 'w');
        } catch(e) {
            this.emitFatal(
                e instanceof Error ? e : new Error('Unspecified Error'),
                `[sitemap] Unable to create write stream to '${this.outputFile}'!`
            );
        }

        await this.flushBuffer();
    }

    async flushBuffer() {

        this.running = true;

        while (this.running || this.writeBuffer.length > 0) {

            // If there is nothing to write wait a bit before recycling the loop
            if(this.writeBuffer.length === 0) {
                await setTimeout(150);
                continue;
            }

            // clone and clear write buffer
            const data = [...this.writeBuffer];
            this.writeBuffer = [];

            // write the string buffer data to the stream
            // sets this.
            try {
                if(typeof this.writer === 'undefined') {
                    // noinspection ExceptionCaughtLocallyJS
                    throw new Error('FS FileHandle not open for writing.');
                }
                await this.writer.write(data.join(''));
            } catch(e) {
                await this.writer?.close();
                this.emitFatal(
                    e instanceof Error ? e : new Error('Unspecified Error'),
                    `[sitemap] Couldn't write data stream to '${this.outputFile}'!`
                );
            }
        }

        // Close stream
        await this.writer?.close();

        // Signal write completion
        this.bufferFlushComplete = true;

    }

    write(entry: string) {
        this.writeBuffer.push(entry);
    }

    async terminate() {
        this.running = false;

        // wait for writing complete
        while (!this.bufferFlushComplete) {
            await setTimeout(150);
        }

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
}
