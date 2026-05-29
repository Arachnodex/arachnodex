import type { ArgumentConfig } from "../definitions.ts";
import { BaseCommandParser } from "./baseCommandParser.js";
export declare class JobCommandParser extends BaseCommandParser {
    jobHandle: string;
    constructor(args: string[], switches?: {
        [k: string]: ArgumentConfig;
    }, jobHandle?: string);
    getConfigName(): string;
    protected shouldHideSwitchInHelp(argument: ArgumentConfig): boolean;
}
