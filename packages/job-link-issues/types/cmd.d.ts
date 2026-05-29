import { JobCommandParser } from "@arachnodex/core";
export default class LinkIssuesCmd extends JobCommandParser {
    version: string;
    constructor(args: string[], job: string);
    getDescription(): string;
}
