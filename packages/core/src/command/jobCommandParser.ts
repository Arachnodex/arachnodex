"use strict";
import type {ArgumentConfig} from "../definitions.ts";
import {BaseCommandParser} from "./baseCommandParser.js";

export class JobCommandParser extends BaseCommandParser {

    jobHandle: string;

    // Takes additional `jobHandle` parameter. Stores it locally and uses that as the default
    // config file name if -c switch is not specified.
    constructor(args: string[], switches:{[k: string]: ArgumentConfig} = {}, jobHandle = "") {
        super(args, switches);
        this.jobHandle = jobHandle;
    }

    // Get config via command line -c switch or use job handle as default.
    getConfigName(): string {
        return super._getConfigName(this.jobHandle);
    }

    protected shouldHideSwitchInHelp(argument: ArgumentConfig): boolean {
        return argument === this.arguments['-j'];
    }

}
