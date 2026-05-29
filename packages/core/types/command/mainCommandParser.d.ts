import type { JobCommand } from "../definitions.ts";
import { BaseCommandParser } from "./baseCommandParser.js";
export declare class MainCommandParser extends BaseCommandParser {
    constructor(args: string[]);
    getDescription(): string;
    protected shouldAutoShowHelp(): boolean;
    showHelpMessage(): Promise<void>;
    getConfigName(): string;
    getVerbosityLevel(): number;
    profilerEnabled(): boolean;
    testReportEmailEnabled(): boolean;
    getJobs(): {
        [k: string]: JobCommand;
    };
    private getJobHelpMessage;
    private getJobCommandParserFactory;
}
