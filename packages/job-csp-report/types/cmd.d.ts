import { JobCommandParser } from "@arachnodex/core";
export default class CspReportCmd extends JobCommandParser {
    version: string;
    constructor(args: string[], job: string);
    getDescription(): string;
}
