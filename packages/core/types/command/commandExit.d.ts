export declare class CommandExit extends Error {
    readonly statusCode: number;
    constructor(statusCode?: number, message?: string);
}
export declare function isCommandExit(error: unknown): error is CommandExit;
