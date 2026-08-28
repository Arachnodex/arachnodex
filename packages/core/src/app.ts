// App Bootstrap
"use strict";
import type {Location, PageAuditOutcome} from "./definitions.ts";
import type {AxiosResponse} from "axios";
import type {ArachnodexThread} from "./arachnodexThread.js";
import { Arachnodex } from './arachnodex.js';
import {MainCommandParser} from "./command/mainCommandParser.js";
import {OutputHelper} from "./services/outputHelper.js";
import {ArachnodexRuntime} from "./runtime.js";
import {isCommandExit} from "./command/commandExit.js";

export async function runApp(args: string[] = process.argv.slice(2), runtime = new ArachnodexRuntime()): Promise<number> {
    const C = new OutputHelper(false, false);
    const events = runtime.events;

    // Register boot errors before parsing config or importing jobs so startup failures
    // render consistently instead of escaping as raw promise rejections.
    events.on('boot-error', (e: Error) => {
        // Display log to console
        C.log('-------------------------------------------------', 'red.bold');
        C.log(e.message, 'red.bold');
        console.log(' '); // blank line
        console.error(e);
        C.log('-------------------------------------------------', 'red.bold');
    });

    let booted = false;

    try {
        const command = new MainCommandParser(args);
        if(command.helpRequested()) {
            await command.showHelpMessage();
            return 0;
        }

        runtime.config.loadAppConfig(command.getConfigName(), command);

        // Build the crawler after parsing commands; the constructor validates required config.
        const arachnodex = new Arachnodex(command, runtime);
        if(command.testReportEmailEnabled()) {
            await arachnodex.sendTestReportEmail();
            return 0;
        }

        // Set booted flag true for error handler
        booted = true;

        // Wire worker/job events back into the main crawler. Each listener guards its own
        // handler so an event failure can become a normal crawler error report.
        events.on('error', arachnodex.errorEventHandler.bind(arachnodex));

        events.on("before-request", (location: Location) => {
            try {
                arachnodex.beforeRequestEvent(location);
            } catch (err) {
                events.emit('error', err, 'beforeRequestEvent failed:', undefined, false, true);
            }
        });

        events.on("headers-received", (response: AxiosResponse | null, location: Location) => {
            try {
                arachnodex.headersReceivedEvent(response, location);
            } catch (err) {
                events.emit('error', err, 'headersReceivedEvent failed:', undefined, false, true);
            }
        });

        events.on("page-received", (
            response: AxiosResponse | null,
            location: Location,
            auditOutcome?: PageAuditOutcome
        ) => {
            try {
                arachnodex.pageReceivedEvent(response, location, auditOutcome);
            } catch (err) {
                events.emit('error', err, 'pageReceivedEvent failed:', undefined, false, true);
            }
        });

        events.on("location-visited", (locationUrl: string, statusCode: number) => {
            try {
                arachnodex.locationLogVisitedEvent(locationUrl, statusCode);
            } catch (err) {
                events.emit('error', err, 'locationLogVisitedEvent failed:', undefined, false, true);
            }
        });

        events.on("new-locations-added", () => {
            void arachnodex.locationsAddedEvent().catch((err) => {
                events.emit('error', err, 'locationsAddedEvent failed:', undefined, false, true);
            });
        });

        events.on("retry-location", (
            location: Location,
            resolve?: () => void,
            reject?: (err: unknown) => void
        ) => {
            void arachnodex.retryLocationEvent(location).then(() => {
                if(typeof resolve === 'function') {
                    resolve();
                }
            }).catch((err) => {
                events.emit('error', err, 'retryLocationEvent failed:', undefined, false, true);
                if(typeof reject === 'function') {
                    reject(err);
                }
            });
        });

        events.on('thread-ready', (thread: ArachnodexThread) => {
            void arachnodex.threadReadyEvent(thread).catch((err) => {
                events.emit('error', err, 'threadReadyEvent failed:', undefined, false, true);
            });
        });

        // Start the crawl
        return await arachnodex.start();
    } catch(e) {
        if(isCommandExit(e)) {
            return e.statusCode;
        }

        if(booted) {
            // Standard Error Handling
            events.emit(
                'error',
                e,
                undefined,
                undefined,
                false,
                true
            );
            return 1;
        } else {
            // Bootstrap error handler
            events.emit('boot-error', e);
            return 1;
        }
    } finally {
        runtime.dispose();
    }
}
