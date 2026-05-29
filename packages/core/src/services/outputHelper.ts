"use strict";

import {ConfigService} from "./configLoader.js";
import type {ConfigLoader} from "./configLoader.js";
import chalk from 'chalk';

// Define allowed chalk style keys
type ChalkFunction = (...args: unknown[]) => string;
type ChalkChainable = typeof chalk;

// Strict list of allowed style names (pulls from Chalk’s public API)
type ChalkStyleKey = keyof ChalkChainable;

function isRecord(v: unknown): v is Record<PropertyKey, unknown> {
    return (typeof v === 'object' || Array.isArray(v)) && v !== null;
}

export class OutputHelper {

    muteResponseStatus: boolean;
    muteAll: boolean;
    disableColorOutput: boolean;
    jobInstance: boolean;

    constructor(jobInstance = false, readConfig = true, private readonly config: ConfigLoader = ConfigService) {
        this.jobInstance = jobInstance;
        this.muteResponseStatus = readConfig ? this.config.getConfigBoolean('muteResponseStatus') : false;
        this.muteAll = readConfig ? this.config.getConfigBoolean('muteAll') : false;
        this.disableColorOutput = readConfig ? this.config.getConfigBoolean('disableColorOutput') : false;
    }


    // Colorized output controls all console output in one place
    log(message: string, theme = "", force = false,):void {

        // No output if muted and not forced.
        if (((!this.jobInstance && this.muteResponseStatus) || this.muteAll) && !force) {
            return;
        }

        // Themeify the text
        message = this.applyLogColorTheme(message, theme);

        // Output
        console.log(message);
    }

    // Colorized and indented output
    // currently on supports simple single layer string value "objects".
    // would prefer not declare type of object here, but I can't use any or never for the values in the signature
    // so I'm not sure what other option there is.
    logObject(object: unknown, labelColumnWidth = 50, indented = true, force = false, theme = {
        prop: 'white.bold',
        value: 'gray',
    }):void {

        // No output if muted and not forced.
        if (((!this.jobInstance && this.muteResponseStatus) || this.muteAll) && !force) {
            return;
        }

        const indent = indented ? '\t' : '';

        let outputStarted = false;


        if(isRecord(object)) {
            for(const prop in object) {
                if (typeof object[prop] === 'string' || typeof object[prop] === 'number') {
                    // Output formatted string for current property
                    console.log(indent + this.applyLogColorTheme(prop, theme.prop).padEnd(labelColumnWidth)
                        + "\t" + this.applyLogColorTheme(String(object[prop]), theme.value));
                } else {
                    // Output current property with <object> style value override for non string values.
                    console.log(indent + this.applyLogColorTheme(prop, theme.prop).padEnd(labelColumnWidth)
                        + "\t" + this.applyLogColorTheme('<' + typeof object[prop] + '>', theme.value));
                }
                // signify the error should not be shown at the end.
                outputStarted = true;
            }
        }

        // Output Error
        if(!outputStarted) {
            const message = "Invalid object for `fancyLogObject`. The `object` parameter signature must match `{prop: string}` format.";
            console.log(this.applyLogColorTheme(message, 'red.bold'));
        }

    }

    applyLogColorTheme(message: string, theme: string): string {
        if (theme === '' || this.disableColorOutput) return message;

        const parts = theme.split('.') as ChalkStyleKey[];

        let styled: unknown = chalk;

        for (const part of parts) {
            if (
                (typeof styled === 'object' || typeof styled === 'function') &&
                styled !== null &&
                part in styled
            ) {
                const maybeFunc = (styled as Record<string, unknown>)[part];
                if (typeof maybeFunc === 'function') {
                    styled = maybeFunc;
                } else {
                    // If the property exists but isn’t a function, break early
                    return message;
                }
            } else {
                // Invalid chain step, bail
                return message;
            }
        }
        return typeof styled === 'function' ? (styled as ChalkFunction)(message) : message;
    }
}
