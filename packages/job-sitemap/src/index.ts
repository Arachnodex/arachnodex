"use strict";

import type {PageData, Location, JSONObject, ReportData} from "@arachnodex/core";
import type {AxiosResponse} from "axios";
import type {FileHandle} from 'fs/promises';

import {BaseJob, ConfigService, eventBus, type JobCommandParser, type Profiler} from "@arachnodex/core";
import {open} from 'fs/promises'
import fse from 'fs-extra'
import {StreamWriter} from "./streamWriter.js";
export {default as CommandParser} from "./cmd.js";


interface SitemapConfig extends JSONObject {
    includeOnlyCanonical: boolean;
    includeDocs: boolean;
    emailReportEnabled: boolean;
    outputFile: string;
    includeDocPattern?: string;
}

export default class Sitemap extends BaseJob {

    // Job Meta Props
    name = "Sitemap Generator";

    // Temp files keep page URLs and document URLs separate until final XML assembly.
    configRequired = true;
    pageWriterFile = './sitemap-pages.tmp';
    docWriterFile = './sitemap-docs.tmp';

    // Writer objects for the two files listed above.
    pageWriter?: StreamWriter;
    docWriter?: StreamWriter;

    // Local storage for config values
    outputFile: string = '';
    includeDocs = false;
    includeDocPattern: RegExp = /$^/;
    includeOnlyCanonical = true;
    pageUrlCount = 0;
    docUrlCount = 0;

    // Keep track of URLS so that no duplicated URL is added.
    loggedUrls: string[] = [];

    constructor(handle: string, command: JobCommandParser, profiler: Profiler) {
        super(handle, command, profiler);
    }

    loadConfig() {
        // The sitemap job can be run with no custom config, but real projects normally
        // tune outputFile or includeDocs in config/sitemap.json.
        const defaultConfig: SitemapConfig = {
            includeOnlyCanonical: true,
            includeDocs: true,
            emailReportEnabled: true,
            outputFile: '../web/sitemap.xml',
            includeDocPattern: '((x-)?pdf)|(ms-?excel)|(vnd.)|(ms-?word)|(ms-?powerpoint)|(ms-?access)|(download)'
        }
        const config = ConfigService.getJobConfig(defaultConfig, this.command, true);
        this.includeOnlyCanonical = config.includeOnlyCanonical;
        this.includeDocs = config.includeDocs;
        this.emailReportEnabled = config.emailReportEnabled;
        this.outputFile = config.outputFile;
        this.includeDocPattern = new RegExp(config.includeDocPattern ?? '', 'gi');
    }

    onInit() {

        // todo settings for update frequency and priority + rule sets for both.
        // Start every run with clean temp files so a failed previous crawl cannot leak
        // stale URLs into the next sitemap.
        if (fse.pathExistsSync(this.pageWriterFile)) {
            this.removeFile(this.pageWriterFile);
        }
        if (fse.pathExistsSync(this.docWriterFile)) {
            this.removeFile(this.docWriterFile);
        }

        // Create writer for page URLs
        this.pageWriter = new StreamWriter(this.pageWriterFile);

        // Create writer for document URLs
        if(this.includeDocs) {
            this.docWriter = new StreamWriter(this.docWriterFile);
        }

    }

    getLastModifiedHeader(r: AxiosResponse): string
    {
        const lmHeader:unknown = r.headers['last-modified'] ?? '';
        return String(lmHeader);
    }

    onHeadersReceived(_response: AxiosResponse, _location: Location) {

        // Non-HTML files are not usually downloaded, so add matching documents here if the
        // mime type matches our includeDocPattern and includeDocs is enabled in the settings.
        // The loggedUrls check prevents duplicate entries if another path sees the same URL.

        // Guard clause - Only process success status codes if include docs is enabled.
        if(!this.includeDocs || _response.status < 200 || _response.status >= 300) return;

        let contentTypes:unknown = _response.headers['content-type'] ?? '';
        contentTypes = Array.isArray(contentTypes) ? contentTypes.join(' ') : String(contentTypes);
        if(String(contentTypes).match(this.includeDocPattern)) {
            this.addLocation(_location, this.getLastModifiedHeader(_response), true);
        }
    }



    onPageReceived(_response: AxiosResponse, _pageData: PageData) {

        // Content Type Guard Clause
        if (!_pageData.contentType.match(/text\/html/)) return;

        // When canonical-only mode is enabled, skip alternate URLs that point at a different
        // canonical target. This keeps the sitemap aligned with the site's preferred URLs.
        if(this.includeOnlyCanonical) {

            // Only add location if canonical is not set
            // or if its set exactly to the current location URL
            if (typeof _pageData.canonical === 'undefined'
                || _pageData.canonical.url === _pageData.location.url)  {

                // Canonical check passed
                this.addLocation(_pageData.location, this.getLastModifiedHeader(_response));
            }

        } else {

            // Canonical check disabled so
            // implicitly attempt to log page
            this.addLocation(_pageData.location, this.getLastModifiedHeader(_response));

        }


    }

    addLocation(location: Location, lastModifiedHeader: string, nonPageDocument = false) {

        // Guard clause - do not process if already processed
        if(this.loggedUrls.indexOf(location.url) !== -1) { return; }

        // log url so it's not written again
        this.loggedUrls.push(location.url);

        const lmDate = lastModifiedHeader !== '' ? new Date(lastModifiedHeader) : new Date();

        // Escape XML-sensitive characters in the URL before writing the sitemap entry.
        const cleanedUrl = location.url.replace(/&/g, '&amp;');

        const entry = '\n\t' + '<url><loc>' + cleanedUrl + '</loc><lastmod>' + lmDate.toISOString() + '</lastmod></url>';

        // Add the location entry to the write buffer
        if(nonPageDocument) {
            this.docUrlCount++;
            this.docWriter?.write(entry);
        } else {
            this.pageUrlCount++;
            this.pageWriter?.write(entry);
        }
    }

    getReportMessage(): string {
        return `Sitemap generation completed for ${this.pageUrlCount + this.docUrlCount} URL entries.`;
    }

    getReportData(): ReportData {
        return {
            'Output File': this.outputFile,
            'Page URLs': this.pageUrlCount,
            'Document URLs': this.docUrlCount,
            'Include Documents': this.includeDocs,
            'Include Only Canonical': this.includeOnlyCanonical
        };
    }



    async onEnd() {

        // Flush temp writers before merging so all buffered URLs are present on disk.
        await this.pageWriter?.terminate();
        await this.docWriter?.terminate();

        // Remove existing sitemap file if it exists
        if (fse.pathExistsSync(this.outputFile)) {
            this.removeFile(this.outputFile);
        }

        // Merge temp files and wrap with the XML sitemap envelope.
        try {

            const writer = await open(this.outputFile, 'w');

            try {
                await writer.writeFile('<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
                    'xsi:schemaLocation="http://www.google.com/schemas/sitemap/0.84 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">');

                // Pipe in data from page locations first
                await this.pipeData(writer, this.pageWriterFile);

                // Pipe in data from doc file locations last
                if (this.includeDocs) {
                    await this.pipeData(writer, this.docWriterFile);
                }

                // Complete write of sitemap file
                await writer.writeFile('\n</urlset>');
            } finally {
                await writer.close();
            }

            // remove temp files
            if (fse.pathExistsSync(this.pageWriterFile)) {
                this.removeFile(this.pageWriterFile);
            }
            if (fse.pathExistsSync(this.docWriterFile)) {
                this.removeFile(this.docWriterFile);
            }

        } catch(e) {
            this.emitFatal(
                e instanceof Error ? e : new Error(),
                `[sitemap] Error occurred during final merge and write operation.`
            );
            return;
        }

        // Signal job is complete
        this.completed = true;
    }

    async pipeData(writer: FileHandle, readFile: string) {
        // Stream temp data into the final sitemap without loading large crawl output into memory.
        let bytesRead = -1;
        let buffer: ArrayBufferView;
        const reader = await open(readFile, 'r');
        try {
            while (bytesRead !== 0) {
                ({bytesRead, buffer} = await reader.read());
                if (bytesRead > 0) {
                    const data = Buffer.from(buffer.buffer).toString('utf8', 0, bytesRead);
                    await writer.write(data);
                }
            }
        } finally {
            await reader.close();
        }
    }

    removeFile(filePath: string) {
        try {
            fse.unlinkSync(filePath);
        } catch(e) {
            this.emitFatal(e instanceof Error ? e : null, `[sitemap] Unable to unlink file '${filePath}'!`);
        }
    }

    // Error helper
    emitFatal(e?:Error|null, message?: string, location?: Location) {
        e = e ?? null;
        eventBus.emit(
            'error',
            e,
            message ?? e?.message ?? 'Unknown Error',
            location,
            false,
            true);
    }
}
