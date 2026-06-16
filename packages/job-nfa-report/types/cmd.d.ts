import { JobCommandParser } from "@arachnodex/core";
export default class NfaReportCmd extends JobCommandParser {
    version: string;
    constructor(args: string[], job: string);
    getDescription(): string;
}
