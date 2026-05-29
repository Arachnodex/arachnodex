import type { ConfigLoader } from "./configLoader.js";
export declare class OutputHelper {
    private readonly config;
    muteResponseStatus: boolean;
    muteAll: boolean;
    disableColorOutput: boolean;
    jobInstance: boolean;
    constructor(jobInstance?: boolean, readConfig?: boolean, config?: ConfigLoader);
    log(message: string, theme?: string, force?: boolean): void;
    logObject(object: unknown, labelColumnWidth?: number, indented?: boolean, force?: boolean, theme?: {
        prop: string;
        value: string;
    }): void;
    applyLogColorTheme(message: string, theme: string): string;
}
