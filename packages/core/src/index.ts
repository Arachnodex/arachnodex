"use strict";

import {realpathSync} from "fs";
import {fileURLToPath, pathToFileURL} from "url";
import {runApp} from "./app.js";

export {runApp} from "./app.js";
export {ArachnodexRuntime} from "./runtime.js";
export {JobCommandParser} from "./command/jobCommandParser.js";
export {CommandExit, isCommandExit} from "./command/commandExit.js";
export {botProtectionHeuristics} from "@arachnodex/bot-protection-heuristics";
export type {BotProtectionHeuristics} from "@arachnodex/bot-protection-heuristics";
export type * from "./definitions.js";
export {BaseJob} from "./jobs/baseJob.js";
export type {Job} from "./jobs/baseJob.js";
export {default as eventBus} from "./lib/eventBus.js";
export {ConfigService} from "./services/configLoader.js";
export {OutputHelper} from "./services/outputHelper.js";
export {Profiler} from "./services/profiler.js";
export {defaultRequestHeaders} from "./services/requestHeaders.js";
export {UrlHelper} from "./services/urlHelper.js";

function isCliEntrypoint(): boolean {
    if(process.argv[1] === undefined) {
        return false;
    }

    const scriptPath = realpathSync(process.argv[1]);
    const modulePath = realpathSync(fileURLToPath(import.meta.url));

    return pathToFileURL(scriptPath).href === pathToFileURL(modulePath).href;
}

if(isCliEntrypoint()) {
    void runApp().then(statusCode => {
        process.exitCode = statusCode;
    }).catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
