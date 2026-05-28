"use strict";

import {pathToFileURL} from "url";
import {runApp} from "./app.js";

export {runApp} from "./app.js";
export {JobCommandParser} from "./command/jobCommandParser.js";
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

if(process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void runApp();
}
