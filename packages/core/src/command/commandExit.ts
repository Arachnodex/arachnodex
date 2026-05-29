"use strict";

export class CommandExit extends Error {
    readonly statusCode: number;

    constructor(statusCode = 0, message = "Command requested exit.") {
        super(message);
        this.name = "CommandExit";
        this.statusCode = statusCode;
    }
}

export function isCommandExit(error: unknown): error is CommandExit {
    return error instanceof CommandExit;
}
