// App Bootstrap
"use strict";
import type {Location} from "./definitions.ts";
import type {AxiosResponse} from "axios";
import type {ArachnodexThread} from "./arachnodexThread.js";
import { Arachnodex } from './arachnodex.js';
import {MainCommandParser} from "./command/mainCommandParser.js";
import eventBus from './lib/eventBus.js';
import {ConfigService} from "./services/configLoader.js";
import {OutputHelper} from "./services/outputHelper.js";

export async function runApp(args: string[] = process.argv.slice(2)): Promise<void> {
    const C = new OutputHelper(false, false);

    // Register boot errors before parsing config or importing jobs so startup failures
    // render consistently instead of escaping as raw promise rejections.
    eventBus.on('boot-error', (e: Error) => {
        // Display log to console
        C.log('-------------------------------------------------', 'red.bold');
        C.log(e.message, 'red.bold');
        console.log(' '); // blank line
        console.error(e);
        C.log('-------------------------------------------------', 'red.bold');

        // Terminate
        process.exit(1);
    });

    let booted = false;

    try {
        const command = new MainCommandParser(args);
        if(command.helpRequested()) {
            await command.showHelpMessage();
        }

        ConfigService.loadAppConfig(command.getConfigName(), command);

        // Build the crawler after parsing commands; the constructor validates required config.
        const arachnodex = new Arachnodex(command);
        if(command.testReportEmailEnabled()) {
            await arachnodex.sendTestReportEmail();
            process.exit(0);
        }

        // Set booted flag true for error handler
        booted = true;

        // Wire worker/job events back into the main crawler. Each listener guards its own
        // handler so an event failure can become a normal crawler error report.
        eventBus.on('error', arachnodex.errorEventHandler.bind(arachnodex));

        eventBus.on("before-request", (location: Location) => {
            try {
                arachnodex.beforeRequestEvent(location);
            } catch (err) {
                eventBus.emit('error', err, 'beforeRequestEvent failed:', undefined, false, true);
            }
        });

        eventBus.on("headers-received", (response: AxiosResponse | null, location: Location) => {
            try {
                arachnodex.headersReceivedEvent(response, location);
            } catch (err) {
                eventBus.emit('error', err, 'headersReceivedEvent failed:', undefined, false, true);
            }
        });

        eventBus.on("page-received", (response: AxiosResponse | null, location: Location) => {
            try {
                arachnodex.pageReceivedEvent(response, location);
            } catch (err) {
                eventBus.emit('error', err, 'pageReceivedEvent failed:', undefined, false, true);
            }
        });

        eventBus.on("location-visited", (locationUrl: string, statusCode: number) => {
            try {
                arachnodex.locationLogVisitedEvent(locationUrl, statusCode);
            } catch (err) {
                eventBus.emit('error', err, 'locationLogVisitedEvent failed:', undefined, false, true);
            }
        });

        eventBus.on("new-locations-added", () => {
            void arachnodex.locationsAddedEvent().catch((err) => {
                eventBus.emit('error', err, 'locationsAddedEvent failed:', undefined, false, true);
            });
        });

        eventBus.on("retry-location", (
            location: Location,
            resolve?: () => void,
            reject?: (err: unknown) => void
        ) => {
            void arachnodex.retryLocationEvent(location).then(() => {
                if(typeof resolve === 'function') {
                    resolve();
                }
            }).catch((err) => {
                eventBus.emit('error', err, 'retryLocationEvent failed:', undefined, false, true);
                if(typeof reject === 'function') {
                    reject(err);
                }
            });
        });

        eventBus.on('thread-ready', (thread: ArachnodexThread) => {
            void arachnodex.threadReadyEvent(thread).catch((err) => {
                eventBus.emit('error', err, 'threadReadyEvent failed:', undefined, false, true);
            });
        });

        // Start the crawl
        void arachnodex.start();
    } catch(e) {
        if(booted) {
            // Standard Error Handling
            eventBus.emit(
                'error',
                e,
                undefined,
                undefined,
                false,
                true
            );
        } else {
            // Bootstrap error handler
            eventBus.emit('boot-error', e);
        }
    }
}
