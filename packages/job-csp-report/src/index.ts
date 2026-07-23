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
const nestedConcurrency = 4;
const nestedFailureSampleLimit = 20;
const nestedRequestTimeoutMs = 10000;
const reportIndent = "  ";
const cspTestingGuideUrl = "https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/CSP#report-only_csps";

type OutputFormat = "apache"|"nginx"|"lighttpd"|"raw";
type HeaderMode = "report-only"|"enforce";
type InlineKind = "script"|"style";

type SourceMapConfig = Record<string, string[]>;

interface CspReportConfig extends JSONObject {
    emailReportEnabled: boolean;
    outputFormat: OutputFormat;
    nested: boolean;
    unsafeInline: boolean;
    includeReportOnly: boolean;
    includeEnforce: boolean;
    reportUri: string;
    reportTo: string;
    ignorePatterns: string[];
    additionalSources: SourceMapConfig;
    ignoreSources: SourceMapConfig;
    staticDirectives: SourceMapConfig;
}

type SourceEntry = {
    directive: string;
    source: string;
    occurrenceCount: number;
    sourceUrls: Set<string>;
    riskReasons: Set<string>;
}

type InlineFindingSummary = {
    kind: InlineKind;
    sourceUrl: string;
    sourceLabel: string;
    count: number;
    snippets: Set<string>;
}

type NestedFailure = {
    url: string;
    message: string;
}

type ReferenceContext = {
    sourceUrl: string;
    baseUrl: string;
    sourceLabel: string;
    directive: string;
    htmlSnippet?: string;
    zone: LinkZone;
    riskReasons?: string[];
}

type HeaderDirective = {
    name: string;
    value: string;
    mode: HeaderMode;
}

type WarningSeverity = "alert"|"warning"|"notice";

type WarningGroup = {
    key: string;
    title: string;
    severity: WarningSeverity;
    summary: string;
    meaning: string;
    recommendations: string[];
    items: string[];
    totalItems: number;
}

const outputFormats = new Set<OutputFormat>(["apache", "nginx", "lighttpd", "raw"]);
const javaScriptMimeTypes = new Set([
    "application/ecmascript",
    "application/javascript",
    "application/x-ecmascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/javascript",
    "text/javascript1.0",
    "text/javascript1.1",
    "text/javascript1.2",
    "text/javascript1.3",
    "text/javascript1.4",
    "text/javascript1.5",
    "text/jscript",
    "text/livescript",
    "text/x-ecmascript",
    "text/x-javascript"
]);
const cspControlledScriptTypes = new Set(["module", "importmap", "speculationrules"]);

const defaultConfig: CspReportConfig = {
    emailReportEnabled: true,
    outputFormat: "apache",
    nested: true,
    unsafeInline: false,
    includeReportOnly: true,
    includeEnforce: true,
    reportUri: "",
    reportTo: "",
    ignorePatterns: [],
    additionalSources: {},
    ignoreSources: {},
    staticDirectives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'self'"]
    }
};

const directiveOrder = [
    "default-src",
    "base-uri",
    "frame-ancestors",
    "script-src",
    "style-src",
    "img-src",
    "font-src",
    "media-src",
    "frame-src",
    "object-src",
    "connect-src",
    "worker-src",
    "manifest-src",
    "form-action",
    "report-uri",
    "report-to"
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function sourceMapConfig(value: unknown, fallback: SourceMapConfig): SourceMapConfig {
    if(!isRecord(value)) {
        return cloneSourceMap(fallback);
    }

    const normalized: SourceMapConfig = {};
    Object.keys(value).forEach(key => {
        const directive = key.trim().toLowerCase();
        if(directive === "") {
            return;
        }

        const rawSources = value[key];
        if(!Array.isArray(rawSources)) {
            return;
        }

        const sources = rawSources.filter(source => typeof source === "string" && source.trim() !== "")
            .map(source => String(source).trim());
        if(sources.length > 0) {
            normalized[directive] = Array.from(new Set([
                ...(normalized[directive] ?? []),
                ...sources
            ]));
        }
    });

    return normalized;
}

function stringArray(value: unknown, fallback: string[]): string[] {
    if(!Array.isArray(value)) {
        return fallback;
    }

    const values: string[] = [];
    value.forEach(item => {
        if(typeof item === "string" && item.trim() !== "") {
            values.push(item.trim());
        }
    });
    return values.length > 0 ? values : fallback;
}

function cloneSourceMap(value: SourceMapConfig): SourceMapConfig {
    const clone: SourceMapConfig = {};
    Object.keys(value).forEach(key => {
        clone[key] = [...value[key]];
    });
    return clone;
}

export default class CspReport extends BaseJob {

    name = "CSP Report";
    configRequired = false;

    private readonly console: OutputHelper;
    private readonly sourceEntries = new Map<string, SourceEntry>();
    private readonly inlineFindings = new Map<string, InlineFindingSummary>();
    private readonly nestedQueue = new Set<string>();
    private readonly scannedNestedUrls = new Set<string>();
    private readonly nestedFailures: NestedFailure[] = [];

    private inlineFindingCount = 0;
    private nestedFailureCount = 0;
    private scannedPageCount = 0;
    private ignoredPageCount = 0;
    private scannedNestedCount = 0;
    private outputFormat: OutputFormat = defaultConfig.outputFormat;
    private nested = true;
    private unsafeInline = false;
    private includeReportOnly = true;
    private includeEnforce = true;
    private reportUri = "";
    private reportTo = "";
    private promptOutput = false;
    private ignorePatterns: RegExp[] = [];
    private additionalSources: SourceMapConfig = {};
    private ignoreSources: SourceMapConfig = {};
    private staticDirectives: SourceMapConfig = cloneSourceMap(defaultConfig.staticDirectives);
    private baseUrl = "";
    private baseOrigin = "";
    private baseProtocol = "https:";
    private baseHostname = "";

    constructor(handle: string, command: JobCommandParser, profiler: Profiler, runtime: ArachnodexRuntime) {
        super(handle, command, profiler, runtime);
        this.console = new OutputHelper(true, true, this.runtime.config);
        this.promptOutput = command.arguments["-p"]?.active === true
            || command.arguments["--prompt"]?.active === true;
    }

    loadConfig(): void {
        const config = this.config.getJobConfig(defaultConfig, this.command, false, value => {
            value.outputFormat = this.normalizeOutputFormat(value.outputFormat);
            value.nested = typeof value.nested === "boolean" ? value.nested : defaultConfig.nested;
            value.unsafeInline = typeof value.unsafeInline === "boolean" ? value.unsafeInline : defaultConfig.unsafeInline;
            value.includeReportOnly = typeof value.includeReportOnly === "boolean"
                ? value.includeReportOnly
                : defaultConfig.includeReportOnly;
            value.includeEnforce = typeof value.includeEnforce === "boolean" ? value.includeEnforce : defaultConfig.includeEnforce;
            value.reportUri = typeof value.reportUri === "string" ? value.reportUri.trim() : defaultConfig.reportUri;
            value.reportTo = typeof value.reportTo === "string" ? value.reportTo.trim() : defaultConfig.reportTo;
            value.ignorePatterns = stringArray(value.ignorePatterns, defaultConfig.ignorePatterns);
            value.additionalSources = sourceMapConfig(value.additionalSources, defaultConfig.additionalSources);
            value.ignoreSources = sourceMapConfig(value.ignoreSources, defaultConfig.ignoreSources);
            value.staticDirectives = sourceMapConfig(value.staticDirectives, defaultConfig.staticDirectives);
        });

        this.emailReportEnabled = config.emailReportEnabled;
        this.outputFormat = config.outputFormat;
        this.nested = config.nested && this.command.arguments["--no-nested"]?.active !== true;
        this.unsafeInline = config.unsafeInline;
        this.includeReportOnly = config.includeReportOnly;
        this.includeEnforce = config.includeEnforce;
        this.reportUri = config.reportUri;
        this.reportTo = config.reportTo;
        this.ignorePatterns = this.compilePatterns(config.ignorePatterns);
        this.additionalSources = config.additionalSources;
        this.ignoreSources = config.ignoreSources;
        this.staticDirectives = config.staticDirectives;

        this.baseUrl = this.config.getConfigString("baseUrl").replace(/\/+$/, "");
        const base = new URL(this.baseUrl);
        this.baseOrigin = base.origin;
        this.baseProtocol = base.protocol;
        this.baseHostname = this.normalizeHostname(base.hostname);
    }

    onPageReceived(_response: unknown, pageData: PageData): void {
        if(typeof pageData.jsdom === "undefined") {
            return;
        }

        const pageUrl = pageData.location.url;
        if(this.matchesIgnorePattern(pageUrl, pageData.location.rawUrl)) {
            this.ignoredPageCount++;
            return;
        }

        this.scannedPageCount++;
        const doc = pageData.jsdom;

        this.collectBaseUri(doc, pageUrl);
        this.collectScripts(doc, pageUrl);
        this.collectStyles(doc, pageUrl);
        this.collectImages(doc, pageUrl);
        this.collectMedia(doc, pageUrl);
        this.collectEmbeds(doc, pageUrl);
        this.collectForms(doc, pageUrl);
        this.collectInlineEventHandlers(doc, pageUrl);
    }

    async onEnd(): Promise<void> {
        if(this.nested) {
            await this.scanNestedAssets();
        }

        this.reportFindings();
    }

    getReportTitle(): string {
        return "CSP Report";
    }

    getReportMessage(): string {
        const headers = this.getHeaderDirectives();
        return `Generated ${headers.length} CSP header directive${headers.length === 1 ? "" : "s"} from `
            + `${this.sourceEntries.size} observed source${this.sourceEntries.size === 1 ? "" : "s"}.`;
    }

    getReportData(): ReportData {
        return {
            "Scanned Pages": this.scannedPageCount,
            "Ignored Pages": this.ignoredPageCount,
            "Nested Assets Scanned": this.scannedNestedCount,
            "Observed Sources": this.sourceEntries.size,
            "Inline Findings": this.inlineFindingCount,
            "Nested Failures": this.nestedFailureCount,
            "Output Format": this.outputFormat,
            "Nested Enabled": this.nested,
            "Unsafe Inline Enabled": this.unsafeInline
        };
    }

    getReportHtml(): string {
        const headers = this.getHeaderDirectives();
        const warningGroups = this.getWarningGroups();

        return `
            <div style="margin:0;font-family:Helvetica,Arial,sans-serif;color:#333;">
                <p style="margin:0 0 12px;">Generated ${headers.length} CSP header directive${headers.length === 1 ? "" : "s"} in ${this.escapeHtml(this.outputFormat)} format.</p>
                ${this.hasLikelyEnforceBreakage() ? `
                    <div style="margin:0 0 14px;padding:10px;border:1px solid #d92d20;background:#fff4f2;color:#b42318;font-weight:700;">
                        Alert: do not deploy the enforcing Content-Security-Policy header until the alert-level warnings below are resolved.
                    </div>
                ` : ""}
                ${headers.map(header => `
                    <h3 style="margin:14px 0 6px;font-size:15px;line-height:20px;color:#323232;">${this.escapeHtml(this.getHeaderUseTitle(header))}</h3>
                    <p style="margin:0 0 8px;opacity:.55;">${this.escapeHtml(this.getHeaderUseExplanation(header))}</p>
                    <div style="margin:0 0 3px;font-size:12px;line-height:16px;opacity:.55;">-- start copy --</div>
                    <pre style="white-space:pre-wrap;word-break:break-word;margin:0 0 3px;padding:12px;background:#fbfbfb;border:1px solid #e6e6e6;font-size:12px;line-height:17px;">${this.escapeHtml(this.renderHeaderDirective(header))}</pre>
                    <div style="margin:0 0 12px;font-size:12px;line-height:16px;opacity:.55;">-- end copy --</div>
                `).join("\n")}
                ${warningGroups.length > 0 ? `
                    <h3 style="margin:16px 0 8px;font-size:16px;line-height:22px;color:#b54708;">Warnings</h3>
                    ${warningGroups.map(group => this.renderWarningGroupHtml(group)).join("\n")}
                ` : `
                    <div style="margin:16px 0 0;padding:10px;border:1px solid #abefc6;background:#f6fef9;color:#067647;">
                        <strong>All checks passed from crawl observations.</strong>
                        No CSP warning groups were detected. Still deploy the report-only header first and manually test the site before enforcing the policy. See MDN's report-only CSP guidance: <a href="${this.escapeHtml(cspTestingGuideUrl)}" style="color:#067647;text-decoration:underline;">${this.escapeHtml(cspTestingGuideUrl)}</a>
                    </div>
                `}
            </div>
        `;
    }

    private normalizeOutputFormat(value: unknown): OutputFormat {
        if(typeof value !== "string" || !outputFormats.has(value as OutputFormat)) {
            throw new Error("CSP Report outputFormat must be one of: apache, nginx, lighttpd, raw.");
        }

        return value as OutputFormat;
    }

    private collectBaseUri(doc: Document, pageUrl: string): void {
        const element = doc.querySelector("base[href]");
        if(element === null) {
            return;
        }

        const rawUrl = element.getAttribute("href") ?? "";
        let riskReasons: string[] = [];
        try {
            if(!this.isSameOrigin(new URL(rawUrl, pageUrl))) {
                riskReasons = ["external base URL"];
            }
        } catch {
            // Invalid base URLs are ignored by addElementReference.
        }

        this.addElementReference(element, "href", {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: "base href",
            directive: "base-uri",
            zone: this.classifyZone(element),
            riskReasons
        }, false);
    }

    private isCspControlledScript(element: Element): boolean {
        const rawType = element.getAttribute("type");
        if(rawType === null || rawType.trim() === "") {
            return true;
        }

        const type = rawType.toLowerCase().split(";")[0].trim();
        return cspControlledScriptTypes.has(type) || javaScriptMimeTypes.has(type);
    }

    private collectScripts(doc: Document, pageUrl: string): void {
        doc.querySelectorAll("script[src]").forEach(element => {
            if(!this.isCspControlledScript(element)) {
                return;
            }
            this.addElementReference(element, "src", {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel: "script src",
                directive: "script-src",
                zone: this.classifyZone(element)
            });
        });

        doc.querySelectorAll("link[href]").forEach(element => {
            const rel = String(element.getAttribute("rel") ?? "").toLowerCase();
            const asValue = String(element.getAttribute("as") ?? "").toLowerCase();
            if(rel.includes("modulepreload") || (rel.includes("preload") && asValue === "script")) {
                this.addElementReference(element, "href", {
                    sourceUrl: pageUrl,
                    baseUrl: pageUrl,
                    sourceLabel: `link rel=${rel !== "" ? rel : "preload"}`,
                    directive: "script-src",
                    zone: this.classifyZone(element)
                });
            }
        });

        doc.querySelectorAll("script:not([src])").forEach(element => {
            if(!this.isCspControlledScript(element)) {
                return;
            }
            const body = element.textContent ?? "";
            if(body.trim() === "") {
                return;
            }

            this.addInlineFinding("script", pageUrl, "script inline", this.getElementSnippet(element));
            this.collectJsReferences(body, {
                sourceUrl: pageUrl,
                baseUrl: this.getDocumentBaseUrl(doc, pageUrl),
                sourceLabel: "inline script",
                directive: "script-src",
                htmlSnippet: this.getTextSnippet(body, 0),
                zone: this.classifyZone(element)
            });
        });
    }

    private collectStyles(doc: Document, pageUrl: string): void {
        doc.querySelectorAll("link[href]").forEach(element => {
            const rel = String(element.getAttribute("rel") ?? "").toLowerCase();
            const asValue = String(element.getAttribute("as") ?? "").toLowerCase();
            if(rel.includes("stylesheet") || (rel.includes("preload") && asValue === "style")) {
                this.addElementReference(element, "href", {
                    sourceUrl: pageUrl,
                    baseUrl: pageUrl,
                    sourceLabel: rel.includes("stylesheet") ? "link rel=stylesheet" : "link rel=preload as=style",
                    directive: "style-src",
                    zone: this.classifyZone(element)
                });
            }

            if(rel.includes("preload") && asValue === "font") {
                this.addElementReference(element, "href", {
                    sourceUrl: pageUrl,
                    baseUrl: pageUrl,
                    sourceLabel: "link rel=preload as=font",
                    directive: "font-src",
                    zone: this.classifyZone(element)
                });
            }
        });

        doc.querySelectorAll("style").forEach(element => {
            const css = element.textContent ?? "";
            if(css.trim() === "") {
                return;
            }

            this.addInlineFinding("style", pageUrl, "style tag", this.getTextSnippet(css, 0));
            this.collectCssReferences(css, {
                sourceUrl: pageUrl,
                baseUrl: this.getDocumentBaseUrl(doc, pageUrl),
                sourceLabel: "style tag",
                directive: "style-src",
                htmlSnippet: this.getTextSnippet(css, 0),
                zone: this.classifyZone(element)
            });
        });

        doc.querySelectorAll("[style]").forEach(element => {
            const css = element.getAttribute("style") ?? "";
            if(css.trim() === "") {
                return;
            }

            this.addInlineFinding("style", pageUrl, "inline style", this.getElementSnippet(element));
            this.collectCssReferences(css, {
                sourceUrl: pageUrl,
                baseUrl: this.getDocumentBaseUrl(doc, pageUrl),
                sourceLabel: "inline style",
                directive: "style-src",
                htmlSnippet: this.getElementSnippet(element),
                zone: this.classifyZone(element)
            });
        });
    }

    private collectImages(doc: Document, pageUrl: string): void {
        this.collectElementAttr(doc, "img[src]", "src", pageUrl, "img src", "img-src");
        this.collectSrcset(doc, "img[srcset]", "srcset", pageUrl, "img srcset");
        this.collectSrcset(doc, "source[srcset]", "srcset", pageUrl, "source srcset");
        this.collectElementAttr(doc, "video[poster]", "poster", pageUrl, "video poster", "img-src");
        this.collectElementAttr(doc, "image[href], image[xlink\\:href], use[href], use[xlink\\:href]", "href", pageUrl, "svg href", "img-src");
        this.collectElementAttr(doc, "image[xlink\\:href], use[xlink\\:href]", "xlink:href", pageUrl, "svg xlink:href", "img-src");

        doc.querySelectorAll("link[href]").forEach(element => {
            const rel = String(element.getAttribute("rel") ?? "").toLowerCase();
            const asValue = String(element.getAttribute("as") ?? "").toLowerCase();
            if(rel.includes("icon") || rel.includes("apple-touch-icon") || (rel.includes("preload") && asValue === "image")) {
                this.addElementReference(element, "href", {
                    sourceUrl: pageUrl,
                    baseUrl: pageUrl,
                    sourceLabel: rel.includes("preload") ? "link rel=preload as=image" : `link rel=${rel}`,
                    directive: "img-src",
                    zone: this.classifyZone(element)
                });
            }
        });
    }

    private collectMedia(doc: Document, pageUrl: string): void {
        this.collectElementAttr(doc, "source[src]", "src", pageUrl, "source src", "media-src");
        this.collectElementAttr(doc, "video[src], audio[src]", "src", pageUrl, "media src", "media-src");
        this.collectElementAttr(doc, "track[src]", "src", pageUrl, "track src", "media-src");
    }

    private collectEmbeds(doc: Document, pageUrl: string): void {
        this.collectElementAttr(doc, "iframe[src]", "src", pageUrl, "iframe src", "frame-src");
        this.collectElementAttr(doc, "embed[src]", "src", pageUrl, "embed src", "object-src", ["object/embed content"]);
        this.collectElementAttr(doc, "object[data]", "data", pageUrl, "object data", "object-src", ["object/embed content"]);
        this.collectElementAttr(doc, "link[rel~='manifest'][href]", "href", pageUrl, "link rel=manifest", "manifest-src");
    }

    private collectForms(doc: Document, pageUrl: string): void {
        doc.querySelectorAll("form").forEach(element => {
            const action = element.getAttribute("action");
            if(action === null || action.trim() === "") {
                this.addReference(pageUrl, {
                    sourceUrl: pageUrl,
                    baseUrl: pageUrl,
                    sourceLabel: "form default action",
                    directive: "form-action",
                    htmlSnippet: this.getElementSnippet(element),
                    zone: this.classifyZone(element)
                });
                return;
            }

            this.addElementReference(element, "action", {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel: "form action",
                directive: "form-action",
                zone: this.classifyZone(element)
            });
        });
    }

    private collectInlineEventHandlers(doc: Document, pageUrl: string): void {
        doc.querySelectorAll("*").forEach(element => {
            const hasHandler = Array.from(element.attributes).some(attribute => attribute.name.toLowerCase().startsWith("on")
                && attribute.value.trim() !== "");
            if(hasHandler) {
                this.addInlineFinding("script", pageUrl, "inline event handler", this.getElementSnippet(element));
            }
        });
    }

    private collectElementAttr(
        doc: Document,
        selector: string,
        attr: string,
        pageUrl: string,
        sourceLabel: string,
        directive: string,
        riskReasons: string[] = []
    ): void {
        doc.querySelectorAll(selector).forEach(element => {
            this.addElementReference(element, attr, {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel,
                directive,
                zone: this.classifyZone(element),
                riskReasons
            });
        });
    }

    private collectSrcset(doc: Document, selector: string, attr: string, pageUrl: string, sourceLabel: string): void {
        doc.querySelectorAll(selector).forEach(element => {
            const value = element.getAttribute(attr);
            if(value === null || value.trim() === "") {
                return;
            }

            this.parseSrcset(value).forEach(rawUrl => {
                this.addReference(rawUrl, {
                    sourceUrl: pageUrl,
                    baseUrl: this.getDocumentBaseUrl(element.ownerDocument, pageUrl),
                    sourceLabel,
                    directive: "img-src",
                    htmlSnippet: this.getElementSnippet(element),
                    zone: this.classifyZone(element)
                });
            });
        });
    }

    private getDocumentBaseUrl(doc: Document|null, fallback: string): string {
        const baseUrl = doc?.baseURI;
        return typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : fallback;
    }

    private addElementReference(
        element: Element,
        attr: string,
        context: ReferenceContext,
        useDocumentBase = true
    ): void {
        const rawUrl = element.getAttribute(attr);
        if(rawUrl === null || rawUrl.trim() === "") {
            return;
        }

        this.addReference(rawUrl, {
            ...context,
            baseUrl: useDocumentBase
                ? this.getDocumentBaseUrl(element.ownerDocument, context.baseUrl)
                : context.baseUrl,
            htmlSnippet: this.getElementSnippet(element)
        });
    }

    private addReference(rawUrlInput: string, context: ReferenceContext): void {
        const rawUrl = rawUrlInput.trim();
        if(rawUrl === "" || rawUrl.startsWith("#")) {
            return;
        }

        const normalized = this.normalizeSource(rawUrl, context.baseUrl, context.directive);
        if(normalized === null) {
            return;
        }

        const riskReasons = new Set<string>(context.riskReasons ?? []);
        this.getSourceRiskReasons(rawUrl, normalized).forEach(reason => riskReasons.add(reason));

        this.addSource(
            context.directive,
            normalized.source,
            context.sourceUrl,
            Array.from(riskReasons)
        );

        if(normalized.url !== null && (context.directive === "script-src" || context.directive === "style-src")) {
            this.queueNestedScanIfNeeded(normalized.url);
        }
    }

    private addSource(
        directive: string,
        source: string,
        sourceUrl: string,
        riskReasons: string[] = []
    ): void {
        if(this.isIgnoredSource(directive, source)) {
            return;
        }

        const key = `${directive}|${source}`;
        let entry = this.sourceEntries.get(key);
        if(typeof entry === "undefined") {
            entry = {
                directive,
                source,
                occurrenceCount: 0,
                sourceUrls: new Set<string>(),
                riskReasons: new Set<string>()
            };
            this.sourceEntries.set(key, entry);
        }

        entry.occurrenceCount++;
        entry.sourceUrls.add(sourceUrl);
        riskReasons.forEach(reason => entry?.riskReasons.add(reason));
    }

    private addInlineFinding(kind: InlineKind, sourceUrl: string, sourceLabel: string, htmlSnippet: string): void {
        this.inlineFindingCount++;
        const key = `${kind}|${sourceUrl}`;
        let finding = this.inlineFindings.get(key);
        if(typeof finding === "undefined") {
            finding = {
                kind,
                sourceUrl,
                sourceLabel,
                count: 0,
                snippets: new Set<string>()
            };
            this.inlineFindings.set(key, finding);
        }

        finding.count++;
        if(finding.snippets.size < 3) {
            finding.snippets.add(htmlSnippet);
        }
    }

    private normalizeSource(rawUrl: string, baseUrl: string, directive: string): {source: string; url: URL|null}|null {
        if(/^(?:javascript|mailto|tel|ftp|file):/i.test(rawUrl)) {
            return null;
        }

        if(/^(?:data|blob):/i.test(rawUrl)) {
            const scheme = rawUrl.substring(0, rawUrl.indexOf(":") + 1).toLowerCase();
            return {source: scheme, url: null};
        }

        let parsed: URL;
        try {
            parsed = new URL(rawUrl, baseUrl);
        } catch {
            return null;
        }

        if(parsed.protocol === "http:" || parsed.protocol === "https:") {
            return {
                source: this.isSameOrigin(parsed) ? "'self'" : parsed.origin,
                url: parsed
            };
        }

        if(directive === "connect-src" && (parsed.protocol === "ws:" || parsed.protocol === "wss:")) {
            return {source: parsed.origin, url: parsed};
        }

        return null;
    }

    private getSourceRiskReasons(rawUrl: string, normalized: {source: string; url: URL|null}): string[] {
        const reasons: string[] = [];
        if(normalized.url !== null
            && this.baseProtocol === "https:"
            && normalized.url.protocol === "http:") {
            reasons.push("http source observed on an https crawl");
        }

        if(normalized.source === "data:" || normalized.source === "blob:") {
            reasons.push(`${normalized.source} source observed`);
        }

        if(rawUrl.trim().toLowerCase().startsWith("data:text/html")) {
            reasons.push("data HTML source observed");
        }
        return reasons;
    }

    private collectCssReferences(css: string, context: ReferenceContext): void {
        const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi;
        let match: RegExpExecArray|null;
        while((match = urlPattern.exec(css)) !== null) {
            const rawUrl = match[1] ?? match[2] ?? match[3] ?? "";
            this.addReference(rawUrl, {
                ...context,
                directive: this.getDirectiveForAssetUrl(rawUrl, context.baseUrl, "img-src"),
                sourceLabel: `${context.sourceLabel} url()`,
                htmlSnippet: this.getTextSnippet(css, match.index)
            });
        }

        const importPattern = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))/gi;
        while((match = importPattern.exec(css)) !== null) {
            const rawUrl = match[1] ?? match[2] ?? match[3] ?? "";
            this.addReference(rawUrl, {
                ...context,
                directive: "style-src",
                sourceLabel: `${context.sourceLabel} @import`,
                htmlSnippet: this.getTextSnippet(css, match.index)
            });
        }
    }

    private collectJsReferences(js: string, context: ReferenceContext): void {
        this.collectJsCallReferences(js, context);
        this.collectJsImportReferences(js, context);
        this.collectJsAssetLiteralReferences(js, context);
    }

    private collectJsCallReferences(js: string, context: ReferenceContext): void {
        const connectPattern = /\b(?:fetch|sendBeacon|EventSource|WebSocket)\s*\(\s*(['"`])([^'"`${}]{1,2048})\1/gi;
        let match: RegExpExecArray|null;
        while((match = connectPattern.exec(js)) !== null) {
            this.addReference(match[2] ?? "", {
                ...context,
                directive: "connect-src",
                sourceLabel: `${context.sourceLabel} connection`,
                htmlSnippet: this.getTextSnippet(js, match.index)
            });
        }

        const xhrPattern = /\.open\s*\(\s*(['"`])(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1\s*,\s*(['"`])([^'"`${}]{1,2048})\2/gi;
        while((match = xhrPattern.exec(js)) !== null) {
            this.addReference(match[3] ?? "", {
                ...context,
                directive: "connect-src",
                sourceLabel: `${context.sourceLabel} xhr`,
                htmlSnippet: this.getTextSnippet(js, match.index)
            });
        }

        const workerPattern = /\b(Worker|SharedWorker|importScripts)\s*\(\s*(['"`])([^'"`${}]{1,2048})\2/gi;
        while((match = workerPattern.exec(js)) !== null) {
            const functionName = (match[1] ?? "").toLowerCase();
            this.addReference(match[3] ?? "", {
                ...context,
                directive: functionName === "importscripts" ? "script-src" : "worker-src",
                sourceLabel: `${context.sourceLabel} worker`,
                htmlSnippet: this.getTextSnippet(js, match.index)
            });
        }
    }

    private collectJsImportReferences(js: string, context: ReferenceContext): void {
        const importPattern = /\bimport\s*(?:\(\s*)?(?:(?:[^'"`;]*?\s+from\s*)?)(['"`])([^'"`${}]{1,2048}\.(?:js|mjs|css)(?:[?#][^'"`]*)?)\1/gi;
        let match: RegExpExecArray|null;
        while((match = importPattern.exec(js)) !== null) {
            const rawUrl = match[2] ?? "";
            this.addReference(rawUrl, {
                ...context,
                directive: rawUrl.toLowerCase().split(/[?#]/)[0].endsWith(".css") ? "style-src" : "script-src",
                sourceLabel: `${context.sourceLabel} import`,
                htmlSnippet: this.getTextSnippet(js, match.index)
            });
        }
    }

    private collectJsAssetLiteralReferences(js: string, context: ReferenceContext): void {
        const assetStringPattern = /(['"`])([^'"`${}]{1,2048}\.(?:png|jpe?g|gif|webp|avif|svg|css|woff2?|ttf|otf|eot|ico|webmanifest|mp4|webm|mov|m4v|mp3|wav|ogg|vtt|js|mjs)(?:[?#][^'"`]*)?)\1/gi;
        let match: RegExpExecArray|null;
        while((match = assetStringPattern.exec(js)) !== null) {
            const rawUrl = match[2] ?? "";
            if(!this.isConservativeJsReference(rawUrl) || !this.isStandaloneJsStringLiteral(js, match.index, match[0].length)) {
                continue;
            }
            if(this.shouldSkipInactiveHttpProtocolBranch(rawUrl, js, match.index, context.baseUrl)) {
                continue;
            }

            this.addReference(rawUrl, {
                ...context,
                directive: this.getDirectiveForAssetUrl(rawUrl, context.baseUrl, "script-src"),
                sourceLabel: `${context.sourceLabel} string literal`,
                htmlSnippet: this.getTextSnippet(js, match.index)
            });
        }
    }

    private getDirectiveForAssetUrl(rawUrl: string, baseUrl: string, fallback: string): string {
        let parsed: URL;
        try {
            parsed = new URL(rawUrl, baseUrl);
        } catch {
            return fallback;
        }

        const extension = this.getExtension(parsed);
        if(extension === null) {
            return fallback;
        }

        if(["css"].includes(extension)) {
            return "style-src";
        }
        if(["js", "mjs"].includes(extension)) {
            return "script-src";
        }
        if(["woff", "woff2", "ttf", "otf", "eot"].includes(extension)) {
            return "font-src";
        }
        if(["mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "vtt"].includes(extension)) {
            return "media-src";
        }
        if(extension === "webmanifest") {
            return "manifest-src";
        }
        return "img-src";
    }

    private async scanNestedAssets(): Promise<void> {
        while(this.nestedQueue.size > 0 && !this.runtime.aborted) {
            const urls: string[] = [];
            while(urls.length < nestedConcurrency) {
                const url = this.getNextNestedUrl();
                if(url === null) {
                    break;
                }
                urls.push(url);
            }

            if(urls.length === 0) {
                return;
            }

            await Promise.all(urls.map(url => this.scanNestedAsset(url)));
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
        } catch(error) {
            this.nestedFailureCount++;
            if(this.nestedFailures.length < nestedFailureSampleLimit) {
                this.nestedFailures.push({
                    url,
                    message: error instanceof Error ? error.message : String(error)
                });
            }
            return;
        }

        this.scannedNestedCount++;
        if(body === "") {
            return;
        }

        const parsed = new URL(url);
        const extension = this.getExtension(parsed);
        if(extension === "css") {
            this.collectCssReferences(body, {
                sourceUrl: url,
                baseUrl: url,
                sourceLabel: `CSS body ${url}`,
                directive: "style-src",
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
                directive: "script-src",
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

    private queueNestedScanIfNeeded(parsed: URL): void {
        if(!this.nested || !this.isSameSite(parsed) || !this.isNestedScannable(parsed)) {
            return;
        }

        this.nestedQueue.add(parsed.href);
    }

    private buildPolicy(): string {
        const directives = this.getPolicyDirectives();
        return this.getSortedDirectiveNames(directives).map(directive => {
            const sources = this.getSortedSources(directive, directives.get(directive) ?? new Set<string>());
            return `${directive} ${sources.join(" ")}`;
        }).join("; ");
    }

    private getPolicyDirectives(): Map<string, Set<string>> {
        const directives = new Map<string, Set<string>>();

        Object.keys(this.staticDirectives).forEach(directive => {
            this.staticDirectives[directive].forEach(source => {
                if(!this.isIgnoredSource(directive, source)) {
                    this.addPolicySource(directives, directive, source);
                }
            });
        });

        this.sourceEntries.forEach(entry => this.addPolicySource(directives, entry.directive, entry.source));

        if(!directives.has("object-src") && !this.isIgnoredSource("object-src", "'none'")) {
            this.addPolicySource(directives, "object-src", "'none'");
        }

        if(this.unsafeInline) {
            if(this.hasInlineKind("script")) {
                this.addPolicySource(directives, "script-src", "'unsafe-inline'");
            }
            if(this.hasInlineKind("style")) {
                this.addPolicySource(directives, "style-src", "'unsafe-inline'");
            }
        }

        Object.keys(this.additionalSources).forEach(directive => {
            this.additionalSources[directive].forEach(source => {
                if(!this.isIgnoredSource(directive, source)) {
                    this.addPolicySource(directives, directive, source);
                }
            });
        });

        if(this.reportUri !== "") {
            this.addPolicySource(directives, "report-uri", this.reportUri);
        }
        if(this.reportTo !== "") {
            this.addPolicySource(directives, "report-to", this.reportTo);
        }

        directives.forEach(sources => {
            if(sources.size > 1 && sources.has("'none'")) {
                sources.delete("'none'");
            }
        });

        return directives;
    }

    private addPolicySource(directives: Map<string, Set<string>>, directive: string, source: string): void {
        if(source.trim() === "") {
            return;
        }

        let sources = directives.get(directive);
        if(typeof sources === "undefined") {
            sources = new Set<string>();
            directives.set(directive, sources);
        }
        sources.add(source.trim());
    }

    private getHeaderDirectives(): HeaderDirective[] {
        const policy = this.buildPolicy();
        const headers: HeaderDirective[] = [];
        if(this.includeReportOnly) {
            headers.push({
                name: "Content-Security-Policy-Report-Only",
                value: policy,
                mode: "report-only"
            });
        }
        if(this.includeEnforce) {
            headers.push({
                name: "Content-Security-Policy",
                value: policy,
                mode: "enforce"
            });
        }
        return headers;
    }

    private renderDirectives(): string {
        return this.getHeaderDirectives().map(header => this.renderHeaderDirective(header)).join("\n");
    }

    private renderHeaderDirective(header: HeaderDirective): string {
        switch(this.outputFormat) {
            case "nginx":
                return `add_header ${header.name} "${this.escapeConfigValue(header.value)}" always;`;
            case "lighttpd":
                return [
                    "setenv.set-response-header += (",
                    `  "${header.name}" => "${this.escapeConfigValue(header.value)}"`,
                    ")"
                ].join("\n");
            case "raw":
                return `${header.name}: ${header.value}`;
            case "apache":
            default:
                return [
                    `Header onsuccess unset ${header.name}`,
                    `Header always set ${header.name} "${this.escapeConfigValue(header.value)}"`
                ].join("\n");
        }
    }

    private reportFindings(): void {
        this.console.log("CSP Report", "bold");
        this.console.log("----------", "bold");

        this.console.log("How to use this report", "bold");
        this.console.log(`${reportIndent}Start with the report-only header to collect browser CSP violations without blocking resources.`, "white");
        this.console.log(`${reportIndent}Use the enforcing header only after the warning groups below are understood and addressed.`, "white");

        if(this.hasLikelyEnforceBreakage()) {
            this.console.log("", "red");
            this.console.log("ALERT: The enforcing Content-Security-Policy header is likely to break this site.", "red.bold");
            this.console.log(`${reportIndent}Do not deploy the non-report header until the alert-level warnings below are resolved.`, "red");
        }

        this.getHeaderDirectives().forEach(header => {
            this.console.log("", "white");
            this.console.log(this.getHeaderUseTitle(header), header.mode === "enforce" ? "yellow.bold" : "cyan.bold");
            this.console.log(this.getHeaderUseExplanation(header), "white.dim");
            this.console.log("-- start copy --", "white.dim");
            this.console.log(this.renderHeaderDirective(header), "white");
            this.console.log("-- end copy --", "white.dim");
        });

        const warningGroups = this.getWarningGroups();
        if(warningGroups.length > 0) {
            this.console.log("", "yellow");
            this.console.log("Warnings", "yellow.bold");
            warningGroups.forEach(group => this.reportWarningGroup(group));
        } else {
            this.console.log("", "green");
            this.console.log("ALL CHECKS PASSED FROM CRAWL OBSERVATIONS.", "green.bold");
            this.console.log(`${reportIndent}No CSP warning groups were detected. Do not trust the enforcing header blindly; deploy the report-only header first and manually test the site.`, "green");
            this.console.log(`${reportIndent}Testing guide: ${cspTestingGuideUrl}`, "green");
        }

        if(this.promptOutput && warningGroups.length > 0) {
            this.reportPromptWarnings(warningGroups);
        }
    }

    private getWarningGroups(): WarningGroup[] {
        const warnings: WarningGroup[] = [];
        if(this.scannedPageCount === 0) {
            warnings.push({
                key: "no-pages-scanned",
                title: "No Pages Scanned",
                severity: "alert",
                summary: "The CSP job did not scan any HTML pages.",
                meaning: "The generated policy is based only on static configuration and cannot represent the site's runtime resource dependencies.",
                recommendations: [
                    "Confirm the crawl discovered and parsed HTML pages before using either generated header.",
                    "Review ignorePatterns if pages were discovered but all of them were excluded.",
                    "Rerun the crawl and do not deploy an enforcing policy until this report includes scanned pages."
                ],
                items: [
                    `${this.ignoredPageCount} page${this.ignoredPageCount === 1 ? "" : "s"} ignored by configuration.`
                ],
                totalItems: 1
            });
        }

        if(this.inlineFindingCount > 0) {
            const scriptCount = this.getInlineFindingCount("script");
            const styleCount = this.getInlineFindingCount("style");
            if(scriptCount > 0) {
                warnings.push({
                    key: "inline-script",
                    title: "Inline Script And Event Handlers",
                    severity: this.unsafeInline ? "warning" : "alert",
                    summary: `${scriptCount} inline script/event handler occurrence${scriptCount === 1 ? "" : "s"} observed.`
                        + (this.unsafeInline ? " unsafe-inline was added to script-src." : " unsafe-inline was not added."),
                    meaning: this.unsafeInline
                        ? "The generated policy allows inline JavaScript for compatibility, but inline JavaScript weakens CSP because injected script can also run."
                        : "The enforcing header blocks inline <script> blocks and inline event handlers such as onclick. Pages that depend on them will break until they are removed, hashed/nonced, or unsafe-inline is enabled.",
                    recommendations: [
                        "Best fix: move inline JavaScript and inline event handlers into external scripts loaded from allowed script-src origins.",
                        "Stronger CSP path: add nonce or hash support in the application templates and emit matching CSP values from the server.",
                        "Compatibility path: rerun this job with --unsafe-inline or set unsafeInline true, then treat the remaining inline usage as cleanup debt."
                    ],
                    items: this.getInlineWarningItems("script"),
                    totalItems: scriptCount
                });
            }
            if(styleCount > 0) {
                warnings.push({
                    key: "inline-style",
                    title: "Inline Styles",
                    severity: this.unsafeInline ? "warning" : "alert",
                    summary: `${styleCount} inline style occurrence${styleCount === 1 ? "" : "s"} observed.`
                        + (this.unsafeInline ? " unsafe-inline was added to style-src." : " unsafe-inline was not added."),
                    meaning: this.unsafeInline
                        ? "The generated policy allows inline CSS for compatibility, but inline styles reduce the protection CSP can provide against style injection."
                        : "The enforcing header blocks inline <style> blocks and style attributes. Visual layout, hiding/showing behavior, and generated content styling may break until those styles are moved, hashed/nonced, or unsafe-inline is enabled.",
                    recommendations: [
                        "Move repeated inline styles into stylesheet classes loaded from allowed style-src origins.",
                        "For unavoidable generated style tags, consider CSP nonces or hashes if the server can emit matching policy values.",
                        "Compatibility path: rerun this job with --unsafe-inline or set unsafeInline true, then clean up inline styles over time."
                    ],
                    items: this.getInlineWarningItems("style"),
                    totalItems: styleCount
                });
            }
        }

        const riskyEntries = this.getRiskyEntries();
        if(riskyEntries.length > 0) {
            const riskyReasons = Array.from(new Set(riskyEntries.flatMap(entry => Array.from(entry.riskReasons)))).sort();
            warnings.push({
                key: "risky-sources",
                title: "Risky Sources Preserved In Policy",
                severity: "warning",
                summary: `${riskyEntries.length} risky source${riskyEntries.length === 1 ? "" : "s"} were observed and preserved to avoid changing current site behavior. Reason${riskyReasons.length === 1 ? "" : "s"}: ${riskyReasons.join("; ")}.`,
                meaning: "The generated policy includes these sources because the crawl observed them. They may still represent security or browser compatibility issues, such as HTTP subresources on HTTPS pages, external base URLs, or object/embed content.",
                recommendations: [
                    "Replace HTTP resource URLs with HTTPS equivalents when the provider supports HTTPS.",
                    "Prefer a same-origin base URL; an external base changes how every relative document URL resolves.",
                    "Remove object/embed content or replace it with safer iframe or first-party alternatives when possible.",
                    "After cleanup, rerun the CSP report and remove any no-longer-needed source from additionalSources/config."
                ],
                items: riskyEntries.map(entry => `${entry.directive} ${entry.source}: ${Array.from(entry.riskReasons).join(", ")}. ${entry.occurrenceCount} occurrence${entry.occurrenceCount === 1 ? "" : "s"}. ${this.getSampleSourceUrls(entry.sourceUrls).join(", ")}`),
                totalItems: riskyEntries.length
            });
        }

        if(this.nestedFailureCount > 0) {
            warnings.push({
                key: "nested-failures",
                title: "Nested Assets Not Scanned",
                severity: "warning",
                summary: `${this.nestedFailureCount} nested asset${this.nestedFailureCount === 1 ? "" : "s"} could not be scanned.`,
                meaning: "The policy may be incomplete because same-site CSS or JavaScript files could not be fetched and inspected for additional dependencies.",
                recommendations: [
                    "Check whether the listed assets are missing, blocked, too slow, too large, or require different local dev routing.",
                    "Fix the asset availability issue and rerun the report before enforcing CSP.",
                    "If an asset is intentionally unavailable during crawling, manually review it and add required sources through additionalSources."
                ],
                items: this.nestedFailures.map(failure => `${failure.url}: ${failure.message}`),
                totalItems: this.nestedFailureCount
            });
        }

        return warnings;
    }

    private hasLikelyEnforceBreakage(): boolean {
        if(!this.includeEnforce) {
            return false;
        }

        return this.scannedPageCount === 0 || (!this.unsafeInline && this.inlineFindingCount > 0);
    }

    private getHeaderUseTitle(header: HeaderDirective): string {
        return header.mode === "report-only"
            ? "Report-only header: use this first"
            : "Enforcing header: use only when ready";
    }

    private getHeaderUseExplanation(header: HeaderDirective): string {
        if(header.mode === "report-only") {
            return `Deploy this header first to observe browser CSP violations without blocking page resources. Use the violations and warnings below to tighten the policy safely. MDN report-only CSP guidance: ${cspTestingGuideUrl}`;
        }

        if(this.hasLikelyEnforceBreakage()) {
            return "This header actively blocks disallowed resources. With the current alert-level warnings, deploying it as-is is unsafe or likely to break site behavior.";
        }

        return "This header actively blocks disallowed resources. Deploy it only after reviewing warning groups and confirming the site works under report-only observations.";
    }

    private renderWarningGroupHtml(group: WarningGroup): string {
        const color = group.severity === "alert" ? "#b42318" : group.severity === "warning" ? "#b54708" : "#175cd3";
        return `
            <div style="margin:0 0 14px;padding:10px;border:1px solid #eeeeee;background:#ffffff;">
                <h4 style="margin:0 0 6px;font-size:14px;line-height:20px;color:${color};">${this.escapeHtml(group.title)}</h4>
                <p style="margin:0 0 6px;"><strong>${this.escapeHtml(group.summary)}</strong></p>
                <p style="margin:0 0 6px;">${this.escapeHtml(group.meaning)}</p>
                <p style="margin:0 0 4px;"><strong>Recommendations:</strong></p>
                <ul style="margin:0 0 8px 18px;padding:0;">
                    ${group.recommendations.map(item => `<li style="margin:0 0 3px;">${this.escapeHtml(item)}</li>`).join("\n")}
                </ul>
                ${group.items.length > 0 ? `
                    <p style="margin:0 0 4px;"><strong>Samples:</strong></p>
                    <ul style="margin:0 0 8px 18px;padding:0;">
                        ${group.items.slice(0, 10).map(item => `<li style="margin:0 0 3px;">${this.escapeHtml(item)}</li>`).join("\n")}
                    </ul>
                    ${group.totalItems > 10 ? `<p style="margin:0;opacity:.65;">Showing up to 10 samples from ${group.totalItems} reported items or occurrences.</p>` : ""}
                ` : ""}
            </div>
        `;
    }

    private reportWarningGroup(group: WarningGroup): void {
        const color = group.severity === "alert" ? "red" : group.severity === "warning" ? "yellow" : "cyan";
        this.console.log("", color);
        this.console.log(`${group.severity.toUpperCase()}: ${group.title}`, `${color}.bold`);
        this.console.log(`${reportIndent}${group.summary}`, color);
        this.console.log(`${reportIndent}What it means: ${group.meaning}`, color);
        this.console.log(`${reportIndent}Recommendations:`, color);
        group.recommendations.forEach(recommendation => {
            this.console.log(`${reportIndent}${reportIndent}- ${recommendation}`, color);
        });
        if(group.items.length > 0) {
            this.console.log(`${reportIndent}Samples:`, color);
            group.items.slice(0, 10).forEach(item => {
                this.console.log(`${reportIndent}${reportIndent}- ${item}`, color);
            });
            if(group.totalItems > 10) {
                this.console.log(
                    `${reportIndent}${reportIndent}Showing up to 10 samples from ${group.totalItems} reported items or occurrences.`,
                    color
                );
            }
        }
    }

    private reportPromptWarnings(groups: WarningGroup[]): void {
        this.console.log("", "white");
        this.console.log("CSP CLEANUP PROMPTS", "white.bold");
        this.console.log("-------------------", "white.bold");
        groups.forEach((group, index) => {
            if(index > 0) {
                this.console.log("", "white");
            }
            const title = `PROMPT: CSP / ${group.title}`;
            this.console.log(title, "white.bold");
            this.console.log("-".repeat(title.length), "white.bold");
            this.console.log("----- BEGIN PROMPT -----", "white.bold");
            this.console.log(this.buildPromptText(group), "white");
            this.console.log("----- END PROMPT -----", "white.bold");
        });
    }

    private buildPromptText(group: WarningGroup): string {
        const lines = [
            "You are working in a website or application codebase.",
            `An Arachnodex CSP report found a warning group: ${group.title}.`,
            `Site/base URL: ${this.baseUrl}`,
            `Severity: ${group.severity.toUpperCase()}`,
            "",
            "Goal:",
            "- Find the code, templates, CMS content, data, build output, or server configuration that creates these CSP issues.",
            "- Fix only the listed CSP warning group and avoid unrelated refactors.",
            "- Preserve current site behavior while moving toward a safer CSP.",
            "",
            "What this means:",
            group.meaning,
            "",
            "Recommended fix approach:",
            ...group.recommendations.map(recommendation => `- ${recommendation}`),
            "",
            "Issue list:"
        ];

        if(group.totalItems > 100) {
            lines.push(
                `- The report found ${group.totalItems} occurrence${group.totalItems === 1 ? "" : "s"} in this group, so the crawl output is intentionally summarized instead of listing every instance.`,
                `- Search the codebase/templates/CMS data for the repeated pattern described by this warning group (${group.title}) and fix the source pattern broadly.`,
                "- This handoff prompt intentionally avoids carrying a large occurrence list."
            );
        } else if(group.items.length === 0) {
            lines.push("- No sample items were captured; use the summary and report context to inspect the relevant templates/assets.");
        } else {
            group.items.forEach((item, index) => {
                lines.push(`${index + 1}. ${item}`);
            });
        }

        lines.push(
            "",
            "Acceptance criteria:",
            "- Rerun the Arachnodex CSP report after changes.",
            "- The warning group count is reduced or eliminated.",
            "- The generated enforcing CSP header can be tested without breaking the affected pages."
        );

        return lines.join("\n");
    }

    private getInlineWarningItems(kind: InlineKind): string[] {
        return Array.from(this.inlineFindings.values())
            .filter(finding => finding.kind === kind)
            .sort((a, b) => {
                const countCompare = b.count - a.count;
                return countCompare !== 0 ? countCompare : a.sourceUrl.localeCompare(b.sourceUrl);
            })
            .slice(0, 25)
            .map(item => {
                const snippets = Array.from(item.snippets).filter(snippet => snippet !== "").slice(0, 2);
                const snippetText = snippets.length > 0 ? ` Sample: ${snippets.join(" | ")}` : "";
                return `${item.sourceUrl}: ${item.count} ${item.sourceLabel} occurrence${item.count === 1 ? "" : "s"}.${snippetText}`;
            });
    }

    private getInlineFindingCount(kind: InlineKind): number {
        return Array.from(this.inlineFindings.values())
            .filter(finding => finding.kind === kind)
            .reduce((total, finding) => total + finding.count, 0);
    }

    private getSampleSourceUrls(sourceUrls: Set<string>): string[] {
        return Array.from(sourceUrls).slice(0, 3);
    }

    private getRiskyEntries(): SourceEntry[] {
        return Array.from(this.sourceEntries.values())
            .filter(entry => entry.riskReasons.size > 0)
            .sort((a, b) => {
                const directiveCompare = a.directive.localeCompare(b.directive);
                return directiveCompare !== 0 ? directiveCompare : a.source.localeCompare(b.source);
            });
    }

    private hasInlineKind(kind: InlineKind): boolean {
        return this.getInlineFindingCount(kind) > 0;
    }

    private isIgnoredSource(directive: string, source: string): boolean {
        const ignored = this.ignoreSources[directive] ?? [];
        const globalIgnored = this.ignoreSources["*"] ?? [];
        return ignored.includes(source) || globalIgnored.includes(source);
    }

    private matchesIgnorePattern(url: string, rawUrl?: string): boolean {
        if(this.ignorePatterns.length === 0) {
            return false;
        }

        let parsed: URL;
        try {
            parsed = new URL(url, this.baseUrl);
        } catch {
            return false;
        }

        const candidates = new Set<string>([
            url,
            parsed.href,
            `${parsed.pathname}${parsed.search}`,
            parsed.pathname,
            this.safeDecode(`${parsed.pathname}${parsed.search}`),
            this.safeDecode(parsed.pathname)
        ]);

        if(typeof rawUrl === "string" && rawUrl !== "") {
            candidates.add(rawUrl);
        }

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

    private compilePatterns(patterns: string[]): RegExp[] {
        return patterns.flatMap(pattern => {
            try {
                return [new RegExp(pattern)];
            } catch {
                return [];
            }
        });
    }

    private safeDecode(value: string): string {
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    }

    private getSortedDirectiveNames(directives: Map<string, Set<string>>): string[] {
        return Array.from(directives.keys()).sort((a, b) => {
            const aIndex = directiveOrder.indexOf(a);
            const bIndex = directiveOrder.indexOf(b);
            if(aIndex !== -1 || bIndex !== -1) {
                return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex)
                    - (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
            }
            return a.localeCompare(b);
        });
    }

    private getSortedSources(_directive: string, sources: Set<string>): string[] {
        return Array.from(sources).sort((a, b) => {
            const aRank = this.getSourceSortRank(a);
            const bRank = this.getSourceSortRank(b);
            return aRank !== bRank ? aRank - bRank : a.localeCompare(b);
        });
    }

    private getSourceSortRank(source: string): number {
        if(source === "'none'") {
            return 0;
        }
        if(source === "'self'") {
            return 1;
        }
        if(source.startsWith("'")) {
            return 2;
        }
        if(source.endsWith(":")) {
            return 3;
        }
        return 4;
    }

    private isConservativeJsReference(rawUrl: string): boolean {
        if(rawUrl.includes("${")) {
            return false;
        }
        if(/^(?:https?:)?\/\//i.test(rawUrl) || rawUrl.startsWith("/")) {
            return true;
        }
        if(rawUrl.startsWith("./") || rawUrl.startsWith("../")) {
            return !this.isRelativeJsModuleSpecifier(rawUrl);
        }
        return false;
    }

    private shouldSkipInactiveHttpProtocolBranch(rawUrl: string, js: string, index: number, baseUrl: string): boolean {
        let base: URL;
        let parsed: URL;
        try {
            base = new URL(baseUrl);
            parsed = new URL(rawUrl, base);
        } catch {
            return false;
        }

        if(base.protocol !== "https:" || parsed.protocol !== "http:") {
            return false;
        }

        const httpsTwin = new URL(parsed.href);
        httpsTwin.protocol = "https:";

        const contextStart = Math.max(0, index - 500);
        const contextEnd = Math.min(js.length, index + rawUrl.length + 500);
        const localContext = js.slice(contextStart, contextEnd);

        return /\b(?:document\.)?location\.protocol\b/i.test(localContext)
            && /[`"']https:\s*[`"']/i.test(localContext)
            && localContext.includes(httpsTwin.href);
    }

    private isStandaloneJsStringLiteral(js: string, index: number, length: number): boolean {
        const before = js.slice(0, index).match(/\S\s*$/)?.[0].trim() ?? "";
        const after = js.slice(index + length).match(/^\s*\S/)?.[0].trim() ?? "";
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

    private isNestedScannable(parsed: URL): boolean {
        const extension = this.getExtension(parsed);
        return extension === "css" || extension === "js" || extension === "mjs";
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

    private isSameOrigin(parsed: URL): boolean {
        return parsed.origin === this.baseOrigin;
    }

    private isSameSite(parsed: URL): boolean {
        return this.normalizeHostname(parsed.hostname) === this.baseHostname;
    }

    private normalizeHostname(hostname: string): string {
        return hostname.replace(/^www\./i, "").toLowerCase();
    }

    private parseSrcset(value: string): string[] {
        return value
            .split(",")
            .map(candidate => candidate.trim().split(/\s+/)[0] ?? "")
            .filter(candidate => candidate !== "");
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

    private escapeConfigValue(value: string): string {
        return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    private getElementSnippet(element: Element): string {
        return element.outerHTML.replace(/\s+/g, " ").trim().substring(0, 500);
    }

    private getTextSnippet(value: string, index: number): string {
        const start = Math.max(0, index - 80);
        const end = Math.min(value.length, index + 220);
        return value.substring(start, end).replace(/\s+/g, " ").trim();
    }

}
