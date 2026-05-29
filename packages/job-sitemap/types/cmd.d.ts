import { JobCommandParser } from "@arachnodex/core";
export default class SitemapCmd extends JobCommandParser {
    constructor(args: string[], job: string);
    getDescription(): string;
}
