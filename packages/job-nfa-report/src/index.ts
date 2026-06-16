"use strict";

import axios, {type AxiosRequestConfig} from "axios";
import * as http from "http";
import * as https from "https";
import type {JSONObject, LinkZone, PageData, ReportData} from "@arachnodex/core";
import {
    BaseJob,
    defaultRequestHeaders,
    OutputHelper,
    type ArachnodexRuntime,
    type JobCommandParser,
    type Profiler
} from "@arachnodex/core";
export {default as CommandParser} from "./cmd.js";

const nestedBodyMaxBytes = 1024 * 1024;
const nestedRequestTimeoutMs = 10000;
const reportIndent = "  ";

type AssetGroup = "asset"|"media"|"document";

type AssetKind =
    "script"
    | "stylesheet"
    | "image"
    | "srcset"
    | "icon"
    | "manifest"
    | "preload"
    | "media"
    | "track"
    | "poster"
    | "iframe"
    | "embed"
    | "object"
    | "meta"
    | "svg"
    | "inline-style"
    | "style-tag"
    | "link"
    | "css-url"
    | "css-import"
    | "css-source-map"
    | "js-url"
    | "js-source-map";

type AssetReferenceContext = {
    sourceUrl: string;
    baseUrl: string;
    sourceLabel: string;
    kind: AssetKind;
    htmlSnippet?: string;
    zone: LinkZone;
}

type FindingEntry = {
    targetUrl: string;
    extension: string;
    group: AssetGroup;
    kinds: Set<AssetKind>;
    rawUrls: Set<string>;
    sourceUrls: Set<string>;
    sourceLabels: Set<string>;
    snippets: Set<string>;
    count: number;
}

type QsPropPatterns = Record<string, string>;

interface NfaReportConfig extends JSONObject {
    emailReportEnabled: boolean;
    limitMail: boolean;
    verbose: boolean;
    nested: boolean;
    viteRollupFingerprintCompatibility: boolean;
    fingerprintPattern: string;
    fingerprintSeparatorPattern: string;
    ignorePatterns: string[];
    qsProps: QsPropPatterns;
    assetExtensions: string[];
    mediaExtensions: string[];
    documentExtensions: string[];
}

const defaultConfig: NfaReportConfig = {
    emailReportEnabled: true,
    limitMail: true,
    verbose: false,
    nested: false,
    viteRollupFingerprintCompatibility: true,
    fingerprintPattern: "[A-Za-z0-9]{8,}",
    fingerprintSeparatorPattern: "\\.",
    ignorePatterns: [],
    qsProps: {
        cb: "^\\d{10,}$",
        t: "^\\d{10,}$",
        ts: "^\\d{10,}$",
        v: "^(?:\\d{8,}|[A-Za-z0-9._-]{8,})$",
        ver: "^(?:\\d{8,}|[A-Za-z0-9._-]{8,})$",
        version: "^(?:\\d{8,}|[A-Za-z0-9._-]{8,})$"
    },
    assetExtensions: [
        "css",
        "js",
        "mjs",
        "woff",
        "woff2",
        "ttf",
        "otf",
        "eot",
        "ico",
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "avif",
        "svg",
        "webmanifest",
        "map"
    ],
    mediaExtensions: ["mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "vtt"],
    documentExtensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "zip"]
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function stringArray(value: unknown, fallback: string[]): string[] {
    if(!Array.isArray(value)) {
        return fallback;
    }

    const values: string[] = [];
    value.forEach(item => {
        if(typeof item === "string" && item !== "") {
            values.push(item);
        }
    });
    return values.length > 0 ? values : fallback;
}

function qsPropPatterns(value: unknown, fallback: QsPropPatterns): QsPropPatterns {
    if(!isRecord(value)) {
        return fallback;
    }

    const patterns: QsPropPatterns = {};
    Object.keys(value).forEach(key => {
        const pattern = value[key];
        if(typeof pattern === "string" && key !== "" && pattern !== "") {
            patterns[key] = pattern;
        }
    });

    return Object.keys(patterns).length > 0 ? patterns : fallback;
}

export default class NfaReport extends BaseJob {

    name = "Non-Fingerprinted Assets Report";
    configRequired = false;

    private readonly console: OutputHelper;
    private readonly findings = new Map<string, FindingEntry>();
    private readonly nestedQueue = new Set<string>();
    private readonly scannedNestedUrls = new Set<string>();
    private readonly failedNestedUrls = new Set<string>();

    private limitMail = true;
    private verbose = false;
    private nested = false;
    private viteRollupFingerprintCompatibility = true;
    private promptOutput = false;
    private scannedPageCount = 0;
    private scannedNestedCount = 0;
    private fingerprintPattern = new RegExp(`^(?:${defaultConfig.fingerprintPattern})$`);
    private fingerprintSeparatorPattern = /\./g;
    private ignorePatterns: RegExp[] = [];
    private qsProps: Record<string, RegExp> = {};
    private assetExtensions = new Set<string>();
    private mediaExtensions = new Set<string>();
    private documentExtensions = new Set<string>();
    private baseUrl = "";
    private baseHostname = "";

    constructor(handle: string, command: JobCommandParser, profiler: Profiler, runtime: ArachnodexRuntime) {
        super(handle, command, profiler, runtime);
        this.console = new OutputHelper(true, true, this.runtime.config);
        this.promptOutput = command.arguments["-p"]?.active === true
            || command.arguments["--prompt"]?.active === true;
    }

    loadConfig(): void {
        const config = this.config.getJobConfig(defaultConfig, this.command, false, value => {
            value.fingerprintPattern = typeof value.fingerprintPattern === "string" && value.fingerprintPattern !== ""
                ? value.fingerprintPattern
                : defaultConfig.fingerprintPattern;
            value.fingerprintSeparatorPattern = typeof value.fingerprintSeparatorPattern === "string"
                && value.fingerprintSeparatorPattern !== ""
                ? value.fingerprintSeparatorPattern
                : defaultConfig.fingerprintSeparatorPattern;
            value.viteRollupFingerprintCompatibility = typeof value.viteRollupFingerprintCompatibility === "boolean"
                ? value.viteRollupFingerprintCompatibility
                : defaultConfig.viteRollupFingerprintCompatibility;
            value.ignorePatterns = stringArray(value.ignorePatterns, defaultConfig.ignorePatterns);
            value.assetExtensions = stringArray(value.assetExtensions, defaultConfig.assetExtensions);
            value.mediaExtensions = stringArray(value.mediaExtensions, defaultConfig.mediaExtensions);
            value.documentExtensions = stringArray(value.documentExtensions, defaultConfig.documentExtensions);
            value.qsProps = qsPropPatterns(value.qsProps, defaultConfig.qsProps);
        });

        this.emailReportEnabled = config.emailReportEnabled;
        this.limitMail = config.limitMail;
        this.verbose = config.verbose;
        this.nested = config.nested;
        this.viteRollupFingerprintCompatibility = config.viteRollupFingerprintCompatibility;
        this.baseUrl = this.config.getConfigString("baseUrl").replace(/\/+$/, "");
        this.baseHostname = this.normalizeHostname(new URL(this.baseUrl).hostname);
        this.fingerprintPattern = this.compileFingerprintPattern(config.fingerprintPattern);
        this.fingerprintSeparatorPattern = this.compileFingerprintSeparatorPattern(config.fingerprintSeparatorPattern);
        this.ignorePatterns = this.compilePatterns(config.ignorePatterns);
        this.qsProps = this.compileQsProps(config.qsProps);
        this.assetExtensions = this.normalizeExtensions(config.assetExtensions);
        this.mediaExtensions = this.normalizeExtensions(config.mediaExtensions);
        this.documentExtensions = this.normalizeExtensions(config.documentExtensions);
    }

    onPageReceived(_response: unknown, pageData: PageData): void {
        if(typeof pageData.jsdom === "undefined") {
            return;
        }

        this.scannedPageCount++;
        const doc = pageData.jsdom;
        const pageUrl = pageData.location.url;

        this.collectElementAttr(doc, "script[src]", "src", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "script src",
            kind: "script",
            zone: "unknown"
        });
        this.collectLinkElements(doc, pageUrl);
        this.collectElementAttr(doc, "img[src]", "src", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "img src",
            kind: "image",
            zone: "unknown"
        });
        this.collectSrcset(doc, "img[srcset]", "srcset", pageUrl, "img srcset");
        this.collectSrcset(doc, "source[srcset]", "srcset", pageUrl, "source srcset");
        this.collectElementAttr(doc, "source[src]", "src", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "source src",
            kind: "media",
            zone: "unknown"
        });
        this.collectElementAttr(doc, "video[src], audio[src]", "src", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "media src",
            kind: "media",
            zone: "unknown"
        });
        this.collectElementAttr(doc, "video[poster]", "poster", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "video poster",
            kind: "poster",
            zone: "unknown"
        });
        this.collectElementAttr(doc, "track[src]", "src", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "track src",
            kind: "track",
            zone: "unknown"
        });
        this.collectElementAttr(doc, "iframe[src]", "src", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "iframe src",
            kind: "iframe",
            zone: "unknown"
        });
        this.collectElementAttr(doc, "embed[src]", "src", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "embed src",
            kind: "embed",
            zone: "unknown"
        });
        this.collectElementAttr(doc, "object[data]", "data", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "object data",
            kind: "object",
            zone: "unknown"
        });
        this.collectElementAttr(doc, "image[href], image[xlink\\:href], use[href], use[xlink\\:href]", "href", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "svg href",
            kind: "svg",
            zone: "unknown"
        });
        this.collectElementAttr(doc, "image[xlink\\:href], use[xlink\\:href]", "xlink:href", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "svg xlink:href",
            kind: "svg",
            zone: "unknown"
        });
        this.collectMetaAssets(doc, pageUrl);
        this.collectAnchorAssets(doc, pageUrl);
        this.collectInlineStyles(doc, pageUrl);
        this.collectStyleTags(doc, pageUrl);
    }

    async onEnd(): Promise<void> {
        if(this.nested) {
            await this.scanNestedAssets();
        }

        if(this.promptOutput) {
            this.reportPromptFindings();
        } else {
            this.reportFindings();
        }
    }

    getReportTitle(): string {
        return "Non-Fingerprinted Assets Report";
    }

    getReportMessage(): string {
        const count = this.findings.size;
        if(count === 0) {
            return "No non-fingerprinted asset references were detected.";
        }

        const label = count === 1 ? "reference" : "references";
        return `${count} non-fingerprinted asset ${label} detected.`;
    }

    getReportData(): ReportData {
        return {
            "Scanned Pages": this.scannedPageCount,
            "Nested Assets Scanned": this.scannedNestedCount,
            "Findings": this.findings.size,
            "Occurrences": this.getOccurrenceCount(),
            "Nested Enabled": this.nested,
            "Limit Mail": this.limitMail
        };
    }

    getReportHtml(): string {
        const entries = this.getSortedFindings();
        if(entries.length === 0) {
            return "<p style=\"margin:0;color:#207a3c;font-family:Helvetica,Arial,sans-serif;\">No non-fingerprinted asset references were detected.</p>";
        }

        const groups: AssetGroup[] = ["asset", "media", "document"];
        return groups.map(group => {
            const groupEntries = entries.filter(entry => entry.group === group);
            if(groupEntries.length === 0) {
                return "";
            }

            return `
                <div style="margin-top:18px;">
                    <h3 style="margin:0 0 10px;font-size:16px;line-height:22px;color:#323232;font-family:Helvetica,Arial,sans-serif;">${this.escapeHtml(this.groupLabel(group))}</h3>
                    ${groupEntries.map(entry => this.renderEmailEntry(entry)).join("\n")}
                </div>
            `;
        }).join("\n");
    }

    shouldSendEmailReport(): boolean {
        return this.emailReportEnabled && (!this.limitMail || this.findings.size > 0);
    }

    private collectLinkElements(doc: Document, pageUrl: string): void {
        doc.querySelectorAll("link[href]").forEach(element => {
            const rel = String(element.getAttribute("rel") ?? "").toLowerCase();
            let kind: AssetKind = "link";
            let sourceLabel = "link href";
            if(rel.includes("stylesheet")) {
                kind = "stylesheet";
                sourceLabel = "link rel=stylesheet";
            } else if(rel.includes("icon")) {
                kind = "icon";
                sourceLabel = "link rel=icon";
            } else if(rel.includes("manifest")) {
                kind = "manifest";
                sourceLabel = "link rel=manifest";
            } else if(rel.includes("preload") || rel.includes("modulepreload")) {
                kind = "preload";
                sourceLabel = `link rel=${rel}`;
            }

            this.addElementReference(element, "href", {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel,
                kind,
                zone: this.classifyZone(element)
            });
        });
    }

    private collectElementAttr(doc: Document, selector: string, attr: string, context: AssetReferenceContext): void {
        doc.querySelectorAll(selector).forEach(element => {
            this.addElementReference(element, attr, {
                ...context,
                zone: this.classifyZone(element)
            });
        });
    }

    private collectSrcset(
        doc: Document,
        selector: string,
        attr: string,
        pageUrl: string,
        sourceLabel: string
    ): void {
        doc.querySelectorAll(selector).forEach(element => {
            const value = element.getAttribute(attr);
            if(value === null || value.trim() === "") {
                return;
            }

            this.parseSrcset(value).forEach(rawUrl => {
                this.addReference(rawUrl, {
                    sourceUrl: pageUrl,
                    baseUrl: pageUrl,
                    sourceLabel,
                    kind: "srcset",
                    htmlSnippet: this.getElementSnippet(element),
                    zone: this.classifyZone(element)
                });
            });
        });
    }

    private collectMetaAssets(doc: Document, pageUrl: string): void {
        doc.querySelectorAll("meta[content]").forEach(element => {
            const name = String(element.getAttribute("property") ?? element.getAttribute("name") ?? "").toLowerCase();
            if(!this.isAssetMetaName(name)) {
                return;
            }

            this.addElementReference(element, "content", {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel: `meta ${name}`,
                kind: "meta",
                zone: "unknown"
            });
        });
    }

    private collectAnchorAssets(doc: Document, pageUrl: string): void {
        doc.querySelectorAll("a[href]").forEach(element => {
            this.addElementReference(element, "href", {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel: "anchor href",
                kind: "link",
                zone: this.classifyZone(element)
            });
        });
    }

    private collectInlineStyles(doc: Document, pageUrl: string): void {
        doc.querySelectorAll("[style]").forEach(element => {
            const style = element.getAttribute("style");
            if(style === null || style.trim() === "") {
                return;
            }

            this.collectCssReferences(style, {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel: "inline style",
                kind: "inline-style",
                htmlSnippet: this.getElementSnippet(element),
                zone: this.classifyZone(element)
            });
        });
    }

    private collectStyleTags(doc: Document, pageUrl: string): void {
        doc.querySelectorAll("style").forEach(element => {
            const css = element.textContent ?? "";
            if(css.trim() === "") {
                return;
            }

            this.collectCssReferences(css, {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel: "style tag",
                kind: "style-tag",
                htmlSnippet: this.getTextSnippet(css, 0),
                zone: this.classifyZone(element)
            });
        });
    }

    private addElementReference(element: Element, attr: string, context: AssetReferenceContext): void {
        const rawUrl = element.getAttribute(attr);
        if(rawUrl === null || rawUrl.trim() === "") {
            return;
        }

        this.addReference(rawUrl, {
            ...context,
            htmlSnippet: this.getElementSnippet(element)
        });
    }

    private addReference(rawUrlInput: string, context: AssetReferenceContext): void {
        const rawUrl = rawUrlInput.trim();
        if(rawUrl === "" || !this.isWebReference(rawUrl)) {
            return;
        }

        let parsed: URL;
        try {
            parsed = new URL(rawUrl, context.baseUrl);
        } catch {
            return;
        }

        if(parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return;
        }

        if(!this.isSameSite(parsed)) {
            return;
        }

        const extension = this.getExtension(parsed);
        if(extension === null) {
            return;
        }

        const group = this.getAssetGroup(extension);
        if(group === null) {
            return;
        }

        const targetUrl = parsed.href;
        if(this.matchesIgnorePattern(rawUrl, parsed)) {
            return;
        }

        if(this.isFingerprinted(parsed)) {
            this.queueNestedScanIfNeeded(parsed);
            return;
        }

        const key = targetUrl;
        let entry = this.findings.get(key);
        const isNew = typeof entry === "undefined";
        if(isNew) {
            entry = {
                targetUrl,
                extension,
                group,
                kinds: new Set<AssetKind>(),
                rawUrls: new Set<string>(),
                sourceUrls: new Set<string>(),
                sourceLabels: new Set<string>(),
                snippets: new Set<string>(),
                count: 0
            };
            this.findings.set(key, entry);
        }
        if(typeof entry === "undefined") {
            return;
        }

        entry.kinds.add(context.kind);
        entry.rawUrls.add(rawUrl);
        entry.sourceUrls.add(context.sourceUrl);
        entry.sourceLabels.add(context.sourceLabel);
        if(typeof context.htmlSnippet === "string" && context.htmlSnippet !== "") {
            entry.snippets.add(context.htmlSnippet);
        }
        entry.count++;

        this.queueNestedScanIfNeeded(parsed);
        if(this.verbose && isNew) {
            this.console.log(`[nfa-report] ${this.groupLabel(group)} missing fingerprint: ${targetUrl}`, "yellow");
            this.console.log(`${reportIndent}Source: ${context.sourceUrl}`, "gray");
        }
    }

    private queueNestedScanIfNeeded(parsed: URL): void {
        if(!this.nested || !this.isSameSite(parsed) || !this.isNestedScannable(parsed)) {
            return;
        }

        this.nestedQueue.add(parsed.href);
    }

    private async scanNestedAssets(): Promise<void> {
        while(this.nestedQueue.size > 0 && !this.runtime.aborted) {
            const url = this.getNextNestedUrl();
            if(url === null) {
                return;
            }

            await this.scanNestedAsset(url);
        }
    }

    private getNextNestedUrl(): string|null {
        for(const url of this.nestedQueue) {
            this.nestedQueue.delete(url);
            if(!this.scannedNestedUrls.has(url)) {
                return url;
            }
        }

        return null;
    }

    private async scanNestedAsset(url: string): Promise<void> {
        this.scannedNestedUrls.add(url);
        let body = "";
        try {
            const response = await axios.get<string>(url, this.getNestedRequestConfig());
            body = typeof response.data === "string" ? response.data : "";
        } catch {
            this.failedNestedUrls.add(url);
            return;
        }

        if(body === "") {
            return;
        }

        this.scannedNestedCount++;
        const parsed = new URL(url);
        const extension = this.getExtension(parsed);
        if(extension === "css") {
            this.collectCssReferences(body, {
                sourceUrl: url,
                baseUrl: url,
                sourceLabel: `CSS body ${url}`,
                kind: "css-url",
                htmlSnippet: this.getTextSnippet(body, 0),
                zone: "unknown"
            });
            return;
        }

        if(extension === "js" || extension === "mjs") {
            this.collectJsReferences(body, {
                sourceUrl: url,
                baseUrl: url,
                sourceLabel: `JS body ${url}`,
                kind: "js-url",
                htmlSnippet: this.getTextSnippet(body, 0),
                zone: "unknown"
            });
        }
    }

    private getNestedRequestConfig(): AxiosRequestConfig {
        return {
            responseType: "text",
            transformResponse: [(data: unknown) => data],
            timeout: nestedRequestTimeoutMs,
            maxContentLength: nestedBodyMaxBytes,
            maxBodyLength: nestedBodyMaxBytes,
            headers: {
                ...defaultRequestHeaders,
                accept: "text/css,application/javascript,text/javascript,*/*;q=0.8"
            },
            httpAgent: new http.Agent({
                timeout: nestedRequestTimeoutMs
            }),
            httpsAgent: new https.Agent({
                timeout: nestedRequestTimeoutMs,
                requestCert: false,
                rejectUnauthorized: this.config.getConfigBoolean("requestTls.rejectUnauthorized", null, true)
            }),
            signal: this.runtime.abortSignal
        };
    }

    private collectCssReferences(css: string, context: AssetReferenceContext): void {
        const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi;
        let match: RegExpExecArray|null;
        while((match = urlPattern.exec(css)) !== null) {
            const rawUrl = match[1] ?? match[2] ?? match[3] ?? "";
            this.addReference(rawUrl, {
                ...context,
                kind: "css-url",
                sourceLabel: `${context.sourceLabel} url()`,
                htmlSnippet: this.getTextSnippet(css, match.index)
            });
        }

        const importPattern = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))/gi;
        while((match = importPattern.exec(css)) !== null) {
            const rawUrl = match[1] ?? match[2] ?? match[3] ?? "";
            this.addReference(rawUrl, {
                ...context,
                kind: "css-import",
                sourceLabel: `${context.sourceLabel} @import`,
                htmlSnippet: this.getTextSnippet(css, match.index)
            });
        }

        this.collectSourceMapReferences(css, context, "css-source-map");
    }

    private collectJsReferences(js: string, context: AssetReferenceContext): void {
        const assetStringPattern = /(['"`])([^'"`]{1,2048}\.(?:png|jpe?g|gif|webp|avif|svg|css|woff2?|ttf|otf|eot|ico|webmanifest|map|mp4|webm|mov|m4v|mp3|wav|ogg|vtt|pdf|docx?|xlsx?|pptx?|csv|zip)(?:[?#][^'"`]*)?)\1/gi;
        let match: RegExpExecArray|null;
        while((match = assetStringPattern.exec(js)) !== null) {
            const rawUrl = match[2] ?? "";
            if(!this.isConservativeJsAssetReference(rawUrl)
                || !this.isStandaloneJsStringLiteral(js, match.index, match[0].length)) {
                continue;
            }

            this.addReference(rawUrl, {
                ...context,
                kind: "js-url",
                sourceLabel: `${context.sourceLabel} string literal`,
                htmlSnippet: this.getTextSnippet(js, match.index)
            });
        }

        this.collectSourceMapReferences(js, context, "js-source-map");
    }

    private collectSourceMapReferences(
        body: string,
        context: AssetReferenceContext,
        kind: "css-source-map"|"js-source-map"
    ): void {
        const sourceMapPattern = /[#@]\s*sourceMappingURL=([^\s*]+)/gi;
        let match: RegExpExecArray|null;
        while((match = sourceMapPattern.exec(body)) !== null) {
            this.addReference(match[1] ?? "", {
                ...context,
                kind,
                sourceLabel: `${context.sourceLabel} sourceMappingURL`,
                htmlSnippet: this.getTextSnippet(body, match.index)
            });
        }
    }

    private isConservativeJsAssetReference(rawUrl: string): boolean {
        if(rawUrl.includes("${")) {
            return false;
        }
        if(/^(https?:)?\/\//i.test(rawUrl) || rawUrl.startsWith("/")) {
            return true;
        }
        if(rawUrl.startsWith("./") || rawUrl.startsWith("../")) {
            return !this.isRelativeJsModuleSpecifier(rawUrl);
        }

        return false;
    }

    private isStandaloneJsStringLiteral(js: string, startIndex: number, length: number): boolean {
        const before = js.slice(0, startIndex).match(/\S\s*$/)?.[0].trim() ?? "";
        const after = js.slice(startIndex + length).match(/^\s*\S/)?.[0].trim() ?? "";
        return before !== "+" && after !== "+";
    }

    private isRelativeJsModuleSpecifier(rawUrl: string): boolean {
        try {
            const path = new URL(rawUrl, "https://example.invalid/").pathname.toLowerCase();
            return path.endsWith(".js") || path.endsWith(".mjs");
        } catch {
            return false;
        }
    }

    private isFingerprinted(parsed: URL): boolean {
        if(this.hasAcceptedQueryFingerprint(parsed)) {
            return true;
        }

        const filename = this.getFilename(parsed);
        const dotPosition = filename.lastIndexOf(".");
        if(dotPosition <= 0) {
            return false;
        }

        const stem = this.safeDecode(filename.substring(0, dotPosition));
        const hashSegment = this.getFingerprintHashSegment(stem);
        if(hashSegment === null) {
            return this.hasDefaultBundlerFingerprint(stem);
        }

        this.fingerprintPattern.lastIndex = 0;
        return this.fingerprintPattern.test(hashSegment) || this.hasDefaultBundlerFingerprint(stem);
    }

    private getFingerprintHashSegment(stem: string): string|null {
        this.fingerprintSeparatorPattern.lastIndex = 0;
        let separatorStart = -1;
        let separatorEnd = -1;
        let match: RegExpExecArray|null;
        while((match = this.fingerprintSeparatorPattern.exec(stem)) !== null) {
            const separator = match[0];
            if(separator === "") {
                this.fingerprintSeparatorPattern.lastIndex++;
                continue;
            }

            separatorStart = match.index;
            separatorEnd = match.index + separator.length;
        }

        if(separatorStart <= 0 || separatorEnd >= stem.length) {
            return null;
        }

        return stem.substring(separatorEnd);
    }

    private hasDefaultBundlerFingerprint(stem: string): boolean {
        if(!this.viteRollupFingerprintCompatibility) {
            return false;
        }

        const viteRollupHashPattern = /^[A-Za-z0-9_-]{8}$/;
        for(let index = stem.indexOf("-"); index !== -1; index = stem.indexOf("-", index + 1)) {
            if(index <= 0 || index >= stem.length - 1) {
                continue;
            }

            const hashSegment = stem.substring(index + 1);
            if(viteRollupHashPattern.test(hashSegment) && this.isHashLikeSegment(hashSegment)) {
                return true;
            }
        }

        return false;
    }

    private isHashLikeSegment(hashSegment: string): boolean {
        if(/[0-9_-]/.test(hashSegment)) {
            return true;
        }

        const uppercaseCount = hashSegment.replace(/[^A-Z]/g, "").length;
        return uppercaseCount >= 2;
    }

    private hasAcceptedQueryFingerprint(parsed: URL): boolean {
        for(const prop of Object.keys(this.qsProps)) {
            const value = parsed.searchParams.get(prop);
            if(value === null) {
                continue;
            }

            const pattern = this.qsProps[prop];
            pattern.lastIndex = 0;
            if(pattern.test(value)) {
                return true;
            }
        }

        return false;
    }

    private matchesIgnorePattern(rawUrl: string, parsed: URL): boolean {
        if(this.ignorePatterns.length === 0) {
            return false;
        }

        const candidates = new Set<string>([
            rawUrl,
            parsed.href,
            `${parsed.pathname}${parsed.search}`,
            parsed.pathname,
            this.safeDecode(`${parsed.pathname}${parsed.search}`),
            this.safeDecode(parsed.pathname)
        ]);

        return this.ignorePatterns.some(pattern => {
            for(const candidate of candidates) {
                pattern.lastIndex = 0;
                if(pattern.test(candidate)) {
                    return true;
                }
            }

            return false;
        });
    }

    private getAssetGroup(extension: string): AssetGroup|null {
        if(this.assetExtensions.has(extension)) {
            return "asset";
        }
        if(this.mediaExtensions.has(extension)) {
            return "media";
        }
        if(this.documentExtensions.has(extension)) {
            return "document";
        }

        return null;
    }

    private getExtension(parsed: URL): string|null {
        const filename = this.getFilename(parsed);
        const dotPosition = filename.lastIndexOf(".");
        if(dotPosition === -1 || dotPosition === filename.length - 1) {
            return null;
        }

        return filename.substring(dotPosition + 1).toLowerCase();
    }

    private getFilename(parsed: URL): string {
        const pathname = parsed.pathname;
        const slashPosition = pathname.lastIndexOf("/");
        return slashPosition === -1 ? pathname : pathname.substring(slashPosition + 1);
    }

    private isNestedScannable(parsed: URL): boolean {
        const extension = this.getExtension(parsed);
        return extension === "css" || extension === "js" || extension === "mjs";
    }

    private isSameSite(parsed: URL): boolean {
        return this.normalizeHostname(parsed.hostname) === this.baseHostname;
    }

    private isWebReference(rawUrl: string): boolean {
        if(rawUrl.startsWith("#")) {
            return false;
        }

        return !/^(?:javascript|mailto|tel|ftp|file|data|blob):/i.test(rawUrl);
    }

    private parseSrcset(value: string): string[] {
        return value
            .split(",")
            .map(candidate => candidate.trim().split(/\s+/)[0] ?? "")
            .filter(candidate => candidate !== "");
    }

    private isAssetMetaName(name: string): boolean {
        return [
            "og:image",
            "og:image:url",
            "og:video",
            "og:video:url",
            "twitter:image",
            "twitter:image:src",
            "twitter:player",
            "msapplication-tileimage"
        ].includes(name);
    }

    private classifyZone(element: Element): LinkZone {
        if(element.closest("nav") !== null) {
            return "nav";
        }
        if(element.closest("header") !== null) {
            return "header";
        }
        if(element.closest("footer") !== null) {
            return "footer";
        }
        if(element.closest("aside") !== null) {
            return "aside";
        }
        if(element.closest("main") !== null) {
            return "main";
        }
        return "unknown";
    }

    private compileFingerprintPattern(pattern: string): RegExp {
        try {
            return new RegExp(`^(?:${pattern})$`);
        } catch {
            return new RegExp(`^(?:${defaultConfig.fingerprintPattern})$`);
        }
    }

    private compileFingerprintSeparatorPattern(pattern: string): RegExp {
        try {
            return new RegExp(pattern, "g");
        } catch {
            return new RegExp(defaultConfig.fingerprintSeparatorPattern, "g");
        }
    }

    private compilePatterns(patterns: string[]): RegExp[] {
        return patterns.flatMap(pattern => {
            try {
                return [new RegExp(pattern)];
            } catch {
                return [];
            }
        });
    }

    private compileQsProps(props: QsPropPatterns): Record<string, RegExp> {
        const compiled: Record<string, RegExp> = {};
        Object.keys(props).forEach(prop => {
            try {
                compiled[prop] = new RegExp(props[prop]);
            } catch {
                // Invalid query-string patterns are ignored.
            }
        });

        return compiled;
    }

    private normalizeExtensions(extensions: string[]): Set<string> {
        return new Set(extensions.map(extension => extension.replace(/^\./, "").toLowerCase()).filter(Boolean));
    }

    private normalizeHostname(hostname: string): string {
        return hostname.replace(/^www\./i, "").toLowerCase();
    }

    private safeDecode(value: string): string {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    private reportFindings(): void {
        const entries = this.getSortedFindings();
        this.console.log("NFA Report", "bold");
        this.console.log("----------", "bold");
        if(entries.length === 0) {
            this.console.log("NO NON-FINGERPRINTED ASSETS DETECTED!", "green");
            return;
        }

        const groups: AssetGroup[] = ["asset", "media", "document"];
        groups.forEach(group => {
            const groupEntries = entries.filter(entry => entry.group === group);
            if(groupEntries.length === 0) {
                return;
            }

            this.console.log("", "yellow");
            this.console.log(this.groupLabel(group), "yellow.bold");
            this.console.log("-".repeat(this.groupLabel(group).length), "yellow.bold");
            groupEntries.forEach(entry => {
                this.console.log(`${reportIndent}${entry.targetUrl}`, "yellow");
                this.console.log(`${reportIndent}${reportIndent}Occurrences: ${entry.count}`, "gray");
                this.console.log(`${reportIndent}${reportIndent}Kinds: ${Array.from(entry.kinds).sort().join(", ")}`, "gray");
                this.console.log(`${reportIndent}${reportIndent}Sources: ${Array.from(entry.sourceUrls).slice(0, 3).join(", ")}`, "gray");
            });
        });
    }

    private reportPromptFindings(): void {
        const entries = this.getSortedFindings();
        this.console.log("NFA Prompt Report", "bold");
        this.console.log("-----------------", "bold");
        if(entries.length === 0) {
            this.console.log("NO NON-FINGERPRINTED ASSETS DETECTED!", "green");
            return;
        }

        const groups: AssetGroup[] = ["asset", "media", "document"];
        groups.forEach(group => {
            const groupEntries = entries.filter(entry => entry.group === group);
            if(groupEntries.length === 0) {
                return;
            }

            const title = `PROMPT: ${this.groupLabel(group)}`;
            this.console.log("", "yellow");
            this.console.log(title, "yellow.bold");
            this.console.log("-".repeat(title.length), "yellow.bold");
            this.console.log(this.buildPromptText(group, groupEntries), "white");
        });
    }

    private buildPromptText(group: AssetGroup, entries: FindingEntry[]): string {
        const lines = [
            "You are working in the crawled site codebase.",
            `Task: add stable filename fingerprints or approved cache-bust query values for these ${this.groupLabel(group).toLowerCase()}.`,
            "Keep rendered behavior, asset loading order, responsive media behavior, and public URL compatibility intact.",
            "Prefer fixing the build/template/CMS source that emits the URL instead of editing generated output by hand.",
            "After the change, rerun the NFA report and confirm these exact URLs no longer appear.",
            "",
            `Findings (${entries.length} unique URL${entries.length === 1 ? "" : "s"}):`
        ];

        entries.forEach((entry, index) => {
            lines.push(`${index + 1}. ${entry.targetUrl}`);
            this.getPromptEntryDetails(entry).forEach(detail => {
                lines.push(`${reportIndent}- ${detail}`);
            });
        });

        return lines.join("\n");
    }

    private getPromptEntryDetails(entry: FindingEntry): string[] {
        const details = [
            `Extension: ${entry.extension}`,
            `Occurrences: ${entry.count}`,
            `Kinds: ${Array.from(entry.kinds).sort().join(", ")}`,
            `Source contexts: ${Array.from(entry.sourceLabels).sort().slice(0, 5).join(", ")}`,
            `Source pages: ${Array.from(entry.sourceUrls).sort().slice(0, 5).join(", ")}`
        ];
        const rawUrls = Array.from(entry.rawUrls).sort().slice(0, 5);
        if(rawUrls.length > 0) {
            details.push(`Raw references: ${rawUrls.join(", ")}`);
        }
        const snippets = Array.from(entry.snippets).slice(0, 2);
        snippets.forEach(snippet => {
            details.push(`Markup snippet: ${snippet}`);
        });

        return details;
    }

    private getSortedFindings(): FindingEntry[] {
        const groupOrder: Record<AssetGroup, number> = {
            asset: 0,
            media: 1,
            document: 2
        };
        return Array.from(this.findings.values()).sort((a, b) => {
            const groupSort = groupOrder[a.group] - groupOrder[b.group];
            if(groupSort !== 0) {
                return groupSort;
            }

            return a.targetUrl.localeCompare(b.targetUrl);
        });
    }

    private getOccurrenceCount(): number {
        return Array.from(this.findings.values()).reduce((total, entry) => total + entry.count, 0);
    }

    private groupLabel(group: AssetGroup): string {
        if(group === "media") {
            return "Media References";
        }
        if(group === "document") {
            return "Document References";
        }

        return "Asset References";
    }

    private renderEmailEntry(entry: FindingEntry): string {
        const sources = Array.from(entry.sourceUrls).sort().slice(0, 5);
        const rawUrls = Array.from(entry.rawUrls).sort().slice(0, 5);
        const snippets = Array.from(entry.snippets).slice(0, 2);
        return `
            <div style="margin:0 0 14px;padding:12px 14px;border:1px solid #e2e2e2;border-radius:6px;background:#fbfbfb;">
                <p style="margin:0 0 8px;font-size:13px;line-height:19px;color:#222;font-family:Helvetica,Arial,sans-serif;font-weight:bold;word-break:break-word;">${this.linkifyHtml(entry.targetUrl)}</p>
                <ul style="margin:0 0 8px 18px;padding:0;color:#555;font-size:12px;line-height:18px;font-family:Helvetica,Arial,sans-serif;">
                    <li>Extension: ${this.escapeHtml(entry.extension)}</li>
                    <li>Occurrences: ${entry.count}</li>
                    <li>Kinds: ${this.escapeHtml(Array.from(entry.kinds).sort().join(", "))}</li>
                    ${rawUrls.map(rawUrl => `<li>Raw: ${this.escapeHtml(rawUrl)}</li>`).join("")}
                    ${sources.map(source => `<li>Source: ${this.linkifyHtml(source)}</li>`).join("")}
                    ${snippets.map(snippet => `<li>Snippet: ${this.escapeHtml(snippet)}</li>`).join("")}
                </ul>
            </div>
        `;
    }

    private getElementSnippet(element: Element): string {
        return this.truncateText(element.outerHTML.trim(), 320);
    }

    private getTextSnippet(value: string, index: number): string {
        const start = Math.max(0, index - 80);
        const end = Math.min(value.length, index + 180);
        return this.truncateText(value.slice(start, end).replace(/\s+/g, " ").trim(), 320);
    }

    private truncateText(value: string, maxBytes: number): string {
        if(Buffer.byteLength(value, "utf8") <= maxBytes) {
            return value;
        }

        let bytes = 0;
        let output = "";
        for(const character of value) {
            const characterBytes = Buffer.byteLength(character, "utf8");
            if(bytes + characterBytes > maxBytes - 3) {
                return `${output}...`;
            }
            bytes += characterBytes;
            output += character;
        }

        return output;
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    private linkifyHtml(value: string): string {
        const urlPattern = /https?:\/\/[^\s<>"']+/gi;
        let html = "";
        let lastIndex = 0;

        value.replace(urlPattern, (match, offset: number) => {
            html += this.escapeHtml(value.slice(lastIndex, offset));
            const trailing = match.match(/[),.;:!?]+$/)?.[0] ?? "";
            const url = trailing !== "" ? match.slice(0, -trailing.length) : match;
            html += `<a href="${this.escapeHtml(url)}" style="color:#4d4d4d;text-decoration:underline !important;">${this.escapeHtml(url)}</a>`;
            html += this.escapeHtml(trailing);
            lastIndex = offset + match.length;
            return match;
        });

        html += this.escapeHtml(value.slice(lastIndex));
        return html;
    }

}
