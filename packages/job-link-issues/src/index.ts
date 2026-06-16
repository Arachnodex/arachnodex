"use strict";

import axios, {type AxiosRequestConfig, type AxiosResponse} from "axios";
import * as http from "http";
import * as https from "https";
import type {
    JSONObject,
    LinkIssueSeverity,
    LinkZone,
    Location,
    PageData,
    PageLink,
    PageParseWarning,
    ReportData
} from "@arachnodex/core";
import {
    BaseJob,
    botProtectionHeuristics,
    defaultRequestHeaders,
    OutputHelper,
    type ArachnodexRuntime,
    type JobCommandParser,
    type Profiler
} from "@arachnodex/core";
export {default as CommandParser} from "./cmd.js";

type LinkIssue = {
    severity: LinkIssueSeverity;
    group: string;
    code: string;
    message: string;
    targetUrl?: string;
    sourceUrl?: string;
    rawHref?: string;
    htmlSnippet?: string;
    normalizedUrl?: string;
    pageUrl?: string;
    linkedUrl?: string;
    canonicalUrl?: string;
    expectedCanonicalUrl?: string;
    canonicalHrefs?: string[];
    decodedPath?: string;
    networkErrorCode?: string;
    networkErrorMessage?: string;
    statusCode?: number;
    finalUrl?: string;
    redirectChain?: string[];
    zone?: LinkZone;
    assetKind?: string;
    sourceLabel?: string;
    occurrenceDetails?: LinkOccurrence[];
}

interface IgnoredIssuePatternConfig extends JSONObject {
    urlPattern: string;
    codes?: string[];
    groups?: string[];
    severities?: LinkIssueSeverity[];
}

interface LinkIssuesConfig extends JSONObject {
    allowedNonCanonicalLinks: string[];
    emailReportEnabled: boolean;
    emailReportTriggerLevels: LinkIssueSeverity[]|null;
    includeAssets: boolean;
    ignoredIssuePatterns: IgnoredIssuePatternConfig[];
    undesirablePathCharacterPattern: string;
}

type AssetKind =
    'script'
    | 'stylesheet'
    | 'image'
    | 'srcset'
    | 'icon'
    | 'manifest'
    | 'preload'
    | 'media'
    | 'track'
    | 'poster'
    | 'iframe'
    | 'embed'
    | 'object'
    | 'meta'
    | 'svg'
    | 'inline-style'
    | 'css-url'
    | 'css-import'
    | 'css-source-map'
    | 'js-url'
    | 'js-source-map';

type AssetRecord = {
    targetUrl: string;
    rawUrl: string;
    sourceUrl: string;
    sourceLabel: string;
    kind: AssetKind;
    htmlSnippet?: string;
    zone: LinkZone;
    isExternal: boolean;
    occurrences: LinkOccurrence[];
}

type AssetReferenceContext = {
    sourceUrl: string;
    baseUrl: string;
    sourceLabel: string;
    kind: AssetKind;
    htmlSnippet?: string;
    zone: LinkZone;
    occurrenceDetails?: LinkOccurrence[];
}

type IgnoredIssuePattern = {
    pattern: RegExp;
    codes: Set<string>|null;
    groups: Set<string>|null;
    severities: Set<LinkIssueSeverity>|null;
}

type LinkOccurrence = {
    referer: string;
    zone: LinkZone;
}

type LinkOccurrenceSummary = {
    targetUrl: string;
    occurrenceCount: number;
    pageUrls: Set<string>;
    wrapperOccurrenceCount: number;
    wrapperPageUrls: Set<string>;
    zones: Record<LinkZone, number>;
    occurrences: LinkOccurrence[];
}

type WrapperMeta = {
    summary: LinkOccurrenceSummary;
    topWrapperZone: LinkZone;
    wrapperPagePercent: number;
    pageUrls: Set<string>;
    occurrenceCount: number;
    inferredSharedLayout: boolean;
}

type StatusRecord = {
    status: number;
    location: Location;
}

type FragmentRequest = {
    targetUrl: string;
    fragment: string;
    sourceUrl: string;
    rawHref: string;
    htmlSnippet?: string;
    zone: LinkZone;
}

type CanonicalReference = {
    sourceUrl: string;
    canonicalUrl: string;
}

type ExternalLinkRecord = {
    targetUrl: string;
    sources: Set<string>;
    rawHrefs: Set<string>;
    htmlSnippets: Set<string>;
    zones: Set<LinkZone>;
}

type ReportIssueEntry = {
    issue: LinkIssue;
    key: string;
    count: number;
    sourceUrls: Set<string>;
}

type PromptSection = {
    severity: LinkIssueSeverity;
    group: string;
    entries: ReportIssueEntry[];
}

type EmailReportEntry = {
    entry: ReportIssueEntry;
    details: string[];
    wrapperMeta: WrapperMeta|null;
    sources: string[];
}

type EmailReportSubsection = {
    label: string;
    note: string;
    entries: EmailReportEntry[];
}

type EmailReportGroup = {
    label: string;
    subsections: EmailReportSubsection[];
}

type EmailReportSection = {
    severity: LinkIssueSeverity;
    label: string;
    groups: EmailReportGroup[];
}

const wrapperZones = new Set<LinkZone>(['nav', 'header', 'footer', 'aside', 'before-main', 'after-main']);
const reportByRawHrefCodes = new Set<string>([
    'missing-href',
    'empty-href',
    'hash-placeholder',
    'javascript-href',
    'vbscript-href',
    'non-web-protocol',
    'control-character-href',
    'target-blank-rel'
]);
const reportByCodeOnlyCodes = new Set<string>([
    'missing-canonical'
]);
const linkIssueSeverities: LinkIssueSeverity[] = ['error', 'warning', 'notice'];
const externalCheckConcurrency = 10;
const externalCheckTimeoutMs = 5000;
const externalCheckMaxAttempts = 3;
const externalCheckUrlTimeoutMs = externalCheckTimeoutMs * externalCheckMaxAttempts;
const assetBodyMaxBytes = 1024 * 1024;
const externalCheckRequestHeaders: Record<string, string> = {
    ...defaultRequestHeaders,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
};
const reportIndent = '  ';
const defaultIgnoredExternalRedirectPattern =
    '^https?://(?:www\\.)?(?:facebook\\.com/(?:sharer|share_channel)|linkedin\\.com/(?:shareArticle|uas/login)|(?:x|twitter)\\.com/(?:intent/tweet|share)|threads\\.net/(?:intent/post|share)|bsky\\.app/intent/compose|youtu\\.be/|youtube\\.com/watch|instagram\\.com/|goo\\.gl/maps/)(?:[?#/].*)?$';
const reportGroupOrder = [
    'Client Errors',
    'Server Errors',
    'Failed Fetches',
    'Redirects',
    'External Links',
    'Asset Links',
    'Asset Security',
    'Canonical Issues',
    'Malformed Links',
    'URL Path Quality',
    'Unsafe Link Protocols',
    'Insecure Internal Links',
    'Fragment Links',
    'Target Blank Security',
    'Placeholder Links'
];

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default class LinkIssues extends BaseJob {

    name = "Link Issue Report";
    configRequired = false;
    console: OutputHelper;

    // Issue collections are split by purpose: raw issues for reporting, crawl status for
    // deferred checks, and occurrence maps for grouping repeated template-level links.
    issues: LinkIssue[] = [];
    issueOccurrences = new Map<string, LinkOccurrenceSummary>();
    statusByUrl = new Map<string, StatusRecord>();
    redirectSources = new Map<string, Location>();
    canonicalReferences: CanonicalReference[] = [];
    nonCanonicalTargets = new Set<string>();
    processedPageUrls = new Set<string>();
    pageAnchors = new Map<string, Set<string>>();
    fragmentRequests: FragmentRequest[] = [];
    externalLinks = new Map<string, ExternalLinkRecord>();
    assetLinks = new Map<string, AssetRecord>();
    scannedAssetBodies = new Set<string>();
    scannedPageCount = 0;

    baseUrl: string;
    baseProtocol: string;
    baseHostname: string;
    allowedNonCanonicalLinks: string[] = [];
    ignoredIssuePatterns: IgnoredIssuePattern[] = [];
    undesirablePathCharacterPattern = /[^\w\-/.]/;
    emailReportTriggerLevels: LinkIssueSeverity[]|null = ['error', 'warning', 'notice'];
    includeNotices: boolean;
    includeExternal: boolean;
    includeAssets: boolean;
    promptOutput: boolean;

    constructor(handle: string, command: JobCommandParser, profiler: Profiler, runtime: ArachnodexRuntime) {
        super(handle, command, profiler, runtime);
        this.console = new OutputHelper(true, true, this.config);
        this.baseUrl = this.config.getConfigString('baseUrl');
        const base = new URL(this.baseUrl);
        this.baseProtocol = base.protocol;
        this.baseHostname = this.normalizeHostname(base.hostname);
        this.includeNotices = command.arguments['-n']?.active === true
            || command.arguments['--include-notices']?.active === true;
        this.includeExternal = command.arguments['-e']?.active === true
            || command.arguments['--include-external']?.active === true;
        this.includeAssets = command.arguments['-a']?.active === true
            || command.arguments['--include-assets']?.active === true;
        this.promptOutput = command.arguments['-p']?.active === true
            || command.arguments['--prompt']?.active === true;

    }

    loadConfig(): void {
        // Config controls reporting thresholds and URL-quality policy. Command switches
        // decide whether optional notice/external/prompt output is enabled for this run.
        const config = this.config.getJobConfig<LinkIssuesConfig>({
            allowedNonCanonicalLinks: [],
            emailReportTriggerLevels: ['error', 'warning', 'notice'],
            includeAssets: false,
            ignoredIssuePatterns: [
                {
                    codes: ['external-redirect'],
                    urlPattern: defaultIgnoredExternalRedirectPattern
                }
            ],
            undesirablePathCharacterPattern: '[^\\w\\-/.]',
            emailReportEnabled: true
        }, this.command, false);
        this.emailReportEnabled = config.emailReportEnabled;
        this.includeAssets = this.includeAssets || config.includeAssets === true;
        this.emailReportTriggerLevels = this.normalizeEmailReportTriggerLevels(config.emailReportTriggerLevels);
        this.undesirablePathCharacterPattern = this.compileUndesirablePathCharacterPattern(
            config.undesirablePathCharacterPattern
        );
        this.allowedNonCanonicalLinks = [];
        if(Array.isArray(config.allowedNonCanonicalLinks)) {
            config.allowedNonCanonicalLinks.forEach(allowed => {
                if(typeof allowed === 'string' && allowed.length > 0) {
                    this.allowedNonCanonicalLinks.push(allowed);
                }
            });
        }
        this.ignoredIssuePatterns = this.compileIgnoredIssuePatterns(config.ignoredIssuePatterns);
    }

    shouldSendEmailReport(): boolean {
        if(!super.shouldSendEmailReport()) {
            return false;
        }
        if(this.issues.length === 0) {
            return false;
        }
        if(this.emailReportTriggerLevels === null || this.emailReportTriggerLevels.length === 0) {
            return true;
        }

        return this.issues.some(issue => this.emailReportTriggerLevels?.indexOf(issue.severity) !== -1);
    }

    getReportTitle(): string {
        return 'Link Issue Report';
    }

    getReportMessage(): string {
        const issues = this.getPrintableIssues();
        if(issues.length === 0) {
            return 'No link issues were detected.';
        }

        const counts = this.getIssueSeverityCounts(issues);
        return `${issues.length} grouped-or-raw link issue records were collected: `
            + `${counts.error} errors, ${counts.warning} warnings, ${counts.notice} notices.`;
    }

    getReportData(): ReportData {
        const issues = this.getPrintableIssues();
        const entries = this.getReportEntries(issues);
        const counts = this.getIssueSeverityCounts(issues);

        return {
            'Scanned Pages': this.scannedPageCount,
            'Reported Issues': issues.length,
            'Grouped Findings': entries.length,
            'Errors': counts.error,
            'Warnings': counts.warning,
            'Notices': counts.notice,
            'External Checks Enabled': this.includeExternal,
            'External URLs Collected': this.externalLinks.size,
            'Asset Checks Enabled': this.includeAssets,
            'Asset URLs Collected': this.assetLinks.size,
            'Notices Included': this.includeNotices
        };
    }

    getReportHtml(): string {
        const issues = this.getPrintableIssues();
        if(issues.length === 0) {
            return '<p style="margin:0;color:#2f6f4e;font-size:14px;">No link issues were detected.</p>';
        }

        const entries = this.getReportEntries(issues);
        const subheadingNotes = this.getSubheadingNotes(entries);
        const sections = this.getEmailReportSections(entries, subheadingNotes);

        return sections.map(section => this.renderEmailReportSection(section)).join('\n');
    }

    onHeadersReceived(_response: AxiosResponse|null, _location: Location) {
        // Header events catch status-level problems even when the crawler skips full body
        // downloads for redirects, errors, or non-HTML resources.
        const status: number = _location.statusCode ?? (_response?.status ?? 0);
        this.statusByUrl.set(_location.url, {status, location: {..._location}});

        if(typeof _location.redirectedTo === 'string') {
            this.redirectSources.set(_location.url, {..._location});
        }

        if(status === 0) {
            this.addIssue({
                severity: 'error',
                group: 'Failed Fetches',
                code: 'fetch-failed',
                message: 'URL failed to fetch after retries.',
                targetUrl: _location.url,
                sourceUrl: _location.referer,
                htmlSnippet: _location.htmlSnippet,
                statusCode: status
            });
            return;
        }

        if(status >= 300 && status < 400) {
            if(status !== 302) {
                this.addIssue({
                    severity: 'warning',
                    group: 'Redirects',
                    code: 'redirect-response',
                    message: `${status} redirect response.`,
                    targetUrl: _location.url,
                    sourceUrl: _location.referer,
                    htmlSnippet: _location.htmlSnippet,
                    statusCode: status,
                    finalUrl: _location.redirectedTo,
                    redirectChain: _location.redirectChain
                });
            }
            return;
        }

        if(status >= 400 && status < 500) {
            this.addIssue({
                severity: 'error',
                group: 'Client Errors',
                code: 'client-error',
                message: `${status} client error response.`,
                targetUrl: _location.url,
                sourceUrl: _location.referer,
                htmlSnippet: _location.htmlSnippet,
                statusCode: status
            });
            return;
        }

        if(status >= 500) {
            this.addIssue({
                severity: 'error',
                group: 'Server Errors',
                code: 'server-error',
                message: `${status} server error response.`,
                targetUrl: _location.url,
                sourceUrl: _location.referer,
                htmlSnippet: _location.htmlSnippet,
                statusCode: status
            });
        }
    }

    onPageReceived(_response: AxiosResponse|null, _pageData: PageData): void {
        if(!_response || typeof _pageData.jsdom === 'undefined') {
            return;
        }
        if(this.isFilteredInternalUrl(_pageData.location.url)) {
            return;
        }

        // Page-level checks need the parsed DOM, raw links, canonical metadata, and anchors
        // gathered by core. Some cross-page checks are deferred until onEnd.
        this.scannedPageCount++;
        const canonicalUrl = this.auditCanonical(_pageData);
        if(this.shouldSkipOutgoingLinkAudit(_pageData, canonicalUrl)) {
            return;
        }

        this.trackLinkOccurrences(_pageData);
        this.trackPageAnchors(_pageData);
        this.auditParseWarnings(_pageData);
        this.auditPageLinks(_pageData);
        this.collectPageAssets(_pageData);
        this.processedPageUrls.add(_pageData.location.url);
    }

    async onEnd() {
        try {
            // End-of-crawl checks need the full site picture: external URL de-dupes,
            // redirect chains, cross-page fragments, and canonical target statuses.
            this.profiler.markJob(this.handle, 'shutdown', 'starting shutdown');
            await this.auditAssetLinks();
            this.profiler.markJob(this.handle, 'shutdown', 'asset link audit complete');
            await this.auditExternalLinks();
            this.profiler.markJob(this.handle, 'shutdown', 'external link audit complete');
            this.auditRedirects();
            this.profiler.markJob(this.handle, 'shutdown', 'redirect audit complete');
            this.auditDeferredFragments();
            this.profiler.markJob(this.handle, 'shutdown', 'fragment audit complete');
            this.auditCanonicalTargets();
            this.profiler.markJob(this.handle, 'shutdown', 'canonical target audit complete');

            this.console.log('Link Issues Report', 'bold');
            this.console.log('------------------', 'bold');

            const printableIssues = this.issues.filter(issue => this.includeNotices || issue.severity !== 'notice');
            this.profiler.markJob(this.handle, 'shutdown', `issue filtering complete (${printableIssues.length} printable issues)`);
            if(printableIssues.length === 0) {
                this.console.log('NO ISSUES DETECTED!', 'green');
            } else if(this.promptOutput) {
                this.reportPromptIssues(printableIssues);
            } else {
                this.reportIssues(printableIssues);
            }
            this.profiler.markJob(this.handle, 'shutdown', 'report output complete');
        } finally {
            this.profiler.markJob(this.handle, 'shutdown', 'shutdown complete');
        }
    }

    private addIssue(issue: LinkIssue): void {
        if(this.shouldSuppressIssue(issue)) {
            return;
        }

        // Store the raw issue, then separately track occurrence data used to group repeated
        // navigation/header/footer findings into one actionable report entry.
        this.issues.push(issue);
        const key = this.getIssueKey(issue);
        const reportKey = this.getReportKey(issue);
        const occurrenceDetails = this.getIssueOccurrenceDetails(issue);
        occurrenceDetails.forEach(occurrence => {
            this.recordIssueOccurrence(key, occurrence.referer, occurrence.zone);
            if(reportKey !== key) {
                this.recordIssueOccurrence(reportKey, occurrence.referer, occurrence.zone);
            }
        });
    }

    private getIssueKey(issue: LinkIssue): string {
        return [
            issue.severity,
            issue.group,
            issue.code,
            issue.targetUrl ?? '',
            issue.normalizedUrl ?? '',
            issue.rawHref ?? '',
            issue.statusCode ?? '',
            issue.assetKind ?? '',
            issue.sourceLabel ?? ''
        ].join('|');
    }

    private shouldSuppressIssue(issue: LinkIssue): boolean {
        return this.isFilteredInternalUrl(issue.sourceUrl)
            || this.isFilteredInternalUrl(issue.targetUrl)
            || this.isFilteredInternalUrl(issue.normalizedUrl)
            || this.isFilteredInternalUrl(issue.finalUrl)
            || this.matchesIgnoredIssuePattern(issue);
    }

    private matchesIgnoredIssuePattern(issue: LinkIssue): boolean {
        if(this.ignoredIssuePatterns.length === 0) {
            return false;
        }

        const candidates = this.getIgnoredIssueUrlCandidates(issue);
        if(candidates.length === 0) {
            return false;
        }

        return this.ignoredIssuePatterns.some(ignore => {
            if(ignore.codes !== null && !ignore.codes.has(issue.code)) {
                return false;
            }
            if(ignore.groups !== null && !ignore.groups.has(issue.group)) {
                return false;
            }
            if(ignore.severities !== null && !ignore.severities.has(issue.severity)) {
                return false;
            }

            return candidates.some(candidate => {
                ignore.pattern.lastIndex = 0;
                return ignore.pattern.test(candidate);
            });
        });
    }

    private getIgnoredIssueUrlCandidates(issue: LinkIssue): string[] {
        const candidates = new Set<string>();
        [
            issue.targetUrl,
            issue.sourceUrl,
            issue.rawHref,
            issue.normalizedUrl,
            issue.pageUrl,
            issue.linkedUrl,
            issue.canonicalUrl,
            issue.expectedCanonicalUrl,
            issue.finalUrl,
            ...(issue.redirectChain ?? [])
        ].forEach(url => {
            if(typeof url !== 'string' || url === '') {
                return;
            }

            candidates.add(url);
            try {
                const parsed = new URL(url, this.baseUrl);
                candidates.add(parsed.href);
                candidates.add(`${parsed.pathname}${parsed.search}`);
                if(this.normalizeHostname(parsed.hostname) === this.baseHostname) {
                    candidates.add(this.normalizeInternalUrl(parsed.href));
                }
            } catch {
                // Keep the raw value as the only candidate.
            }
        });

        return Array.from(candidates);
    }

    private isFilteredInternalUrl(url?: string): boolean {
        if(typeof url !== 'string' || url === '') {
            return false;
        }

        let parsed: URL;
        try {
            parsed = new URL(url, this.baseUrl);
        } catch {
            return false;
        }

        if(this.normalizeHostname(parsed.hostname) !== this.baseHostname) {
            return false;
        }

        const normalizedUrl = this.normalizeInternalUrl(parsed.href);
        return !this.urlHelper.validateLocation(normalizedUrl, 'urlCantContain')
            || !this.urlHelper.validateLocation(normalizedUrl, 'urlMustContain');
    }

    private getReportKey(issue: LinkIssue): string {
        if(reportByCodeOnlyCodes.has(issue.code)) {
            return [
                issue.severity,
                issue.group,
                issue.code,
                issue.statusCode ?? ''
            ].join('|');
        }

        if(reportByRawHrefCodes.has(issue.code)) {
            return [
                issue.severity,
                issue.group,
                issue.code,
                issue.rawHref ?? '',
                issue.htmlSnippet ?? '',
                issue.statusCode ?? ''
            ].join('|');
        }

        return this.getIssueKey(issue);
    }

    private reportIssues(issues: LinkIssue[]): void {
        // Console output groups by severity, report group, and subheading. This keeps
        // hundreds of repeated findings readable during local CLI runs.
        const groups: LinkIssueSeverity[] = ['error', 'warning', 'notice'];
        const labels: Record<LinkIssueSeverity, string> = {
            error: 'ERRORS',
            warning: 'WARNINGS',
            notice: 'NOTICES'
        };
        const themes: Record<LinkIssueSeverity, string> = {
            error: 'red',
            warning: 'yellow',
            notice: 'cyan'
        };
        const reportedWrapperIssues = new Set<string>();
        this.profiler.markJob(this.handle, 'shutdown', `report aggregation starting (${issues.length} issues)`);
        const reportEntries = this.getReportEntries(issues);
        this.profiler.markJob(this.handle, 'shutdown', `report entries aggregated (${reportEntries.length} grouped entries)`);
        const subheadingNotes = this.getSubheadingNotes(reportEntries);
        this.profiler.markJob(this.handle, 'shutdown', `report subheading notes aggregated (${subheadingNotes.size} notes)`);

        groups.forEach(severity => {
            const severityEntries = reportEntries.filter(entry => entry.issue.severity === severity);
            if(severityEntries.length === 0) {
                return;
            }

            this.profiler.markJob(this.handle, 'shutdown', `reporting ${labels[severity]} starting (${severityEntries.length} entries)`);
            let severityHeadingPrinted = false;
            let lastGroup = '';
            let lastSubheading = '';
            severityEntries.forEach(entry => {
                const issue = entry.issue;
                const issueKey = entry.key;
                const wrapperMeta = this.getWrapperMeta(issueKey)
                    ?? (typeof issue.targetUrl === 'string' ? this.getWrapperMeta(issue.targetUrl) : null);
                if(wrapperMeta !== null && reportedWrapperIssues.has(issueKey)) {
                    return;
                }

                if(!severityHeadingPrinted) {
                    this.console.log('', themes[severity]);
                    this.console.log('', themes[severity]);
                    this.reportHeading(labels[severity], themes[severity], 0);
                    this.console.log('', themes[severity]);
                    severityHeadingPrinted = true;
                }

                if(issue.group !== lastGroup) {
                    if(lastGroup !== '') {
                        this.console.log('', themes[severity]);
                    }
                    this.reportHeading(issue.group, themes[severity], 1);
                    this.console.log('', themes[severity]);
                    lastGroup = issue.group;
                    lastSubheading = '';
                }

                const subheading = this.getIssueSubheading(issue);
                if(subheading !== lastSubheading) {
                    this.reportHeading(subheading, themes[severity], 2);
                    const note = subheadingNotes.get(this.getSubheadingKey(issue));
                    if(typeof note === 'string') {
                        this.reportLine(note, themes[severity], 3);
                    }
                    this.console.log('', themes[severity]);
                    lastSubheading = subheading;
                }

                if(wrapperMeta !== null) {
                    reportedWrapperIssues.add(issueKey);
                    this.reportLine(this.formatIssue(entry), themes[severity], 3);
                    this.reportIssueDetails(entry, themes[severity], subheadingNotes.has(this.getSubheadingKey(issue)));
                    this.reportWrapperMeta(wrapperMeta, themes[severity]);
                    this.console.log('', themes[severity]);
                    return;
                }

                this.reportLine(this.formatIssue(entry), themes[severity], 3);
                this.reportIssueDetails(entry, themes[severity], subheadingNotes.has(this.getSubheadingKey(issue)));
                this.reportIssueSources(entry, themes[severity]);
                this.console.log('', themes[severity]);
            });
            this.profiler.markJob(this.handle, 'shutdown', `reporting ${labels[severity]} complete`);
        });
    }

    private getPrintableIssues(): LinkIssue[] {
        return this.issues.filter(issue => this.includeNotices || issue.severity !== 'notice');
    }

    private getIssueSeverityCounts(issues: LinkIssue[]): Record<LinkIssueSeverity, number> {
        return issues.reduce<Record<LinkIssueSeverity, number>>((counts, issue) => {
            counts[issue.severity]++;
            return counts;
        }, {error: 0, warning: 0, notice: 0});
    }

    private getEmailReportSections(
        entries: ReportIssueEntry[],
        subheadingNotes: Map<string, string>
    ): EmailReportSection[] {
        // The email report uses the same grouped entries as console output, but reshapes them
        // into nested sections so template rendering stays simple.
        const severityLabels: Record<LinkIssueSeverity, string> = {
            error: 'Errors',
            warning: 'Warnings',
            notice: 'Notices'
        };
        const sections: EmailReportSection[] = [];
        const reportedWrapperIssues = new Set<string>();

        (['error', 'warning', 'notice'] as LinkIssueSeverity[]).forEach(severity => {
            const severityEntries = entries.filter(entry => entry.issue.severity === severity);
            if(severityEntries.length === 0) {
                return;
            }

            const section: EmailReportSection = {
                severity,
                label: severityLabels[severity],
                groups: []
            };
            const groups = new Map<string, EmailReportGroup>();

            severityEntries.forEach(entry => {
                const issue = entry.issue;
                const wrapperMeta = this.getEntryWrapperMeta(entry);
                if(wrapperMeta !== null && reportedWrapperIssues.has(entry.key)) {
                    return;
                }
                if(wrapperMeta !== null) {
                    reportedWrapperIssues.add(entry.key);
                }

                let group = groups.get(issue.group);
                if(typeof group === 'undefined') {
                    group = {
                        label: issue.group,
                        subsections: []
                    };
                    groups.set(issue.group, group);
                    section.groups.push(group);
                }

                const subheading = this.getIssueSubheading(issue);
                let subsection = group.subsections.find(candidate => candidate.label === subheading);
                if(typeof subsection === 'undefined') {
                    subsection = {
                        label: subheading,
                        note: subheadingNotes.get(this.getSubheadingKey(issue)) ?? '',
                        entries: []
                    };
                    group.subsections.push(subsection);
                }

                subsection.entries.push({
                    entry,
                    details: this.getEmailEntryDetailLines(
                        entry,
                        subheadingNotes.has(this.getSubheadingKey(issue))
                    ),
                    wrapperMeta,
                    sources: this.getEntrySourceLines(entry)
                });
            });

            if(section.groups.length > 0) {
                sections.push(section);
            }
        });

        return sections;
    }

    private getEmailEntryDetailLines(entry: ReportIssueEntry, suppressIssueMessage: boolean): string[] {
        const issue = entry.issue;
        const details: string[] = [];
        if(!suppressIssueMessage
            && (!this.isStatusIssue(issue) || this.shouldShowSubheadingNote(issue))
            && issue.message !== this.formatIssue(entry)) {
            details.push(`Issue: ${issue.message}`);
        }
        if(this.isCanonicalIssue(issue)) {
            return [
                ...details,
                ...this.getCanonicalDetailLines(issue)
            ];
        }
        if(typeof issue.assetKind === 'string') {
            details.push(`Asset kind: ${issue.assetKind}`);
        }
        if(typeof issue.sourceLabel === 'string') {
            details.push(`Source context: ${issue.sourceLabel}`);
        }
        if(typeof issue.rawHref === 'string') {
            details.push(`Raw href: ${issue.rawHref === '' ? '[empty]' : issue.rawHref}`);
        }
        if(typeof issue.htmlSnippet === 'string' && issue.htmlSnippet !== '') {
            details.push(`${this.isAssetIssue(issue) ? 'Source snippet' : 'Anchor HTML'}: ${issue.htmlSnippet}`);
        }
        if(typeof issue.normalizedUrl === 'string' && issue.normalizedUrl !== issue.targetUrl) {
            details.push(`Normalized: ${issue.normalizedUrl}`);
        }
        if(typeof issue.decodedPath === 'string') {
            details.push(`Decoded path: ${issue.decodedPath}`);
        }
        if(typeof issue.finalUrl === 'string' && issue.finalUrl !== '') {
            details.push(`To: ${issue.finalUrl}`);
        }
        if(typeof issue.networkErrorCode === 'string') {
            details.push(`Network error code: ${issue.networkErrorCode}`);
        }
        if(typeof issue.networkErrorMessage === 'string') {
            details.push(`Network error message: ${issue.networkErrorMessage}`);
        }
        if(typeof issue.redirectChain !== 'undefined' && issue.redirectChain.length > 1) {
            details.push(`Chain: ${issue.redirectChain.join(' => ')}`);
        }

        return details;
    }

    private getEntrySourceLines(entry: ReportIssueEntry): string[] {
        return Array.from(entry.sourceUrls).sort((a, b) => a.localeCompare(b));
    }

    private renderEmailReportSection(section: EmailReportSection): string {
        const accent: Record<LinkIssueSeverity, string> = {
            error: '#b42318',
            warning: '#b54708',
            notice: '#175cd3'
        };

        return `
            <div style="margin-top:22px;">
                <h3 style="margin:0 0 12px;font-size:18px;line-height:24px;color:${accent[section.severity]};font-family:Helvetica,Arial,sans-serif;">${this.escapeHtml(section.label)}</h3>
                ${section.groups.map(group => this.renderEmailReportGroup(group, accent[section.severity])).join('\n')}
            </div>
        `;
    }

    private renderEmailReportGroup(group: EmailReportGroup, accent: string): string {
        return `
            <div style="margin:0 0 18px;">
                <h4 style="margin:0 0 10px;font-size:15px;line-height:20px;color:#323232;font-family:Helvetica,Arial,sans-serif;border-bottom:1px solid #dfdfdf;padding-bottom:6px;">${this.escapeHtml(group.label)}</h4>
                ${group.subsections.map(subsection => this.renderEmailReportSubsection(subsection, accent)).join('\n')}
            </div>
        `;
    }

    private renderEmailReportSubsection(subsection: EmailReportSubsection, accent: string): string {
        return `
            <div style="margin:0 0 16px 12px;">
                <h5 style="margin:0 0 6px;font-size:14px;line-height:20px;color:${accent};font-family:Helvetica,Arial,sans-serif;">${this.escapeHtml(subsection.label)}</h5>
                ${subsection.note !== '' ? `<p style="margin:0 0 10px;color:#555;font-size:13px;line-height:19px;font-family:Helvetica,Arial,sans-serif;">${this.linkifyHtml(subsection.note)}</p>` : ''}
                ${subsection.entries.map(emailEntry => this.renderEmailReportEntry(emailEntry)).join('\n')}
            </div>
        `;
    }

    private renderEmailReportEntry(emailEntry: EmailReportEntry): string {
        const entry = emailEntry.entry;
        const details = emailEntry.details
            .map(detail => `<li style="margin:0 0 4px;">${this.linkifyHtml(detail)}</li>`)
            .join('');

        return `
            <div style="margin:0 0 14px;padding:12px 14px;border:1px solid #e2e2e2;border-radius:6px;background:#fbfbfb;">
                <p style="margin:0 0 8px;font-size:13px;line-height:19px;color:#222;font-family:Helvetica,Arial,sans-serif;font-weight:bold;word-break:break-word;">${this.linkifyHtml(this.formatIssue(entry))}</p>
                ${details !== '' ? `<ul style="margin:0 0 8px 18px;padding:0;color:#555;font-size:12px;line-height:18px;font-family:Helvetica,Arial,sans-serif;">${details}</ul>` : ''}
                ${emailEntry.wrapperMeta !== null ? this.renderEmailWrapperMeta(emailEntry.wrapperMeta) : this.renderEmailSources(entry, emailEntry.sources)}
            </div>
        `;
    }

    private renderEmailWrapperMeta(meta: WrapperMeta): string {
        const percent = Math.round(meta.wrapperPagePercent * 100);
        const label = meta.inferredSharedLayout
            ? 'Repeated issue: likely shared layout/template'
            : `Wrapper link: likely ${meta.topWrapperZone}`;
        const samples = Array.from(meta.pageUrls).slice(0, 3);
        const sampleItems = samples
            .map(sample => `<li style="margin:0 0 3px;word-break:break-word;">${this.linkifyHtml(sample)}</li>`)
            .join('');

        return `
            <p style="margin:0 0 6px;color:#555;font-size:12px;line-height:18px;font-family:Helvetica,Arial,sans-serif;">
                ${this.escapeHtml(label)}; found on ${meta.pageUrls.size} of ${this.scannedPageCount} scanned pages (${percent}%), ${meta.occurrenceCount} occurrences.
            </p>
            ${sampleItems !== '' ? `
                <p style="margin:0 0 4px;color:#555;font-size:12px;line-height:18px;font-family:Helvetica,Arial,sans-serif;">Sample referers:</p>
                <ul style="margin:0 0 0 18px;padding:0;color:#555;font-size:12px;line-height:18px;font-family:Helvetica,Arial,sans-serif;">${sampleItems}</ul>
            ` : ''}
        `;
    }

    private renderEmailSources(entry: ReportIssueEntry, sources: string[]): string {
        if(sources.length === 0) {
            return '';
        }

        const pageLabel = sources.length === 1 ? 'page' : 'pages';
        const occurrenceLabel = entry.count === 1 ? 'occurrence' : 'occurrences';
        const sourceItems = sources
            .map(source => `<li style="margin:0 0 3px;word-break:break-word;">${this.linkifyHtml(source)}</li>`)
            .join('');

        return `
            <p style="margin:0 0 4px;color:#555;font-size:12px;line-height:18px;font-family:Helvetica,Arial,sans-serif;">
                Found on ${sources.length} ${pageLabel} (${entry.count} ${occurrenceLabel}):
            </p>
            <ul style="margin:0 0 0 18px;padding:0;color:#555;font-size:12px;line-height:18px;font-family:Helvetica,Arial,sans-serif;">${sourceItems}</ul>
        `;
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private linkifyHtml(value: string): string {
        // Escape everything first, then reinsert safe URL anchors so report emails remain
        // readable without trusting arbitrary crawled markup.
        const urlPattern = /https?:\/\/[^\s<>"']+/gi;
        let html = '';
        let lastIndex = 0;

        value.replace(urlPattern, (match, offset: number) => {
            html += this.escapeHtml(value.slice(lastIndex, offset));

            const trailing = match.match(/[),.;:!?]+$/)?.[0] ?? '';
            const url = trailing !== '' ? match.slice(0, -trailing.length) : match;
            html += `<a href="${this.escapeHtml(url)}" style="color:#4d4d4d;text-decoration:underline !important;">${this.escapeHtml(url)}</a>`;
            html += this.escapeHtml(trailing);
            lastIndex = offset + match.length;
            return match;
        });

        html += this.escapeHtml(value.slice(lastIndex));
        return html;
    }

    private reportPromptIssues(issues: LinkIssue[]): void {
        // Prompt output is intentionally grouped into focused work packages that can be
        // copied into another coding agent without pasting the entire report.
        this.profiler.markJob(this.handle, 'shutdown', `prompt aggregation starting (${issues.length} issues)`);
        const reportEntries = this.getReportEntries(issues);
        this.profiler.markJob(this.handle, 'shutdown', `prompt report entries aggregated (${reportEntries.length} grouped entries)`);
        const sections = this.getPromptSections(reportEntries);
        this.profiler.markJob(this.handle, 'shutdown', `prompt sections aggregated (${sections.length} sections)`);
        let noticeIntroPrinted = false;
        sections.forEach((section, index) => {
            this.profiler.markJob(this.handle, 'shutdown',
                `prompt section output starting (${index + 1}/${sections.length}): ${this.getPromptSectionSeverityLabel(section)} / ${section.group}`
            );
            if(index > 0) {
                this.console.log('', 'white');
                this.console.log('', 'white');
            }

            if(section.severity === 'notice' && !noticeIntroPrinted) {
                this.console.log('NOTICE PROMPTS', 'cyan.bold');
                this.console.log('--------------', 'cyan.bold');
                this.console.log('Notice-level prompts are optional cleanup items; copy only the sections you want addressed.', 'cyan');
                this.console.log('', 'cyan');
                noticeIntroPrinted = true;
            }

            const title = `PROMPT: ${this.getPromptSectionSeverityLabel(section)} / ${section.group}`;
            this.console.log(title, 'white.bold');
            this.console.log('-'.repeat(title.length), 'white.bold');
            this.console.log('----- BEGIN PROMPT -----', 'white.bold');
            this.console.log(this.buildPromptText(section), 'white');
            this.console.log('----- END PROMPT -----', 'white.bold');
            this.profiler.markJob(this.handle, 'shutdown',
                `prompt section output complete (${index + 1}/${sections.length}): ${this.getPromptSectionSeverityLabel(section)} / ${section.group}`
            );
        });
    }

    private getPromptSections(entries: ReportIssueEntry[]): PromptSection[] {
        const sections = new Map<string, PromptSection>();
        entries.forEach(entry => {
            const issue = entry.issue;
            const key = this.getPromptSectionKey(issue);
            let section = sections.get(key);
            if(typeof section === 'undefined') {
                section = {
                    severity: issue.severity,
                    group: issue.group,
                    entries: []
                };
                sections.set(key, section);
            }
            section.severity = this.getHighestPromptSeverity(section.severity, issue.severity);
            section.entries.push(entry);
        });

        const severityOrder: Record<LinkIssueSeverity, number> = {
            error: 0,
            warning: 1,
            notice: 2
        };
        return Array.from(sections.values()).sort((a, b) => {
            const severitySort = severityOrder[a.severity] - severityOrder[b.severity];
            if(severitySort !== 0) {
                return severitySort;
            }
            const groupSort = this.getGroupSort(a.group) - this.getGroupSort(b.group);
            if(groupSort !== 0) {
                return groupSort;
            }
            return a.group.localeCompare(b.group);
        });
    }

    private getPromptSectionKey(issue: LinkIssue): string {
        if(issue.group === 'Unsafe Link Protocols') {
            return `combined|${issue.group}`;
        }

        return `${issue.severity}|${issue.group}`;
    }

    private getHighestPromptSeverity(current: LinkIssueSeverity, next: LinkIssueSeverity): LinkIssueSeverity {
        const severityOrder: Record<LinkIssueSeverity, number> = {
            error: 0,
            warning: 1,
            notice: 2
        };
        return severityOrder[next] < severityOrder[current] ? next : current;
    }

    private buildPromptText(section: PromptSection): string {
        const assetSection = section.group === 'Asset Links' || section.group === 'Asset Security';
        const lines: string[] = [
            'You are working in a website or application codebase.',
            `An Arachnodex link issue report found ${section.entries.length} grouped finding(s) for this section.`,
            `Site/base URL: ${this.baseUrl}`,
            `Section: ${this.getPromptSectionSeverityLabel(section)} / ${section.group}`,
            `Included issue types: ${this.getPromptIssueTypeLabels(section).join(', ')}`,
            '',
            'Goal:',
            '- Find the code, template, CMS content, data, or configuration that creates these links/issues.',
            '- Fix only the listed issues for this section.',
        ];
        if(assetSection) {
            lines.push(
                '- Use each finding\'s asset kind, source context, raw URL, normalized URL, and source snippet to locate the generating markup, CSS, JavaScript, CMS field, or data source.',
                '- Preserve existing rendering, loading order, responsive image behavior, embed behavior, and cache/versioning conventions.',
                '- Preserve existing behavior and avoid unrelated refactors.',
                '- After making changes, run the project checks and rerun the link issue report if available.'
            );
        } else {
            lines.push(
                '- Before changing markup, determine whether each listed anchor is true navigation or a UI/action trigger.',
                '- If JavaScript event handlers, dropdown behavior, modal triggers, tabs, accordions, or similar UI behavior are attached, preserve that behavior while using the semantically correct element.',
                '- Preserve existing behavior and avoid unrelated refactors.',
                '- After making changes, run the project checks and rerun the link issue report if available.'
            );
        }

        const note = this.getPromptSectionNote(section);
        if(note !== '') {
            lines.push(`Section note: ${note}`, '');
        }

        const guidance = this.getPromptSectionGuidance(section);
        if(guidance.length > 0) {
            lines.push('How to approach this fix:');
            guidance.forEach(item => {
                lines.push(`- ${item}`);
            });
            lines.push('');
        }

        lines.push('Findings:');

        const includeIssueType = this.hasMultiplePromptIssueTypes(section);
        const includeSeverity = this.hasMultiplePromptSeverities(section);
        section.entries.forEach((entry, index) => {
            lines.push(`${index + 1}. ${this.formatPromptEntryTitle(entry)}`);
            const wrapperMeta = this.getEntryWrapperMeta(entry);
            this.getPromptEntryDetails(entry, note, includeIssueType, includeSeverity).forEach(detail => {
                lines.push(`   ${detail}`);
            });

            if(wrapperMeta !== null) {
                this.getPromptWrapperDetails(wrapperMeta).forEach(detail => {
                    lines.push(`   ${detail}`);
                });
                lines.push('');
                return;
            }

            const sources = Array.from(entry.sourceUrls).sort((a, b) => a.localeCompare(b));
            if(sources.length > 0) {
                const pageLabel = sources.length === 1 ? 'page' : 'pages';
                const occurrenceLabel = entry.count === 1 ? 'occurrence' : 'occurrences';
                lines.push(`   Found on ${sources.length} ${pageLabel} (${entry.count} ${occurrenceLabel}):`);
                sources.forEach(source => {
                    lines.push(`   - ${source}`);
                });
            }
            lines.push('');
        });

        return lines.join('\n').trimEnd();
    }

    private getPromptIssueTypeLabels(section: PromptSection): string[] {
        return Array.from(new Set(section.entries.map(entry => this.getIssueSubheading(entry.issue))));
    }

    private getPromptSectionSeverityLabel(section: PromptSection): string {
        const severities = this.getPromptSectionSeverities(section);
        return severities.map(severity => severity.toUpperCase()).join('+');
    }

    private getPromptSectionSeverities(section: PromptSection): LinkIssueSeverity[] {
        const severityOrder: Record<LinkIssueSeverity, number> = {
            error: 0,
            warning: 1,
            notice: 2
        };
        return Array.from(new Set(section.entries.map(entry => entry.issue.severity)))
            .sort((a, b) => severityOrder[a] - severityOrder[b]);
    }

    private hasMultiplePromptIssueTypes(section: PromptSection): boolean {
        return this.getPromptIssueTypeLabels(section).length > 1;
    }

    private hasMultiplePromptSeverities(section: PromptSection): boolean {
        return this.getPromptSectionSeverities(section).length > 1;
    }

    private getPromptSectionGuidance(section: PromptSection): string[] {
        // When several issue types share a section, merge matching guidance so the prompt
        // stays direct instead of repeating the same instruction for each finding.
        const guidanceByText = new Map<string, { labels: string[]; guidance: string[] }>();
        section.entries.forEach(entry => {
            const label = this.getIssueSubheading(entry.issue);
            const issueGuidance = this.getPromptGuidanceForIssue(entry.issue);
            if(issueGuidance.length === 0) {
                return;
            }

            const guidanceText = issueGuidance.join(' ');
            const groupedGuidance = guidanceByText.get(guidanceText) ?? {labels: [], guidance: issueGuidance};
            if(groupedGuidance.labels.indexOf(label) === -1) {
                groupedGuidance.labels.push(label);
                guidanceByText.set(guidanceText, groupedGuidance);
            }
        });

        if(guidanceByText.size === 0) {
            return [];
        }

        if(guidanceByText.size === 1) {
            return Array.from(guidanceByText.values())[0].guidance;
        }

        const guidance = [
            `Treat these as one ${section.group.toLowerCase()} work package, but keep the fix for each issue type scoped to the listed findings.`
        ];
        guidanceByText.forEach(({labels}, guidanceText) => {
            guidance.push(`${labels.join(', ')}: ${guidanceText}`);
        });

        return guidance;
    }

    private getPromptGuidanceForIssue(issue: LinkIssue): string[] {
        const status = typeof issue.statusCode === 'number' && issue.statusCode > 0
            ? `${issue.statusCode} `
            : '';

        switch(issue.code) {
            case 'client-error':
                return [
                    `Each listed URL returned a ${status}client error when crawled.`,
                    'Find the links on the listed source pages and update them to a working URL, restore the missing target, or remove the link if it is no longer valid.',
                    'Prefer fixing the source href/content instead of adding redirects unless a redirect is the intended permanent site behavior.'
                ];
            case 'server-error':
                return [
                    `Each listed URL returned a ${status}server error when crawled.`,
                    'Inspect the route/controller/template/server logs for the target URL and fix the underlying server-side failure.',
                    'After the page returns a normal 2xx response, confirm the listed source pages still link to the intended destination.'
                ];
            case 'fetch-failed':
                return [
                    'These internal URLs did not fetch successfully after the crawler exhausted its retry limit.',
                    'Check whether the URL is slow, blocked, intermittently failing, or generated incorrectly from the listed source page.',
                    'Fix broken href generation when applicable; otherwise verify server timeout/protection behavior for that route.'
                ];
            case 'redirect-response':
                return [
                    `The listed linked URLs return ${status}redirect responses.`,
                    'Update source links to point directly at the final canonical destination when the redirect is not intentionally required.',
                    'For permanent redirects, prefer the final URL in templates/content so users and crawlers avoid an extra hop.'
                ];
            case 'redirect-chain':
                return [
                    'The listed redirect starts a chain with multiple hops.',
                    'Update the source link or redirect rules so the first URL points directly to the final canonical destination.',
                    'Avoid preserving intermediate redirects unless they are required for application behavior.'
                ];
            case 'redirect-loop':
                return [
                    'The listed redirect chain appears to loop.',
                    'Inspect route, rewrite, canonicalization, and trailing-slash rules for the URLs in the chain.',
                    'Fix the loop so the URL resolves to one final 2xx destination.'
                ];
            case 'redirect-final-target-failed':
                return [
                    'The linked URL redirects, but the final destination failed to fetch.',
                    'Fix the final target first, or change the source link/redirect rule to a working destination.',
                    'Do not treat the redirect itself as healthy until the final URL returns a valid response.'
                ];
            case 'redirect-final-target-non-canonical':
                return [
                    'The temporary redirect resolves to a non-canonical URL.',
                    'Update the redirect target or source link to use the canonical URL directly.',
                    'If the redirect performs an intentional action, keep the behavior but make the final landing page canonical.'
                ];
            case 'external-redirect':
                return [
                    'These external links returned redirect responses to HEAD checks.',
                    'Replace the href with the final public destination when stable, or leave intentional third-party redirects alone after verification.',
                    'To suppress known intentional third-party redirects, add an ignoredIssuePatterns entry with codes ["external-redirect"] and a urlPattern matching that destination, for example {"codes":["external-redirect"],"urlPattern":"^https?://example\\\\.com/(?:[?#/].*)?$"}.',
                    'Use a browser or curl to confirm the target because some external services handle HEAD differently than GET.'
                ];
            case 'external-error':
                return [
                    `These external links returned ${status}error responses to crawler checks.`,
                    'Verify the URL in a browser, then update it to a reachable destination or remove it if the resource is gone.',
                    'If the site blocks automated checks but works for users, document that decision before suppressing it with an ignoredIssuePatterns entry using codes ["external-error"] and a urlPattern matching that destination, for example {"codes":["external-error"],"urlPattern":"^https?://example\\\\.com/(?:[?#/].*)?$"}.'
                ];
            case 'external-bot-protection':
                return [
                    'These external links returned bot protection or edge security responses to crawler checks.',
                    'Verify the URL in a browser before changing site content; these notices usually mean the third-party site rejected automated verification rather than the link being broken.',
                    'To keep expected protected destinations out of notice output, add an ignoredIssuePatterns entry with codes ["external-bot-protection"] and a urlPattern matching that destination.'
                ];
            case 'external-http-upgrade-available':
                return [
                    'These external HTTP links failed, but the same URL works over HTTPS.',
                    'Update the source href from the listed HTTP URL to the HTTPS URL shown in the To field.',
                    'This usually means the external site supports HTTPS but does not redirect failed HTTP requests.'
                ];
            case 'external-dns-temporary-failure':
                return [
                    'The crawler could not verify these external links because DNS lookup returned EAI_AGAIN, which means the local resolver reported a temporary name-resolution failure.',
                    'Before changing site code or removing the link, verify the URL from the target project environment with a command such as `curl -I <url>` or `curl -L -I <url>`.',
                    'If curl/browser verification succeeds and the destination is expected to keep failing in this crawler environment, suppress only that finding with an ignoredIssuePatterns entry using codes ["external-dns-temporary-failure"] and a urlPattern matching that destination.',
                    'If it fails from a normal shell too, investigate the hostname, DNS records, or network resolver.'
                ];
            case 'external-fetch-failed':
                return [
                    'These external links did not respond to the crawler HEAD request.',
                    'Verify each target manually; replace dead URLs, remove obsolete links, or keep working URLs that merely block automated checks.',
                    'To keep verified HEAD-blocking destinations out of future prompts, add an ignoredIssuePatterns entry with codes ["external-fetch-failed"] and a urlPattern matching that destination.',
                    'Avoid changing working third-party URLs solely because their server rejects HEAD requests.'
                ];
            case 'asset-redirect':
                return [
                    'These asset URLs returned redirect responses to HEAD checks.',
                    'Update the source tag, CSS, JavaScript, or data value to point directly at the final stable asset URL when the redirect is not intentional.',
                    'If the redirect is expected, suppress only that asset destination with an ignoredIssuePatterns entry using codes ["asset-redirect"].'
                ];
            case 'asset-error':
                return [
                    `These asset URLs returned ${status}error responses to HEAD checks.`,
                    'Update or remove the referenced asset URL, restore the missing asset, or fix the server route that should serve it.',
                    'Use the source context and snippet to patch the generating template, CSS, JavaScript, CMS field, or data source.'
                ];
            case 'asset-http-upgrade-available':
                return [
                    'These HTTP asset URLs failed, but the same URL works over HTTPS.',
                    'Replace the source HTTP reference with the HTTPS URL shown in the To field.',
                    'Prefer HTTPS or root-relative asset generation on HTTPS sites.'
                ];
            case 'asset-dns-temporary-failure':
                return [
                    'The crawler could not verify these asset URLs because DNS lookup returned EAI_AGAIN.',
                    'Verify the asset URL from the target project environment before changing markup.',
                    'If the destination is expected to fail in this crawler environment, suppress only that finding with an ignoredIssuePatterns entry using codes ["asset-dns-temporary-failure"].'
                ];
            case 'asset-fetch-failed':
                return [
                    'These asset URLs did not respond to a HEAD request.',
                    'Verify the asset in a browser or with curl, then update or remove dead references.',
                    'Avoid downloading large media just to verify this report; fix the source reference or server availability.'
                ];
            case 'asset-bot-protection':
                return [
                    'These asset URLs returned bot protection or edge security responses to crawler checks.',
                    'Verify browser accessibility before changing content; these notices often mean automated HEAD checks were rejected.',
                    'To keep expected protected assets out of notice output, add an ignoredIssuePatterns entry with codes ["asset-bot-protection"] and a matching urlPattern.'
                ];
            case 'insecure-asset-url':
                return [
                    'These asset references use HTTP or protocol-relative URLs during an HTTPS crawl.',
                    'Replace them with HTTPS URLs or root-relative paths from the source tag, CSS, JavaScript, CMS field, or data value.',
                    'Check shared asset base URL configuration if many assets share the same insecure host.'
                ];
            case 'iframe-missing-sandbox':
                return [
                    'These iframe embeds do not declare a sandbox policy.',
                    'Add the narrowest intentional sandbox attribute that preserves the embed behavior, or document and suppress the finding if the provider cannot support it.',
                    'Avoid granting broad permissions unless the embed requires them.'
                ];
            case 'iframe-missing-referrerpolicy':
                return [
                    'These iframe embeds do not declare a referrerpolicy.',
                    'Add an intentional referrerpolicy value that matches privacy and analytics requirements.',
                    'Common choices are no-referrer, strict-origin, or strict-origin-when-cross-origin depending on project policy.'
                ];
            case 'malformed-asset-url':
                return [
                    'These asset URL values could not be parsed safely.',
                    'Fix invalid percent encoding, bad URL syntax, or malformed template/CSS/JS output in the listed source context.',
                    'Do not leave malformed asset references in place even if one browser appears to recover from them.'
                ];
            case 'unsupported-asset-protocol':
                return [
                    'These asset references use protocols that this checker cannot safely verify as web assets.',
                    'Replace file:, javascript:, vbscript:, or other unsupported protocols with normal HTTP(S) asset URLs when the reference is meant to load a resource.',
                    'If the value is generated behavior rather than a fetchable asset, remove it from asset-loading markup or suppress the specific intentional finding.'
                ];
            case 'missing-canonical':
                return [
                    'These pages do not include a canonical link tag.',
                    'Add one canonical URL per page in the document head, using the Expected/preferred canonical URL as the likely intended value unless project routing rules indicate another canonical.',
                    'Make sure generated canonicals match the site policy for scheme, host, path, and trailing slash.'
                ];
            case 'multiple-canonicals':
                return [
                    'These pages render more than one canonical link tag.',
                    'Use the All canonical href values found list to identify the competing values, then find all template, plugin, CMS, or SEO-module sources that emit canonicals and leave exactly one canonical tag.',
                    'The remaining canonical should point to the Expected/preferred canonical URL unless project routing rules indicate another canonical.'
                ];
            case 'empty-canonical':
                return [
                    'These pages render a canonical tag with an empty href.',
                    'Fix the canonical generation data/path so href is a valid absolute URL, usually the Expected/preferred canonical URL, or remove the empty tag and let the correct tag render.',
                    'Check for missing CMS fields or route data used by the SEO template.'
                ];
            case 'malformed-canonical':
                return [
                    'These pages render a canonical href that could not be parsed as a valid URL.',
                    'Fix invalid encoding, bad characters, or malformed template output in the canonical tag.',
                    'Canonical href values should be valid absolute URLs, usually matching the Expected/preferred canonical URL.'
                ];
            case 'offsite-canonical':
                return [
                    'These pages canonicalize to a different hostname.',
                    'Compare the Current canonical value to the Page URL and Expected/preferred canonical URL; confirm whether cross-domain canonicalization is intentional.',
                    'If it is not intentional, update SEO/base URL configuration or page metadata.',
                    'For normal internal pages, the canonical should use the crawled site hostname.'
                ];
            case 'http-canonical':
                return [
                    'These pages canonicalize to HTTP while the crawl is using HTTPS.',
                    'Update canonical generation from the Current canonical value to the Expected/preferred canonical URL using HTTPS.',
                    'Check global site URL, environment, proxy, and SEO configuration values.'
                ];
            case 'canonical-target-failed':
                return [
                    'The canonical URL for these pages failed to fetch.',
                    'Fix the Current canonical value to point at a working page, or restore the listed canonical target URL if it is the intended canonical.',
                    'A canonical should not point to a missing, blocked, or failing resource.'
                ];
            case 'canonical-target-redirects':
                return [
                    'The canonical URL for these pages redirects.',
                    'Update the Current canonical value to the Expected/preferred canonical URL so the canonical points directly at the final destination.',
                    'Canonical tags should avoid redirects where possible.'
                ];
            case 'non-canonical-internal-link':
                return [
                    'These internal links point to a URL that differs from the target page canonical.',
                    'Update the href in navigation, templates, CMS content, or data from the Linked URL found in source to the Expected/preferred canonical URL.',
                    'For wrapper links, fix the shared layout/navigation source rather than editing individual pages.'
                ];
            case 'canonical-query-variant':
                return [
                    'These internal links include a query string while the target page canonical points to the same URL without that query string.',
                    'Confirm the query string represents intentional UI state, campaign data, or an action trigger rather than distinct indexable content.',
                    'If the query variant is expected, add an ignoredIssuePatterns entry using codes ["canonical-query-variant"] and a urlPattern that matches the path/query form, for example {"codes":["canonical-query-variant"],"urlPattern":"^/\\\\?catalog-request$"}.'
                ];
            case 'malformed-href':
                return [
                    'These href values could not be parsed safely.',
                    'Fix invalid percent encoding, bad URL syntax, or malformed template/CMS output at the listed source pages.',
                    'Do not leave malformed hrefs in place even if browsers appear to recover from them.'
                ];
            case 'control-character-href':
                return [
                    'These href values contain control characters.',
                    'Remove hidden characters, line-break artifacts, or bad copy/paste content from the source href.',
                    'Regenerate the URL from clean data when the value is produced by code.'
                ];
            case 'undesirable-path-character':
                return [
                    'These links contain decoded URL path characters outside the configured preferred pattern.',
                    'Prefer lowercase/uppercase letters, digits, underscores, hyphens, forward slashes, and dots in path segments unless the project intentionally allows more.',
                    'Replace spaces and other punctuation with hyphens or update the configured undesirablePathCharacterPattern if the project has a different URL policy.'
                ];
            case 'javascript-href':
                return [
                    'These anchors use javascript: href values.',
                    'First inspect the markup, scripts, delegated event listeners, data attributes, ARIA attributes, and surrounding UI to determine whether each anchor is real navigation or a JavaScript-driven action/control.',
                    'If the element is true navigation, replace the javascript: href with the correct real URL and preserve any unobtrusive event handling.',
                    'If the element opens a dropdown, toggles UI, launches a modal, submits an action, switches tabs, or otherwise depends on a click handler rather than navigating, convert it to a button or other semantically correct control and keep the existing behavior/accessibility intact.',
                    'Do not invent destination URLs for JavaScript-driven controls just to remove the report finding.'
                ];
            case 'vbscript-href':
                return [
                    'These anchors use vbscript: href values.',
                    'Inspect the markup and attached JavaScript before changing the element so real navigation and UI controls are handled differently.',
                    'If the element is true navigation, replace the unsafe protocol with the correct real URL.',
                    'If the element is a JavaScript-driven control, convert it to a button or other semantically correct control and preserve the existing behavior/accessibility.',
                    'Treat this as a security issue, especially if content can be user-controlled.'
                ];
            case 'non-web-protocol':
                return [
                    'These anchors use data:, file:, blob:, or another non-web href protocol.',
                    'First inspect whether each link is true navigation, a download/generator flow, or a JavaScript-driven UI/action control.',
                    'If it is true navigation, replace it with a normal http/https URL or route when one exists.',
                    'If it is an action/control or generated asset flow, use the semantically correct element and preserve the existing behavior instead of inventing a destination URL.',
                    'Avoid exposing local file paths or generated blob/data links as persistent navigation.'
                ];
            case 'insecure-internal-link':
                return [
                    'These internal links use HTTP or protocol-relative URLs during an HTTPS crawl.',
                    'Update hrefs and URL generation config to emit HTTPS absolute URLs or root-relative paths.',
                    'Check shared base URL settings if many links have the same issue.'
                ];
            case 'missing-same-page-fragment':
                return [
                    'These same-page fragment links point to an id/name that was not found on the page.',
                    'Update the href fragment to match an existing id/name, or add the missing anchor target.',
                    'Watch for case differences and generated heading IDs.'
                ];
            case 'missing-cross-page-fragment':
                return [
                    'These cross-page fragment links point to an id/name missing from the linked page.',
                    'Update the fragment to the target page actual id/name, add the missing anchor, or remove the fragment.',
                    'Confirm the base linked page is the intended destination before changing the fragment.'
                ];
            case 'target-blank-rel':
                return [
                    'These links open a new tab/window without rel protection.',
                    'Add rel="noopener" or rel="noreferrer" to target="_blank" links, especially external links.',
                    'If preserving referrer analytics matters, prefer noopener; use noreferrer when hiding the referrer is desired.'
                ];
            case 'missing-href':
                return [
                    'These anchor tags do not have an href attribute.',
                    'Use a real href for navigation, or change non-navigation controls to buttons.',
                    'Avoid empty anchors used only for click handlers unless there is an accessible fallback.'
                ];
            case 'empty-href':
                return [
                    'These anchor tags have an empty href.',
                    'Replace with the intended URL, remove the link, or use a button for non-navigation actions.',
                    'Check CMS fields or template variables that may be rendering blank.'
                ];
            case 'hash-placeholder':
                return [
                    'These anchor tags use placeholder fragment hrefs.',
                    'Replace with a real URL/fragment when navigation is intended, or use a button for UI-only actions.',
                    'Check whether the placeholder affects usability, accessibility, or maintainability before changing intentional UI behavior.'
                ];
            default:
                return [
                    'Use the listed target/raw href and source pages to locate where the issue is generated.',
                    'Fix the source of the generated link or metadata rather than patching report output.',
                    'Keep the change scoped to the listed issue type.'
                ];
        }
    }

    private getEntryWrapperMeta(entry: ReportIssueEntry): WrapperMeta|null {
        return this.getWrapperMeta(entry.key)
            ?? (typeof entry.issue.targetUrl === 'string' ? this.getWrapperMeta(entry.issue.targetUrl) : null);
    }

    private getPromptSectionNote(section: PromptSection): string {
        const messages = new Set<string>();
        section.entries.forEach(entry => {
            const issue = entry.issue;
            if(issue.message !== this.formatIssue(entry)) {
                messages.add(issue.message);
            }
        });

        return messages.size === 1 ? Array.from(messages)[0] : '';
    }

    private formatPromptEntryTitle(entry: ReportIssueEntry): string {
        const issue = entry.issue;
        if(this.isCanonicalIssue(issue)) {
            return this.formatIssue(entry);
        }
        if(this.isStatusIssue(issue) && typeof issue.statusCode === 'number') {
            return `${issue.statusCode}: ${issue.targetUrl ?? issue.rawHref ?? issue.message}`;
        }
        if(typeof issue.targetUrl === 'string') {
            return issue.targetUrl;
        }
        if(typeof issue.rawHref === 'string') {
            return `${this.humanizeCode(issue.code)}: ${issue.rawHref === '' ? '[empty]' : issue.rawHref}`;
        }
        return issue.message;
    }

    private getPromptEntryDetails(
        entry: ReportIssueEntry,
        sectionNote: string,
        includeIssueType: boolean,
        includeSeverity: boolean
    ): string[] {
        const issue = entry.issue;
        const details: string[] = [];
        if(includeSeverity) {
            details.push(`Severity: ${issue.severity}`);
        }
        if(includeIssueType) {
            details.push(`Issue type: ${this.getIssueSubheading(issue)}`);
        }
        const issueMessage = issue.message !== this.formatIssue(entry) ? issue.message : '';
        if(issueMessage !== '' && issueMessage !== sectionNote) {
            details.push(`Issue: ${issueMessage}`);
        }
        if(this.isCanonicalIssue(issue)) {
            return [
                ...details,
                ...this.getCanonicalDetailLines(issue)
            ];
        }
        if(typeof issue.assetKind === 'string') {
            details.push(`Asset kind: ${issue.assetKind}`);
        }
        if(typeof issue.sourceLabel === 'string') {
            details.push(`Source context: ${issue.sourceLabel}`);
        }
        if(typeof issue.rawHref === 'string') {
            details.push(`Raw href: ${issue.rawHref === '' ? '[empty]' : issue.rawHref}`);
        }
        if(typeof issue.htmlSnippet === 'string' && issue.htmlSnippet !== '') {
            details.push(`${this.isAssetIssue(issue) ? 'Source snippet' : 'Anchor HTML'}: ${issue.htmlSnippet}`);
        }
        if(typeof issue.normalizedUrl === 'string' && issue.normalizedUrl !== issue.targetUrl) {
            details.push(`Normalized: ${issue.normalizedUrl}`);
        }
        if(typeof issue.decodedPath === 'string') {
            details.push(`Decoded path: ${issue.decodedPath}`);
        }
        if(typeof issue.finalUrl === 'string' && issue.finalUrl !== '') {
            details.push(`To: ${issue.finalUrl}`);
        }
        if(typeof issue.networkErrorCode === 'string') {
            details.push(`Network error code: ${issue.networkErrorCode}`);
        }
        if(typeof issue.networkErrorMessage === 'string') {
            details.push(`Network error message: ${issue.networkErrorMessage}`);
        }
        if(typeof issue.redirectChain !== 'undefined' && issue.redirectChain.length > 1) {
            details.push(`Chain: ${issue.redirectChain.join(' => ')}`);
        }

        return details;
    }

    private getPromptWrapperDetails(meta: WrapperMeta): string[] {
        const percent = Math.round(meta.wrapperPagePercent * 100);
        const label = meta.inferredSharedLayout
            ? 'Repeated issue: likely shared layout/template'
            : `Wrapper link: likely ${meta.topWrapperZone}`;
        const lines = [
            `${label}; found on `
                + `${meta.pageUrls.size} of ${this.scannedPageCount} scanned pages `
                + `(${percent}%), ${meta.occurrenceCount} occurrences.`
        ];
        const samples = Array.from(meta.pageUrls).slice(0, 3);
        if(samples.length > 0) {
            lines.push('Sample referers:');
            samples.forEach(sample => {
                lines.push(`- ${sample}`);
            });
        }
        return lines;
    }

    private getSubheadingNotes(entries: ReportIssueEntry[]): Map<string, string> {
        const messages = new Map<string, Set<string>>();
        entries.forEach(entry => {
            const issue = entry.issue;
            if(this.isStatusIssue(issue) && !this.shouldShowSubheadingNote(issue)) {
                return;
            }
            if(issue.message === this.formatIssue(entry)) {
                return;
            }

            const key = this.getSubheadingKey(issue);
            let messageSet = messages.get(key);
            if(typeof messageSet === 'undefined') {
                messageSet = new Set<string>();
                messages.set(key, messageSet);
            }
            messageSet.add(issue.message);
        });

        const notes = new Map<string, string>();
        messages.forEach((messageSet, key) => {
            if(messageSet.size === 1) {
                notes.set(key, Array.from(messageSet)[0]);
            }
        });

        return notes;
    }

    private getSubheadingKey(issue: LinkIssue): string {
        return `${issue.severity}|${issue.group}|${this.getIssueSubheading(issue)}`;
    }

    private reportHeading(label: string, theme: string, depth: number): void {
        this.reportLine(label, `${theme}.bold`, depth);
        this.reportLine('-'.repeat(label.length), `${theme}.bold`, depth);
    }

    private reportLine(message: string, theme: string, depth: number): void {
        this.console.log(`${reportIndent.repeat(depth)}${message}`, theme);
    }

    private getReportEntries(issues: LinkIssue[]): ReportIssueEntry[] {
        // Report entries collapse repeated raw issues into stable keys while preserving
        // occurrence counts and source pages for detail output.
        const entries = new Map<string, ReportIssueEntry>();
        issues.forEach(issue => {
            const key = this.getReportKey(issue);
            const occurrenceDetails = this.getIssueOccurrenceDetails(issue);
            let entry = entries.get(key);
            if(typeof entry === 'undefined') {
                entry = {
                    issue,
                    key,
                    count: 0,
                    sourceUrls: new Set<string>()
                };
                entries.set(key, entry);
            }
            if(occurrenceDetails.length > 0) {
                entry.count += occurrenceDetails.length;
                occurrenceDetails.forEach(occurrence => entry.sourceUrls.add(occurrence.referer));
            } else {
                entry.count++;
            }
        });

        return Array.from(entries.values()).sort((a, b) => {
            let groupSort = this.getGroupSort(a.issue.group) - this.getGroupSort(b.issue.group);
            if(groupSort === 0) {
                groupSort = a.issue.group.localeCompare(b.issue.group);
            }
            if(groupSort !== 0) {
                return groupSort;
            }

            const statusSort = (a.issue.statusCode ?? 0) - (b.issue.statusCode ?? 0);
            if(statusSort !== 0) {
                return statusSort;
            }

            const codeSort = this.humanizeCode(a.issue.code).localeCompare(this.humanizeCode(b.issue.code));
            if(codeSort !== 0) {
                return codeSort;
            }
            return (a.issue.targetUrl ?? a.issue.rawHref ?? '').localeCompare(b.issue.targetUrl ?? b.issue.rawHref ?? '');
        });
    }

    private getIssueOccurrenceDetails(issue: LinkIssue): LinkOccurrence[] {
        if(typeof issue.occurrenceDetails !== 'undefined' && issue.occurrenceDetails.length > 0) {
            return issue.occurrenceDetails;
        }
        if(typeof issue.sourceUrl === 'string') {
            return [{
                referer: issue.sourceUrl,
                zone: issue.zone ?? 'unknown'
            }];
        }

        return [];
    }

    private getGroupSort(group: string): number {
        const index = reportGroupOrder.indexOf(group);
        return index === -1 ? reportGroupOrder.length : index;
    }

    private getIssueSubheading(issue: LinkIssue): string {
        if(issue.code === 'external-dns-temporary-failure') {
            return 'Temporary DNS Failure';
        }
        if(issue.code === 'external-fetch-failed') {
            return 'External Fetch Failed';
        }
        if(issue.code === 'external-bot-protection') {
            return 'External Bot Protection';
        }
        if(issue.code === 'asset-dns-temporary-failure') {
            return 'Temporary Asset DNS Failure';
        }
        if(issue.code === 'asset-fetch-failed') {
            return 'Asset Fetch Failed';
        }
        if(issue.code === 'asset-bot-protection') {
            return 'Asset Bot Protection';
        }
        if(issue.code === 'fetch-failed') {
            return 'Fetch Failed';
        }
        if(this.isStatusIssue(issue)) {
            if(typeof issue.statusCode === 'number' && issue.statusCode > 0) {
                return `${issue.statusCode} ${issue.group}`;
            }
            return issue.group;
        }

        return this.humanizeCode(issue.code);
    }

    private isStatusIssue(issue: LinkIssue): boolean {
        return [
            'client-error',
            'server-error',
            'redirect-response',
            'redirect-final-target-failed',
            'external-error',
            'external-redirect',
            'external-dns-temporary-failure',
            'external-fetch-failed',
            'asset-error',
            'asset-redirect',
            'asset-dns-temporary-failure',
            'asset-fetch-failed',
            'fetch-failed'
        ].indexOf(issue.code) !== -1;
    }

    private humanizeCode(code: string): string {
        return code
            .split('-')
            .map(part => part.charAt(0).toUpperCase() + part.substring(1))
            .join(' ');
    }

    private shouldShowSubheadingNote(issue: LinkIssue): boolean {
        return [
            'external-dns-temporary-failure',
            'external-fetch-failed',
            'asset-dns-temporary-failure',
            'asset-fetch-failed',
            'fetch-failed'
        ].indexOf(issue.code) !== -1;
    }

    private isAssetIssue(issue: LinkIssue): boolean {
        return issue.group === 'Asset Links' || issue.group === 'Asset Security';
    }

    private isCanonicalIssue(issue: LinkIssue): boolean {
        return issue.group === 'Canonical Issues';
    }

    private getCanonicalDetailLines(issue: LinkIssue): string[] {
        const details: string[] = [];
        if(typeof issue.pageUrl === 'string') {
            details.push(`Page URL: ${issue.pageUrl}`);
        }
        if(typeof issue.linkedUrl === 'string') {
            details.push(`Linked URL found in source: ${issue.linkedUrl}`);
        }
        if(typeof issue.htmlSnippet === 'string' && issue.htmlSnippet !== '') {
            details.push(`Anchor HTML: ${issue.htmlSnippet}`);
        }
        if(typeof issue.canonicalUrl === 'string') {
            details.push(`Current canonical value: ${issue.canonicalUrl === '' ? '[empty]' : issue.canonicalUrl}`);
        }
        if(typeof issue.rawHref === 'string' && issue.rawHref !== issue.canonicalUrl) {
            details.push(`Raw canonical href: ${issue.rawHref === '' ? '[empty]' : issue.rawHref}`);
        }
        if(typeof issue.canonicalHrefs !== 'undefined' && issue.canonicalHrefs.length > 0) {
            details.push(`All canonical href values found: ${issue.canonicalHrefs.map(href => href === '' ? '[empty]' : href).join(' | ')}`);
        }
        if(typeof issue.expectedCanonicalUrl === 'string' && issue.expectedCanonicalUrl !== '') {
            details.push(`Expected/preferred canonical URL: ${issue.expectedCanonicalUrl}`);
        }
        if(typeof issue.finalUrl === 'string' && issue.finalUrl !== '' && issue.finalUrl !== issue.expectedCanonicalUrl) {
            details.push(`Redirect/final URL: ${issue.finalUrl}`);
        }
        if(typeof issue.statusCode === 'number') {
            details.push(`Status: ${issue.statusCode}`);
        }
        if(typeof issue.redirectChain !== 'undefined' && issue.redirectChain.length > 1) {
            details.push(`Chain: ${issue.redirectChain.join(' => ')}`);
        }

        return details;
    }

    private formatIssue(entry: ReportIssueEntry): string {
        const issue = entry.issue;
        if(this.isCanonicalIssue(issue)) {
            switch(issue.code) {
                case 'non-canonical-internal-link':
                    return `Linked URL: ${issue.linkedUrl ?? issue.targetUrl ?? issue.message}`;
                case 'canonical-target-failed':
                case 'canonical-target-redirects':
                    return `Canonical URL: ${issue.canonicalUrl ?? issue.targetUrl ?? issue.message}`;
                default:
                    return `Page URL: ${issue.pageUrl ?? issue.sourceUrl ?? issue.targetUrl ?? issue.message}`;
            }
        }
        if(issue.code === 'external-fetch-failed' || issue.code === 'fetch-failed') {
            return issue.targetUrl ?? issue.rawHref ?? issue.message;
        }
        if(this.isStatusIssue(issue) && typeof issue.statusCode === 'number') {
            return `${issue.statusCode}: ${issue.targetUrl ?? issue.rawHref ?? issue.message}`;
        }
        if(typeof issue.targetUrl === 'string') {
            return issue.targetUrl;
        }
        if(typeof issue.rawHref === 'string') {
            return `${this.humanizeCode(issue.code)}: ${issue.rawHref === '' ? '[empty]' : issue.rawHref}`;
        }

        return issue.message;
    }

    private reportIssueDetails(entry: ReportIssueEntry, theme: string, suppressIssueMessage: boolean): void {
        const issue = entry.issue;
        if(!suppressIssueMessage
            && (!this.isStatusIssue(issue) || this.shouldShowSubheadingNote(issue))
            && issue.message !== this.formatIssue(entry)) {
            this.reportLine(`Issue: ${issue.message}`, theme, 4);
        }
        if(this.isCanonicalIssue(issue)) {
            this.getCanonicalDetailLines(issue).forEach(line => {
                this.reportLine(line, theme, 4);
            });
            return;
        }
        if(typeof issue.assetKind === 'string') {
            this.reportLine(`Asset kind: ${issue.assetKind}`, theme, 4);
        }
        if(typeof issue.sourceLabel === 'string') {
            this.reportLine(`Source context: ${issue.sourceLabel}`, theme, 4);
        }
        if(typeof issue.rawHref === 'string') {
            this.reportLine(`Raw href: ${issue.rawHref === '' ? '[empty]' : issue.rawHref}`, theme, 4);
        }
        if(typeof issue.htmlSnippet === 'string' && issue.htmlSnippet !== '') {
            this.reportLine(`${this.isAssetIssue(issue) ? 'Source snippet' : 'Anchor HTML'}: ${issue.htmlSnippet}`, theme, 4);
        }
        if(typeof issue.normalizedUrl === 'string' && issue.normalizedUrl !== issue.targetUrl) {
            this.reportLine(`Normalized: ${issue.normalizedUrl}`, theme, 4);
        }
        if(typeof issue.decodedPath === 'string') {
            this.reportLine(`Decoded path: ${issue.decodedPath}`, theme, 4);
        }
        if(typeof issue.finalUrl === 'string' && issue.finalUrl !== '') {
            this.reportLine(`To: ${issue.finalUrl}`, theme, 4);
        }
        if(typeof issue.networkErrorCode === 'string') {
            this.reportLine(`Network error code: ${issue.networkErrorCode}`, theme, 4);
        }
        if(typeof issue.networkErrorMessage === 'string') {
            this.reportLine(`Network error message: ${issue.networkErrorMessage}`, theme, 4);
        }
        if(typeof issue.redirectChain !== 'undefined' && issue.redirectChain.length > 1) {
            this.reportLine(`Chain: ${issue.redirectChain.join(' => ')}`, theme, 4);
        }
    }

    private reportIssueSources(entry: ReportIssueEntry, theme: string): void {
        const sources = Array.from(entry.sourceUrls).sort((a, b) => a.localeCompare(b));
        if(sources.length === 0) {
            return;
        }

        const pageLabel = sources.length === 1 ? 'page' : 'pages';
        const occurrenceLabel = entry.count === 1 ? 'occurrence' : 'occurrences';
        this.reportLine(`Found on ${sources.length} ${pageLabel} (${entry.count} ${occurrenceLabel}):`, theme, 4);
        sources.forEach(source => {
            this.reportLine(source, theme, 5);
        });
    }

    private auditParseWarnings(pageData: PageData): void {
        // Core records malformed href/canonical parse failures so this job can report them
        // alongside status and policy findings.
        pageData.parseWarnings.forEach(warning => {
            this.addIssue(this.issueFromParseWarning(warning));
        });
    }

    private issueFromParseWarning(warning: PageParseWarning): LinkIssue {
        return {
            severity: 'error',
            group: warning.type === 'malformed-canonical' ? 'Canonical Issues' : 'Malformed Links',
            code: warning.type,
            message: warning.message,
            sourceUrl: warning.referer,
            rawHref: warning.rawValue,
            htmlSnippet: warning.htmlSnippet,
            pageUrl: warning.type === 'malformed-canonical' ? warning.referer : undefined,
            canonicalUrl: warning.type === 'malformed-canonical' ? warning.rawValue : undefined,
            expectedCanonicalUrl: warning.type === 'malformed-canonical' ? warning.referer : undefined,
            zone: 'unknown'
        };
    }

    private auditPageLinks(pageData: PageData): void {
        // Raw link audits look at markup quality and safety independent of whether the target
        // was crawlable. Network/status checks are handled elsewhere.
        pageData.rawLinks.forEach(link => {
            const rawHref = link.rawHref.trim();
            const lowerHref = rawHref.toLowerCase();

            if(!link.hasHref) {
                this.addPageLinkIssue(link, 'warning', 'Placeholder Links', 'missing-href', 'Anchor tag is missing an href attribute.');
                return;
            }

            if(rawHref === '') {
                this.addPageLinkIssue(link, 'warning', 'Placeholder Links', 'empty-href', 'Anchor href is empty.');
                return;
            }

            if(lowerHref === '#' || lowerHref === '#!') {
                this.addPageLinkIssue(link, 'notice', 'Placeholder Links', 'hash-placeholder', 'Anchor href is a placeholder fragment.');
            }

            if(/^javascript:/i.test(rawHref)) {
                const severity: LinkIssueSeverity = /^javascript:\s*void\s*\(/i.test(rawHref) ? 'warning' : 'error';
                this.addPageLinkIssue(
                    link,
                    severity,
                    'Unsafe Link Protocols',
                    'javascript-href',
                    'Anchor uses a javascript: href.'
                );
            } else if(/^vbscript:/i.test(rawHref)) {
                this.addPageLinkIssue(link, 'error', 'Unsafe Link Protocols', 'vbscript-href', 'Anchor uses a vbscript: href.');
            } else if(/^(data|file|blob):/i.test(rawHref)) {
                this.addPageLinkIssue(link, 'warning', 'Unsafe Link Protocols', 'non-web-protocol', 'Anchor uses a non-web href protocol.');
            }

            if(this.hasControlCharacters(rawHref)) {
                this.addPageLinkIssue(link, 'warning', 'Malformed Links', 'control-character-href', 'Anchor href contains control characters.');
            }

            if(this.isInsecureInternalLink(link)) {
                this.addPageLinkIssue(link, 'warning', 'Insecure Internal Links', 'insecure-internal-link', 'Internal link uses HTTP or protocol-relative URL on an HTTPS crawl.');
            }

            if(this.isBlankTargetMissingRel(link)) {
                this.addPageLinkIssue(link, 'warning', 'Target Blank Security', 'target-blank-rel', 'Anchor with target="_blank" is missing rel="noopener" or rel="noreferrer".');
            }

            const decodedPath = this.getDecodedUrlPath(link);
            if(decodedPath !== null && this.undesirablePathCharacterPattern.test(decodedPath)) {
                this.addIssue({
                    severity: 'notice',
                    group: 'URL Path Quality',
                    code: 'undesirable-path-character',
                    message: 'Decoded URL path contains characters outside the preferred URL character set.',
                    targetUrl: link.normalizedUrl,
                    sourceUrl: link.referer,
                    rawHref: link.rawHref,
                    htmlSnippet: link.htmlSnippet,
                    normalizedUrl: link.normalizedUrl,
                    decodedPath,
                    zone: link.zone ?? 'unknown'
                });
            }

            this.auditFragment(link, pageData);
            this.trackExternalLink(link);
        });
    }

    private collectPageAssets(pageData: PageData): void {
        if(!this.includeAssets || typeof pageData.jsdom === 'undefined') {
            return;
        }

        const document = pageData.jsdom;
        const pageUrl = pageData.location.url;
        const collectAttribute = (selector: string, attribute: string, kind: AssetKind): void => {
            document.querySelectorAll(selector).forEach(element => {
                this.addAssetFromElement(element, attribute, kind, pageUrl);
            });
        };

        collectAttribute('script[src]', 'src', 'script');
        collectAttribute('link[href]', 'href', 'preload');
        collectAttribute('img[src]', 'src', 'image');
        collectAttribute('input[type="image"][src]', 'src', 'image');
        collectAttribute('source[src]', 'src', 'media');
        collectAttribute('video[src], audio[src]', 'src', 'media');
        collectAttribute('track[src]', 'src', 'track');
        collectAttribute('video[poster]', 'poster', 'poster');
        collectAttribute('embed[src]', 'src', 'embed');
        collectAttribute('object[data]', 'data', 'object');
        collectAttribute('svg image[href]', 'href', 'svg');
        collectAttribute('svg image[xlink\\:href]', 'xlink:href', 'svg');

        document.querySelectorAll('iframe[src]').forEach(element => {
            const targetUrl = this.addAssetFromElement(element, 'src', 'iframe', pageUrl);
            this.auditIframeSecurity(element, pageUrl, targetUrl);
        });

        document.querySelectorAll('img[srcset], source[srcset]').forEach(element => {
            const sourceLabel = `${this.getElementLabel(element)} srcset`;
            this.parseSrcset(element.getAttribute('srcset') ?? '').forEach(candidate => {
                this.addAssetReference(candidate, {
                    sourceUrl: pageUrl,
                    baseUrl: pageUrl,
                    sourceLabel,
                    kind: 'srcset',
                    htmlSnippet: this.getElementSnippet(element),
                    zone: this.classifyAssetZone(element)
                });
            });
        });

        document.querySelectorAll('meta[content]').forEach(element => {
            const name = String(element.getAttribute('property') ?? element.getAttribute('name') ?? '').toLowerCase();
            if(!this.isAssetMetaName(name)) {
                return;
            }
            this.addAssetReference(element.getAttribute('content') ?? '', {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel: `${this.getElementLabel(element)} content`,
                kind: 'meta',
                htmlSnippet: this.getElementSnippet(element),
                zone: 'unknown'
            });
        });

        document.querySelectorAll('style').forEach(element => {
            this.collectCssAssetReferences(String(element.textContent ?? ''), {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel: 'inline <style>',
                kind: 'inline-style',
                htmlSnippet: this.getElementSnippet(element),
                zone: this.classifyAssetZone(element)
            });
        });

        document.querySelectorAll('[style]').forEach(element => {
            this.collectCssAssetReferences(element.getAttribute('style') ?? '', {
                sourceUrl: pageUrl,
                baseUrl: pageUrl,
                sourceLabel: `${this.getElementLabel(element)} style attribute`,
                kind: 'inline-style',
                htmlSnippet: this.getElementSnippet(element),
                zone: this.classifyAssetZone(element)
            });
        });
    }

    private addAssetFromElement(element: Element, attribute: string, fallbackKind: AssetKind, pageUrl: string): string|null {
        const kind = element.tagName.toLowerCase() === 'link'
            ? this.getLinkAssetKind(element) ?? fallbackKind
            : fallbackKind;
        if(kind === 'preload' && element.tagName.toLowerCase() === 'link'
            && this.getLinkAssetKind(element) === null) {
            return null;
        }

        return this.addAssetReference(element.getAttribute(attribute) ?? '', {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: `${this.getElementLabel(element)} ${attribute}`,
            kind,
            htmlSnippet: this.getElementSnippet(element),
            zone: this.classifyAssetZone(element)
        });
    }

    private getLinkAssetKind(element: Element): AssetKind|null {
        const rel = String(element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
        if(rel.includes('canonical') || rel.includes('alternate')) {
            return null;
        }
        if(rel.includes('stylesheet')) {
            return 'stylesheet';
        }
        if(rel.includes('manifest')) {
            return 'manifest';
        }
        if(rel.some(value => ['icon', 'apple-touch-icon', 'mask-icon', 'shortcut'].includes(value))) {
            return 'icon';
        }
        if(rel.some(value => ['preload', 'modulepreload', 'prefetch'].includes(value))) {
            return 'preload';
        }
        return null;
    }

    private addAssetReference(rawUrl: string, context: AssetReferenceContext): string|null {
        const trimmedUrl = rawUrl.trim().replace(/^['"]|['"]$/g, '').trim();
        if(trimmedUrl === '' || trimmedUrl.startsWith('#') || /^(data|blob|about):/i.test(trimmedUrl)) {
            return null;
        }

        let parsedUrl: URL;
        try {
            parsedUrl = new URL(trimmedUrl, context.baseUrl);
        } catch (e) {
            this.addAssetContextIssue(
                context,
                'error',
                'malformed-asset-url',
                e instanceof Error ? e.message : String(e),
                trimmedUrl
            );
            return null;
        }

        if(parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            this.addAssetContextIssue(
                context,
                'warning',
                'unsupported-asset-protocol',
                'Asset reference uses an unsupported protocol.',
                trimmedUrl,
                parsedUrl.href
            );
            return null;
        }

        const targetUrl = parsedUrl.href;
        const decodedPath = this.getDecodedUrlPathFromUrl(targetUrl);
        if(decodedPath !== null && this.undesirablePathCharacterPattern.test(decodedPath)) {
            this.addIssue({
                severity: 'notice',
                group: 'URL Path Quality',
                code: 'undesirable-path-character',
                message: 'Decoded asset URL path contains characters outside the preferred URL character set.',
                targetUrl,
                sourceUrl: context.sourceUrl,
                rawHref: trimmedUrl,
                htmlSnippet: context.htmlSnippet,
                normalizedUrl: targetUrl,
                decodedPath,
                zone: context.zone,
                assetKind: context.kind,
                sourceLabel: context.sourceLabel,
                occurrenceDetails: context.occurrenceDetails
            });
        }

        if(this.isInsecureAssetReference(trimmedUrl, parsedUrl)) {
            this.addAssetContextIssue(
                context,
                'warning',
                'insecure-asset-url',
                'Asset reference uses HTTP or a protocol-relative URL on an HTTPS crawl.',
                trimmedUrl,
                targetUrl
            );
        }

        const isExternal = this.normalizeHostname(parsedUrl.hostname) !== this.baseHostname;
        if(isExternal && !this.includeExternal) {
            return targetUrl;
        }

        const key = [
            targetUrl,
            trimmedUrl,
            context.kind,
            context.sourceLabel
        ].join('|');
        const occurrence: LinkOccurrence = {
            referer: context.sourceUrl,
            zone: context.zone
        };
        const occurrences = context.occurrenceDetails ?? [occurrence];
        const existingAsset = this.assetLinks.get(key);
        if(typeof existingAsset !== 'undefined') {
            existingAsset.occurrences.push(...occurrences);
            return targetUrl;
        }

        this.assetLinks.set(key, {
            targetUrl,
            rawUrl: trimmedUrl,
            sourceUrl: context.sourceUrl,
            sourceLabel: context.sourceLabel,
            kind: context.kind,
            htmlSnippet: context.htmlSnippet,
            zone: context.zone,
            isExternal,
            occurrences
        });

        return targetUrl;
    }

    private addAssetContextIssue(
        context: AssetReferenceContext,
        severity: LinkIssueSeverity,
        code: string,
        message: string,
        rawUrl: string,
        targetUrl?: string
    ): void {
        this.addIssue({
            severity,
            group: 'Asset Security',
            code,
            message,
            targetUrl,
            sourceUrl: context.sourceUrl,
            rawHref: rawUrl,
            htmlSnippet: context.htmlSnippet,
            normalizedUrl: targetUrl,
            zone: context.zone,
            assetKind: context.kind,
            sourceLabel: context.sourceLabel,
            occurrenceDetails: context.occurrenceDetails
        });
    }

    private auditIframeSecurity(element: Element, pageUrl: string, targetUrl: string|null): void {
        const context: AssetReferenceContext = {
            sourceUrl: pageUrl,
            baseUrl: pageUrl,
            sourceLabel: `${this.getElementLabel(element)} src`,
            kind: 'iframe',
            htmlSnippet: this.getElementSnippet(element),
            zone: this.classifyAssetZone(element)
        };
        const rawUrl = element.getAttribute('src') ?? '';
        if(!element.hasAttribute('sandbox')) {
            this.addAssetContextIssue(
                context,
                'warning',
                'iframe-missing-sandbox',
                'Iframe embed is missing a sandbox attribute.',
                rawUrl,
                targetUrl ?? undefined
            );
        }
        if(!element.hasAttribute('referrerpolicy')) {
            this.addAssetContextIssue(
                context,
                'warning',
                'iframe-missing-referrerpolicy',
                'Iframe embed is missing a referrerpolicy attribute.',
                rawUrl,
                targetUrl ?? undefined
            );
        }
    }

    private async auditAssetLinks(): Promise<void> {
        if(!this.includeAssets) {
            return;
        }

        const config = this.getAssetRequestConfig();
        let assets = Array.from(this.assetLinks.values());
        this.profiler.markJob(this.handle, 'shutdown',
            `asset link audit starting (${assets.length} unique URL/source pairs, ${Math.min(externalCheckConcurrency, assets.length)} workers)`
        );
        let index = 0;
        let completed = 0;
        const workers = Array.from({length: Math.min(externalCheckConcurrency, assets.length)}, async () => {
            while(!this.runtime.aborted) {
                if(index >= assets.length) {
                    if(assets.length >= this.assetLinks.size) {
                        break;
                    }
                    assets = Array.from(this.assetLinks.values());
                    this.profiler.markJob(this.handle, 'shutdown',
                        `asset link audit queue expanded (${assets.length} unique URL/source pairs after nested CSS/JS discovery)`
                    );
                }
                const asset = assets[index++];
                const startedAt = Date.now();
                await this.auditAssetLinkWithTimeout(asset, config);
                const elapsedMs = Date.now() - startedAt;
                completed++;
                if(elapsedMs >= 1000 || completed % 25 === 0 || completed === assets.length) {
                    this.profiler.markJob(this.handle, 'shutdown',
                        `asset link checked ${completed}/${this.assetLinks.size} in ${(elapsedMs / 1000).toFixed(2)}s: ${asset.targetUrl}`
                    );
                }
            }
        });
        await Promise.all(workers);
        this.profiler.markJob(this.handle, 'shutdown',
            `asset link audit finished (${completed}/${this.assetLinks.size} checked, ${this.scannedAssetBodies.size} CSS/JS bodies scanned)`
        );
    }

    private async auditAssetLinkWithTimeout(asset: AssetRecord, config: AxiosRequestConfig): Promise<void> {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort(`Asset link audit exceeded ${(externalCheckUrlTimeoutMs / 1000).toFixed(1)}s URL budget.`);
        }, externalCheckUrlTimeoutMs);

        try {
            const signals = [controller.signal];
            if(typeof config.signal !== 'undefined') {
                signals.push(config.signal as AbortSignal);
            }
            await this.auditAssetLink(asset, {
                ...config,
                signal: AbortSignal.any(signals)
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    private async auditAssetLink(asset: AssetRecord, config: AxiosRequestConfig): Promise<void> {
        if(this.runtime.aborted) {
            return;
        }

        try {
            const response = await this.externalHead(asset.targetUrl, config);
            if(this.isBotProtectionResponse(response)) {
                this.addAssetBotProtectionNotice(asset, response.status);
                return;
            }
            await this.scanAssetBodyIfNeeded(asset, response, config);
        } catch (e) {
            if(this.runtime.aborted) {
                return;
            }

            if(axios.isAxiosError(e) && typeof e.response !== 'undefined') {
                if(this.isBotProtectionResponse(e.response)) {
                    this.addAssetBotProtectionNotice(asset, e.response.status);
                    return;
                }

                const status = e.response.status;
                if(status >= 300 && status < 400) {
                    this.addAssetIssue(asset, 'warning', 'asset-redirect', 'Asset URL returned a redirect response.', status, String(e.response.headers.location ?? ''));
                    return;
                }
                if(status >= 400) {
                    const httpsUrl = await this.getReachableHttpsUpgradeUrlByHead(asset.targetUrl, config);
                    if(httpsUrl !== null) {
                        this.addAssetIssue(asset, 'error', 'asset-http-upgrade-available', 'Asset HTTP URL failed, but the HTTPS version responded successfully.', status, httpsUrl);
                        return;
                    }
                    if(await this.assetGetShowsReachableOrProtected(asset, config)) {
                        return;
                    }
                    this.addAssetIssue(asset, 'error', 'asset-error', 'Asset URL returned an error response.', status);
                }
                return;
            }

            if(this.isTemporaryDnsFailure(e)) {
                this.addAssetIssue(asset, 'warning', 'asset-dns-temporary-failure', 'Asset URL DNS lookup failed with EAI_AGAIN.', 0, undefined, 'EAI_AGAIN', e instanceof Error ? e.message : String(e));
                return;
            }

            const httpsUrl = await this.getReachableHttpsUpgradeUrlByHead(asset.targetUrl, config);
            if(httpsUrl !== null) {
                this.addAssetIssue(asset, 'error', 'asset-http-upgrade-available', 'Asset HTTP URL failed, but the HTTPS version responded successfully.', 0, httpsUrl);
                return;
            }

            if(await this.assetGetShowsReachableOrProtected(asset, config)) {
                return;
            }

            this.addAssetIssue(asset, 'warning', 'asset-fetch-failed', 'Asset URL did not respond to a HEAD request.', 0);
        }
    }

    private async assetGetShowsReachableOrProtected(asset: AssetRecord, config: AxiosRequestConfig): Promise<boolean> {
        if(!this.shouldUseAssetGetFallback(asset)) {
            return false;
        }

        return await this.externalGetShowsReachableOrProtected(asset.targetUrl, {
            ...this.getExternalFallbackConfig(config),
            maxContentLength: assetBodyMaxBytes,
            maxBodyLength: assetBodyMaxBytes
        });
    }

    private shouldUseAssetGetFallback(asset: AssetRecord): boolean {
        if(!asset.isExternal) {
            return false;
        }

        return [
            'script',
            'stylesheet',
            'manifest',
            'css-url',
            'css-import',
            'css-source-map',
            'js-url',
            'js-source-map'
        ].includes(asset.kind);
    }

    private addAssetIssue(
        asset: AssetRecord,
        severity: LinkIssueSeverity,
        code: string,
        message: string,
        statusCode?: number,
        finalUrl?: string,
        networkErrorCode?: string,
        networkErrorMessage?: string
    ): void {
        this.addIssue({
            severity,
            group: 'Asset Links',
            code,
            message,
            targetUrl: asset.targetUrl,
            sourceUrl: asset.sourceUrl,
            rawHref: asset.rawUrl,
            htmlSnippet: asset.htmlSnippet,
            normalizedUrl: asset.targetUrl,
            statusCode,
            finalUrl,
            networkErrorCode,
            networkErrorMessage,
            zone: asset.zone,
            assetKind: asset.kind,
            sourceLabel: asset.sourceLabel,
            occurrenceDetails: asset.occurrences
        });
    }

    private addAssetBotProtectionNotice(asset: AssetRecord, statusCode?: number): void {
        this.addAssetIssue(
            asset,
            'notice',
            'asset-bot-protection',
            'Asset URL returned a bot protection or edge security response.',
            statusCode
        );
    }

    private getAssetRequestConfig(): AxiosRequestConfig {
        return {
            maxRedirects: 0,
            timeout: externalCheckTimeoutMs,
            headers: {
                ...externalCheckRequestHeaders
            },
            httpAgent: new http.Agent({
                timeout: externalCheckTimeoutMs
            }),
            httpsAgent: new https.Agent({
                timeout: externalCheckTimeoutMs,
                requestCert: false,
                rejectUnauthorized: this.config.getConfigBoolean('requestTls.rejectUnauthorized', null, true)
            }),
            signal: this.runtime.abortSignal
        };
    }

    private async scanAssetBodyIfNeeded(asset: AssetRecord, response: AxiosResponse<unknown>, config: AxiosRequestConfig): Promise<void> {
        if(asset.isExternal || this.scannedAssetBodies.has(asset.targetUrl)) {
            return;
        }
        if(!this.shouldScanAssetBody(asset, response)) {
            return;
        }

        this.scannedAssetBodies.add(asset.targetUrl);
        const scanKind = this.isCssAsset(asset, response) ? 'CSS' : 'JS';
        const startedAt = Date.now();
        const initialAssetCount = this.assetLinks.size;
        this.profiler.markJob(this.handle, 'shutdown',
            `asset ${scanKind} body scan starting: ${asset.targetUrl}`
        );
        try {
            const bodyResponse = await this.externalGet(asset.targetUrl, {
                ...config,
                maxContentLength: assetBodyMaxBytes,
                maxBodyLength: assetBodyMaxBytes
            }, false);
            const body = bodyResponse.data;
            const baseContext: AssetReferenceContext = {
                sourceUrl: asset.sourceUrl,
                baseUrl: asset.targetUrl,
                sourceLabel: asset.sourceLabel,
                kind: asset.kind,
                htmlSnippet: asset.htmlSnippet,
                zone: asset.zone,
                occurrenceDetails: asset.occurrences
            };

            if(this.isCssAsset(asset, bodyResponse)) {
                this.collectCssAssetReferences(body, {
                    ...baseContext,
                    sourceLabel: `CSS body ${asset.targetUrl}`,
                    kind: 'css-url'
                });
            } else if(this.isJsAsset(asset, bodyResponse)) {
                this.collectJsAssetReferences(body, {
                    ...baseContext,
                    sourceLabel: `JS body ${asset.targetUrl}`,
                    kind: 'js-url'
                });
            }
            const elapsedMs = Date.now() - startedAt;
            const discovered = this.assetLinks.size - initialAssetCount;
            this.profiler.markJob(this.handle, 'shutdown',
                `asset ${scanKind} body scan complete in ${(elapsedMs / 1000).toFixed(2)}s; discovered ${discovered} nested asset URL(s): ${asset.targetUrl}`
            );
        } catch {
            // HEAD already proved the asset reachable; body scanning is best-effort so large
            // or blocked CSS/JS bodies do not become false broken-asset findings.
            const elapsedMs = Date.now() - startedAt;
            this.profiler.markJob(this.handle, 'shutdown',
                `asset ${scanKind} body scan skipped after ${(elapsedMs / 1000).toFixed(2)}s: ${asset.targetUrl}`
            );
        }
    }

    private shouldScanAssetBody(asset: AssetRecord, response: AxiosResponse<unknown>): boolean {
        return this.isCssAsset(asset, response) || this.isJsAsset(asset, response);
    }

    private isCssAsset(asset: AssetRecord, response: AxiosResponse<unknown>): boolean {
        const contentType = this.getContentType(response);
        return contentType.includes('text/css') || new URL(asset.targetUrl).pathname.toLowerCase().endsWith('.css');
    }

    private isJsAsset(asset: AssetRecord, response: AxiosResponse<unknown>): boolean {
        const contentType = this.getContentType(response);
        const path = new URL(asset.targetUrl).pathname.toLowerCase();
        return contentType.includes('javascript')
            || contentType.includes('ecmascript')
            || path.endsWith('.js')
            || path.endsWith('.mjs');
    }

    private getContentType(response: AxiosResponse<unknown>): string {
        const header: unknown = response.headers['content-type'] ?? '';
        return (Array.isArray(header) ? header.join(' ') : String(header)).toLowerCase();
    }

    private collectCssAssetReferences(css: string, context: AssetReferenceContext): void {
        const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi;
        let match: RegExpExecArray|null;
        while((match = urlPattern.exec(css)) !== null) {
            const rawUrl = match[1] ?? match[2] ?? match[3] ?? '';
            this.addAssetReference(rawUrl, {
                ...context,
                kind: 'css-url',
                sourceLabel: `${context.sourceLabel} url()`,
                htmlSnippet: this.getTextSnippet(css, match.index)
            });
        }

        const importPattern = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))/gi;
        while((match = importPattern.exec(css)) !== null) {
            const rawUrl = match[1] ?? match[2] ?? match[3] ?? '';
            this.addAssetReference(rawUrl, {
                ...context,
                kind: 'css-import',
                sourceLabel: `${context.sourceLabel} @import`,
                htmlSnippet: this.getTextSnippet(css, match.index)
            });
        }

        this.collectSourceMapReferences(css, context, 'css-source-map');
    }

    private collectJsAssetReferences(js: string, context: AssetReferenceContext): void {
        const assetStringPattern = /(['"`])([^'"`]{1,2048}\.(?:png|jpe?g|gif|webp|avif|svg|css|js|mjs|woff2?|ttf|otf|eot|ico|json|webmanifest|mp4|webm|mp3|wav|pdf)(?:[?#][^'"`]*)?)\1/gi;
        let match: RegExpExecArray|null;
        while((match = assetStringPattern.exec(js)) !== null) {
            const rawUrl = match[2] ?? '';
            if(
                !this.isConservativeJsAssetReference(rawUrl)
                || !this.isStandaloneJsStringLiteral(js, match.index, match[0].length)
            ) {
                continue;
            }
            this.addAssetReference(rawUrl, {
                ...context,
                kind: 'js-url',
                sourceLabel: `${context.sourceLabel} string literal`,
                htmlSnippet: this.getTextSnippet(js, match.index)
            });
        }

        this.collectSourceMapReferences(js, context, 'js-source-map');
    }

    private collectSourceMapReferences(body: string, context: AssetReferenceContext, kind: 'css-source-map'|'js-source-map'): void {
        const sourceMapPattern = /[#@]\s*sourceMappingURL=([^\s*]+)/gi;
        let match: RegExpExecArray|null;
        while((match = sourceMapPattern.exec(body)) !== null) {
            this.addAssetReference(match[1] ?? '', {
                ...context,
                kind,
                sourceLabel: `${context.sourceLabel} sourceMappingURL`,
                htmlSnippet: this.getTextSnippet(body, match.index)
            });
        }
    }

    private isConservativeJsAssetReference(rawUrl: string): boolean {
        if(rawUrl.includes('${')) {
            return false;
        }
        if(/^(https?:)?\/\//i.test(rawUrl) || rawUrl.startsWith('/')) {
            return true;
        }
        if(rawUrl.startsWith('./') || rawUrl.startsWith('../')) {
            return !this.isRelativeJsModuleSpecifier(rawUrl);
        }

        return false;
    }

    private isStandaloneJsStringLiteral(js: string, startIndex: number, length: number): boolean {
        const before = js.slice(0, startIndex).match(/\S\s*$/)?.[0].trim() ?? '';
        const after = js.slice(startIndex + length).match(/^\s*\S/)?.[0].trim() ?? '';
        return before !== '+' && after !== '+';
    }

    private isRelativeJsModuleSpecifier(rawUrl: string): boolean {
        try {
            const path = new URL(rawUrl, 'https://example.invalid/').pathname.toLowerCase();
            return path.endsWith('.js') || path.endsWith('.mjs');
        } catch {
            return false;
        }
    }

    private parseSrcset(value: string): string[] {
        return value
            .split(',')
            .map(candidate => candidate.trim().split(/\s+/)[0] ?? '')
            .filter(candidate => candidate !== '');
    }

    private isAssetMetaName(name: string): boolean {
        return [
            'og:image',
            'og:image:url',
            'og:video',
            'og:video:url',
            'twitter:image',
            'twitter:image:src',
            'twitter:player',
            'msapplication-tileimage'
        ].includes(name);
    }

    private isInsecureAssetReference(rawUrl: string, parsedUrl: URL): boolean {
        return this.baseProtocol === 'https:'
            && (parsedUrl.protocol === 'http:' || rawUrl.startsWith('//'));
    }

    private async getReachableHttpsUpgradeUrlByHead(url: string, config: AxiosRequestConfig): Promise<string|null> {
        if(this.runtime.aborted) {
            return null;
        }

        const httpsUrl = this.getHttpsUpgradeUrl(url);
        if(httpsUrl === null) {
            return null;
        }

        try {
            const response = await this.externalHead(httpsUrl, this.getExternalFallbackConfig(config), false);
            if(response.status >= 200 && response.status < 300) {
                return httpsUrl;
            }
        } catch (e) {
            if(this.runtime.aborted || this.isAbortError(e)) {
                return null;
            }
            if(axios.isAxiosError(e)
                && typeof e.response !== 'undefined'
                && e.response.status >= 200
                && e.response.status < 400) {
                return httpsUrl;
            }
        }

        return null;
    }

    private getElementLabel(element: Element): string {
        const tag = element.tagName.toLowerCase();
        const id = element.getAttribute('id');
        const className = String(element.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
        return `${tag}${id !== null && id !== '' ? `#${id}` : ''}${className.length > 0 ? `.${className.join('.')}` : ''}`;
    }

    private getElementSnippet(element: Element): string {
        return this.truncateText(element.outerHTML.trim(), 320);
    }

    private getTextSnippet(value: string, index: number): string {
        const start = Math.max(0, index - 80);
        const end = Math.min(value.length, index + 180);
        return this.truncateText(value.slice(start, end).replace(/\s+/g, ' ').trim(), 320);
    }

    private truncateText(value: string, maxBytes: number): string {
        if(Buffer.byteLength(value, 'utf8') <= maxBytes) {
            return value;
        }

        let bytes = 0;
        let output = '';
        for(const character of value) {
            const characterBytes = Buffer.byteLength(character, 'utf8');
            if(bytes + characterBytes > maxBytes - 3) {
                return `${output}...`;
            }
            bytes += characterBytes;
            output += character;
        }
        return output;
    }

    private classifyAssetZone(element: Element): LinkZone {
        if(element.closest('nav') !== null) {
            return 'nav';
        }
        if(element.closest('header') !== null) {
            return 'header';
        }
        if(element.closest('footer') !== null) {
            return 'footer';
        }
        if(element.closest('aside') !== null) {
            return 'aside';
        }
        if(element.closest('main') !== null) {
            return 'main';
        }
        return 'unknown';
    }

    private compileUndesirablePathCharacterPattern(pattern: string): RegExp {
        try {
            return new RegExp(pattern);
        } catch {
            return /[^\w\-/.]/;
        }
    }

    private compileIgnoredIssuePatterns(patterns: IgnoredIssuePatternConfig[]): IgnoredIssuePattern[] {
        if(!Array.isArray(patterns)) {
            return [];
        }

        const compiled: IgnoredIssuePattern[] = [];
        patterns.forEach(config => {
            if(typeof config !== 'object' || config === null
                || typeof config.urlPattern !== 'string' || config.urlPattern === '') {
                return;
            }
            try {
                compiled.push({
                    pattern: new RegExp(config.urlPattern),
                    codes: this.compileStringSelector(config.codes),
                    groups: this.compileStringSelector(config.groups),
                    severities: this.compileSeveritySelector(config.severities)
                });
            } catch {
                // Invalid ignore patterns are skipped so one typo does not disable the job.
            }
        });
        return compiled;
    }

    private compileStringSelector(values?: string[]): Set<string>|null {
        if(!Array.isArray(values)) {
            return null;
        }

        const selector = new Set<string>();
        values.forEach(value => {
            if(typeof value === 'string' && value !== '') {
                selector.add(value);
            }
        });

        return selector.size > 0 ? selector : null;
    }

    private compileSeveritySelector(values?: LinkIssueSeverity[]): Set<LinkIssueSeverity>|null {
        if(!Array.isArray(values)) {
            return null;
        }

        const selector = new Set<LinkIssueSeverity>();
        values.forEach(value => {
            if(linkIssueSeverities.includes(value)) {
                selector.add(value);
            }
        });

        return selector.size > 0 ? selector : null;
    }

    private normalizeEmailReportTriggerLevels(levels: LinkIssueSeverity[]|null): LinkIssueSeverity[]|null {
        if(levels === null || (Array.isArray(levels) && levels.length === 0)) {
            return null;
        }
        if(!Array.isArray(levels)) {
            return [...linkIssueSeverities];
        }

        const normalized: LinkIssueSeverity[] = [];
        levels.forEach(level => {
            if(linkIssueSeverities.indexOf(level) !== -1 && normalized.indexOf(level) === -1) {
                normalized.push(level);
            }
        });

        return normalized.length > 0 ? normalized : [...linkIssueSeverities];
    }

    private getDecodedUrlPath(link: PageLink): string|null {
        return this.getDecodedUrlPathFromUrl(link.normalizedUrl);
    }

    private getDecodedUrlPathFromUrl(url?: string): string|null {
        if(typeof url !== 'string') {
            return null;
        }

        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }

        if(parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }

        try {
            return decodeURIComponent(parsed.pathname);
        } catch {
            return null;
        }
    }

    private addPageLinkIssue(
        link: PageLink,
        severity: LinkIssueSeverity,
        group: string,
        code: string,
        message: string
    ): void {
        this.addIssue({
            severity,
            group,
            code,
            message,
            targetUrl: link.normalizedUrl,
            sourceUrl: link.referer,
            rawHref: link.rawHref,
            htmlSnippet: link.htmlSnippet,
            normalizedUrl: link.normalizedUrl,
            zone: link.zone ?? 'unknown'
        });
    }

    private isBlankTargetMissingRel(link: PageLink): boolean {
        if(link.target?.toLowerCase() !== '_blank') {
            return false;
        }
        const rel = (link.rel ?? '').toLowerCase().split(/\s+/);
        return rel.indexOf('noopener') === -1 && rel.indexOf('noreferrer') === -1;
    }

    private isInsecureInternalLink(link: PageLink): boolean {
        if(this.baseProtocol !== 'https:' || typeof link.normalizedUrl !== 'string') {
            return false;
        }

        const rawHref = link.rawHref.trim();
        if(!rawHref.match(/^http:\/\//i) && !rawHref.match(/^\/\//)) {
            return false;
        }

        try {
            const url = new URL(link.normalizedUrl);
            return this.normalizeHostname(url.hostname) === this.baseHostname;
        } catch {
            return false;
        }
    }

    private hasControlCharacters(value: string): boolean {
        return [...value].some(character => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
        });
    }

    private auditFragment(link: PageLink, pageData: PageData): void {
        // Same-page fragments can be checked immediately. Cross-page fragments wait until
        // all target pages have had a chance to register their anchors.
        if(typeof link.normalizedUrl !== 'string' || link.normalizedUrl.indexOf('#') === -1) {
            return;
        }

        const url = new URL(link.normalizedUrl);
        if(url.hash === '') {
            return;
        }

        const fragment = decodeURIComponent(url.hash.substring(1));
        const targetUrl = this.stripHash(url.href);
        const zone = link.zone ?? 'unknown';
        if(targetUrl === pageData.location.url) {
            const anchors = this.pageAnchors.get(pageData.location.url) ?? new Set<string>();
            if(!anchors.has(fragment)) {
                this.addIssue({
                    severity: 'warning',
                    group: 'Fragment Links',
                    code: 'missing-same-page-fragment',
                    message: 'Fragment link target was not found on the same page.',
                    targetUrl,
                    sourceUrl: link.referer,
                    rawHref: link.rawHref,
                    htmlSnippet: link.htmlSnippet,
                    normalizedUrl: link.normalizedUrl,
                    zone
                });
            }
            return;
        }

        if(this.normalizeHostname(url.hostname) === this.baseHostname) {
            this.fragmentRequests.push({
                targetUrl,
                fragment,
                sourceUrl: link.referer,
                rawHref: link.rawHref,
                htmlSnippet: link.htmlSnippet,
                zone
            });
        }
    }

    private auditDeferredFragments(): void {
        this.fragmentRequests.forEach(request => {
            const anchors = this.pageAnchors.get(request.targetUrl);
            if(typeof anchors === 'undefined') {
                return;
            }
            if(!anchors.has(request.fragment)) {
                this.addIssue({
                    severity: 'warning',
                    group: 'Fragment Links',
                    code: 'missing-cross-page-fragment',
                    message: 'Fragment link target was not found on the linked page.',
                    targetUrl: `${request.targetUrl}#${request.fragment}`,
                    sourceUrl: request.sourceUrl,
                    rawHref: request.rawHref,
                    htmlSnippet: request.htmlSnippet,
                    zone: request.zone
                });
            }
        });
    }

    private trackExternalLink(link: PageLink): void {
        // External checks are optional and de-duped by target URL so repeated social/footer
        // links only make one network request.
        if(!link.isExternal || typeof link.normalizedUrl !== 'string' || !link.normalizedUrl.match(/^https?:\/\//i)) {
            return;
        }

        let record = this.externalLinks.get(link.normalizedUrl);
        if(typeof record === 'undefined') {
            record = {
                targetUrl: link.normalizedUrl,
                sources: new Set<string>(),
                rawHrefs: new Set<string>(),
                htmlSnippets: new Set<string>(),
                zones: new Set<LinkZone>()
            };
            this.externalLinks.set(link.normalizedUrl, record);
        }

        record.sources.add(link.referer);
        record.rawHrefs.add(link.rawHref);
        if(typeof link.htmlSnippet === 'string' && link.htmlSnippet !== '') {
            record.htmlSnippets.add(link.htmlSnippet);
        }
        record.zones.add(link.zone ?? 'unknown');
    }

    private async auditExternalLinks(): Promise<void> {
        if(!this.includeExternal) {
            return;
        }

        // External audits run with bounded concurrency and a per-URL budget so a few slow
        // third-party sites do not stall the whole report.
        const config: AxiosRequestConfig = {
            maxRedirects: 0,
            timeout: externalCheckTimeoutMs,
            headers: {
                ...externalCheckRequestHeaders
            },
            httpAgent: new http.Agent({
                timeout: externalCheckTimeoutMs
            }),
            httpsAgent: new https.Agent({
                timeout: externalCheckTimeoutMs,
                requestCert: false,
                rejectUnauthorized: this.config.getConfigBoolean('requestTls.rejectUnauthorized', null, true)
            }),
            signal: this.runtime.abortSignal
        };

        const externalLinks = Array.from(this.externalLinks.values());
        this.profiler.markJob(this.handle, 'shutdown',
            `external link audit starting (${externalLinks.length} unique URLs, ${Math.min(externalCheckConcurrency, externalLinks.length)} workers, ${(externalCheckTimeoutMs / 1000).toFixed(1)}s timeout, ${externalCheckMaxAttempts} attempts, ${(externalCheckUrlTimeoutMs / 1000).toFixed(1)}s URL budget)`
        );
        let index = 0;
        let completed = 0;
        const workers = Array.from(
            {length: Math.min(externalCheckConcurrency, externalLinks.length)},
            async () => {
                while(index < externalLinks.length && !this.runtime.aborted) {
                    const externalLink = externalLinks[index++];
                    const startedAt = Date.now();
                    await this.auditExternalLinkWithTimeout(externalLink, config);
                    const elapsedMs = Date.now() - startedAt;
                    completed++;
                    if(elapsedMs >= 1000 || completed % 25 === 0 || completed === externalLinks.length) {
                        this.profiler.markJob(this.handle, 'shutdown',
                            `external link checked ${completed}/${externalLinks.length} in ${(elapsedMs / 1000).toFixed(2)}s: ${externalLink.targetUrl}`
                        );
                    }
                }
            }
        );
        await Promise.all(workers);
    }

    private async auditExternalLinkWithTimeout(externalLink: ExternalLinkRecord, config: AxiosRequestConfig): Promise<void> {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort(`External link audit exceeded ${(externalCheckUrlTimeoutMs / 1000).toFixed(1)}s URL budget.`);
        }, externalCheckUrlTimeoutMs);

        try {
            const signals = [controller.signal];
            if(typeof config.signal !== 'undefined') {
                signals.push(config.signal as AbortSignal);
            }
            await this.auditExternalLink(externalLink, {
                ...config,
                signal: AbortSignal.any(signals)
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    private async auditExternalLink(externalLink: ExternalLinkRecord, config: AxiosRequestConfig): Promise<void> {
        // HEAD is the primary external check. Fallback GET/HTTPS-upgrade checks reduce false
        // positives from sites that block HEAD or only serve the secure URL.
        if(this.runtime.aborted) {
            return;
        }

        const sourceUrl = Array.from(externalLink.sources)[0];
        const rawHref = Array.from(externalLink.rawHrefs)[0];
        const htmlSnippet = Array.from(externalLink.htmlSnippets)[0];
        const zone = Array.from(externalLink.zones)[0] ?? 'unknown';
        try {
            const response = await this.externalHead(externalLink.targetUrl, config);
            if(this.isBotProtectionResponse(response)) {
                this.addExternalBotProtectionNotice(externalLink, response.status);
                return;
            }
        } catch (e) {
            if(this.runtime.aborted) {
                return;
            }

            if(axios.isAxiosError(e) && typeof e.response !== 'undefined') {
                if(this.isBotProtectionResponse(e.response)) {
                    this.addExternalBotProtectionNotice(externalLink, e.response.status);
                    return;
                }
                const status = e.response.status;
                if(status >= 300 && status < 400) {
                    if(this.runtime.aborted) {
                        return;
                    }
                    this.addIssue({
                        severity: 'warning',
                        group: 'External Links',
                        code: 'external-redirect',
                        message: 'External link returned a redirect response.',
                        targetUrl: externalLink.targetUrl,
                        sourceUrl,
                        rawHref,
                        htmlSnippet,
                        statusCode: status,
                        finalUrl: String(e.response.headers.location ?? ''),
                        zone
                    });
                } else if(status >= 400) {
                    const httpsUrl = await this.getReachableHttpsUpgradeUrl(externalLink.targetUrl, config);
                    if(this.runtime.aborted) {
                        return;
                    }
                    if(httpsUrl !== null) {
                        this.addIssue({
                            severity: 'error',
                            group: 'External Links',
                            code: 'external-http-upgrade-available',
                            message: 'External HTTP link failed, but the HTTPS version responded successfully.',
                            targetUrl: externalLink.targetUrl,
                            sourceUrl,
                            rawHref,
                            htmlSnippet,
                            statusCode: status,
                            finalUrl: httpsUrl,
                            zone
                        });
                        return;
                    }

                    const fallbackConfig = this.getExternalFallbackConfig(config);
                    const protectedStatus = await this.getExternalOrHttpsUpgradeBotProtectionStatus(
                        externalLink.targetUrl,
                        fallbackConfig
                    );
                    if(protectedStatus !== null) {
                        this.addExternalBotProtectionNotice(externalLink, protectedStatus);
                        return;
                    }
                    if(this.runtime.aborted) {
                        return;
                    }

                    if(await this.externalGetShowsReachableOrProtected(
                        externalLink.targetUrl,
                        fallbackConfig
                    )) {
                        return;
                    }
                    if(this.runtime.aborted) {
                        return;
                    }

                    this.addIssue({
                        severity: 'error',
                        group: 'External Links',
                        code: 'external-error',
                        message: 'External link returned an error response.',
                        targetUrl: externalLink.targetUrl,
                        sourceUrl,
                        rawHref,
                        htmlSnippet,
                        statusCode: status,
                        zone
                    });
                }
                return;
            }

            if(this.isTemporaryDnsFailure(e)) {
                if(this.runtime.aborted) {
                    return;
                }
                this.addIssue({
                    severity: 'warning',
                    group: 'External Links',
                    code: 'external-dns-temporary-failure',
                    message: 'External link DNS lookup failed with EAI_AGAIN.',
                    targetUrl: externalLink.targetUrl,
                    sourceUrl,
                    rawHref,
                    htmlSnippet,
                    statusCode: 0,
                    networkErrorCode: 'EAI_AGAIN',
                    networkErrorMessage: e instanceof Error ? e.message : String(e),
                    zone
                });
                return;
            }

            const httpsUrl = await this.getReachableHttpsUpgradeUrl(externalLink.targetUrl, config);
            if(this.runtime.aborted) {
                return;
            }
            if(httpsUrl !== null) {
                this.addIssue({
                    severity: 'error',
                    group: 'External Links',
                    code: 'external-http-upgrade-available',
                    message: 'External HTTP link failed, but the HTTPS version responded successfully.',
                    targetUrl: externalLink.targetUrl,
                    sourceUrl,
                    rawHref,
                    htmlSnippet,
                    statusCode: 0,
                    finalUrl: httpsUrl,
                    zone
                });
                return;
            }

            const protectedStatus = await this.getExternalOrHttpsUpgradeBotProtectionStatus(
                externalLink.targetUrl,
                this.getExternalFallbackConfig(config)
            );
            if(protectedStatus !== null) {
                this.addExternalBotProtectionNotice(externalLink, protectedStatus);
                return;
            }
            if(this.runtime.aborted) {
                return;
            }

            this.addIssue({
                severity: 'warning',
                group: 'External Links',
                code: 'external-fetch-failed',
                message: 'External link did not respond to a HEAD request.',
                targetUrl: externalLink.targetUrl,
                sourceUrl,
                rawHref,
                htmlSnippet,
                statusCode: 0,
                zone
            });
        }
    }

    private addExternalBotProtectionNotice(externalLink: ExternalLinkRecord, statusCode?: number): void {
        const sourceUrl = Array.from(externalLink.sources)[0];
        const rawHref = Array.from(externalLink.rawHrefs)[0];
        const htmlSnippet = Array.from(externalLink.htmlSnippets)[0];
        const zone = Array.from(externalLink.zones)[0] ?? 'unknown';

        this.addIssue({
            severity: 'notice',
            group: 'External Links',
            code: 'external-bot-protection',
            message: 'External link returned a bot protection or edge security response.',
            targetUrl: externalLink.targetUrl,
            sourceUrl,
            rawHref,
            htmlSnippet,
            statusCode,
            zone
        });
    }

    private async externalGetShowsReachableOrProtected(url: string, config: AxiosRequestConfig): Promise<boolean> {
        if(this.runtime.aborted) {
            return false;
        }

        try {
            const response = await this.externalGet(url, config, false);
            return response.status >= 200 && response.status < 300
                || response.status >= 300 && response.status < 400
                || this.isBotProtectionResponse(response);
        } catch (e) {
            if(this.runtime.aborted || this.isAbortError(e)) {
                return false;
            }

            return axios.isAxiosError(e)
                && typeof e.response !== 'undefined'
                && (
                    this.isBotProtectionResponse(e.response)
                    || e.response.status >= 200 && e.response.status < 400
                );
        }
    }

    private async externalGetShowsReachable(url: string, config: AxiosRequestConfig): Promise<boolean> {
        if(this.runtime.aborted) {
            return false;
        }

        try {
            const response = await this.externalGet(url, config, false);
            return response.status >= 200 && response.status < 400;
        } catch (e) {
            if(this.runtime.aborted || this.isAbortError(e)) {
                return false;
            }

            return axios.isAxiosError(e)
                && typeof e.response !== 'undefined'
                && e.response.status >= 200
                && e.response.status < 400;
        }
    }

    private getExternalFallbackConfig(config: AxiosRequestConfig): AxiosRequestConfig {
        return {
            ...config,
            timeout: externalCheckTimeoutMs
        };
    }

    private isTemporaryDnsFailure(error: unknown): boolean {
        return axios.isAxiosError(error) && error.code === 'EAI_AGAIN';
    }

    private async getReachableHttpsUpgradeUrl(url: string, config: AxiosRequestConfig): Promise<string|null> {
        if(this.runtime.aborted) {
            return null;
        }

        const httpsUrl = this.getHttpsUpgradeUrl(url);
        if(httpsUrl === null) {
            return null;
        }

        const fallbackConfig = this.getExternalFallbackConfig(config);
        try {
            const response = await this.externalHead(httpsUrl, fallbackConfig, false);
            if(response.status >= 200 && response.status < 300) {
                return httpsUrl;
            }
        } catch (e) {
            if(this.runtime.aborted || this.isAbortError(e)) {
                return null;
            }

            if(axios.isAxiosError(e) && typeof e.response !== 'undefined') {
                if(e.response.status >= 200 && e.response.status < 400) {
                    return httpsUrl;
                }
            }
        }

        if(this.runtime.aborted) {
            return null;
        }

        return await this.externalGetShowsReachable(httpsUrl, fallbackConfig)
            ? httpsUrl
            : null;
    }

    private getHttpsUpgradeUrl(url: string): string|null {
        if(this.baseProtocol !== 'https:') {
            return null;
        }

        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }

        if(parsed.protocol !== 'http:') {
            return null;
        }

        parsed.protocol = 'https:';
        return parsed.href;
    }

    private async getExternalBotProtectionStatus(url: string, config: AxiosRequestConfig): Promise<number|null> {
        if(this.runtime.aborted) {
            return null;
        }

        try {
            const response = await this.externalGet(url, config, false);
            return this.isBotProtectionResponse(response) ? response.status : null;
        } catch (e) {
            if(this.runtime.aborted || this.isAbortError(e)) {
                return null;
            }

            if(axios.isAxiosError(e)
                && typeof e.response !== 'undefined'
                && this.isBotProtectionResponse(e.response)) {
                return e.response.status;
            }

            return null;
        }
    }

    private async getExternalOrHttpsUpgradeBotProtectionStatus(url: string, config: AxiosRequestConfig): Promise<number|null> {
        const status = await this.getExternalBotProtectionStatus(url, config);
        if(status !== null) {
            return status;
        }

        const httpsUrl = this.getHttpsUpgradeUrl(url);
        if(httpsUrl === null || this.runtime.aborted) {
            return null;
        }

        return await this.getExternalBotProtectionStatus(httpsUrl, config);
    }

    private async externalGet(url: string, config: AxiosRequestConfig, retry = true): Promise<AxiosResponse<string>> {
        return await this.runExternalRequest(async () => {
            return await axios.get<string>(url, {
                ...this.getExternalRequestConfig(config),
                responseType: 'text',
                transformResponse: data => String(data),
                headers: {
                    ...defaultRequestHeaders,
                    ...(config.headers ?? {})
                }
            });
        }, retry);
    }

    private async externalHead(url: string, config: AxiosRequestConfig, retry = true): Promise<AxiosResponse<void>> {
        return await this.runExternalRequest(async () => {
            return await axios.head<void>(url, this.getExternalRequestConfig(config));
        }, retry);
    }

    private getExternalRequestConfig(config: AxiosRequestConfig): AxiosRequestConfig {
        const timeoutSignal = AbortSignal.timeout(externalCheckTimeoutMs);
        const signal = typeof config.signal === 'undefined'
            ? timeoutSignal
            : AbortSignal.any([config.signal as AbortSignal, timeoutSignal]);

        return {
            ...config,
            timeout: externalCheckTimeoutMs,
            signal
        };
    }

    private async runExternalRequest<T>(request: () => Promise<T>, retry: boolean): Promise<T> {
        let lastError: unknown;
        const maxAttempts = retry ? externalCheckMaxAttempts : 1;
        for(let attempt = 1; attempt <= maxAttempts; attempt++) {
            if(this.runtime.aborted) {
                throw new Error('External link audit aborted.');
            }

            try {
                return await request();
            } catch (e) {
                lastError = e;
                if(this.runtime.aborted || this.isAbortError(e)) {
                    throw e;
                }
                if(!this.shouldRetryExternalRequest(e) || attempt === maxAttempts) {
                    throw e;
                }
            }
        }

        throw lastError;
    }

    private shouldRetryExternalRequest(error: unknown): boolean {
        return axios.isAxiosError(error)
            && typeof error.response === 'undefined'
            && !this.runtime.aborted
            && !this.isAbortError(error);
    }

    private isAbortError(error: unknown): boolean {
        return axios.isAxiosError(error) && error.code === 'ERR_CANCELED';
    }

    private isBotProtectionResponse(response: AxiosResponse<unknown>): boolean {
        // Bot protection responses are treated as inconclusive instead of broken; many WAFs
        // intentionally reject automated link checkers while serving normal browsers.
        const headerText = this.getHeaderText(response);
        const body = typeof response.data === 'string' ? response.data.toLowerCase() : '';

        return botProtectionHeuristics.headerMarkers.some(marker => headerText.includes(marker))
            || botProtectionHeuristics.bodyMarkers.some(marker => body.includes(marker));
    }

    private getHeaderText(response: AxiosResponse<unknown>): string {
        const chunks: string[] = [];
        Object.entries(response.headers).forEach(([key, value]) => {
            if(Array.isArray(value)) {
                chunks.push(`${key}: ${value.join(' ')}`);
                return;
            }
            chunks.push(`${key}: ${String(value)}`);
        });

        return chunks.join('\n').toLowerCase();
    }

    private auditCanonical(pageData: PageData): string|null {
        // Canonical auditing happens early because it can suppress duplicate outgoing-link
        // audits for non-canonical pages that point at already processed canonical targets.
        if(typeof pageData.jsdom === 'undefined') {
            return null;
        }

        const canonicalElements = Array.from(pageData.jsdom.querySelectorAll('head link[rel="canonical"]'));
        if(canonicalElements.length === 0) {
            this.addIssue({
                severity: 'notice',
                group: 'Canonical Issues',
                code: 'missing-canonical',
                message: 'Page does not include a canonical link tag.',
                targetUrl: pageData.location.url,
                sourceUrl: pageData.location.url,
                pageUrl: pageData.location.url,
                expectedCanonicalUrl: pageData.location.url,
                zone: 'unknown'
            });
            return null;
        }

        const canonicalHrefs = canonicalElements.map(element => element.getAttribute('href') ?? '[missing]');
        if(canonicalElements.length > 1) {
            this.addIssue({
                severity: 'warning',
                group: 'Canonical Issues',
                code: 'multiple-canonicals',
                message: 'Page includes multiple canonical link tags.',
                targetUrl: pageData.location.url,
                sourceUrl: pageData.location.url,
                pageUrl: pageData.location.url,
                canonicalUrl: canonicalHrefs[0],
                expectedCanonicalUrl: pageData.location.url,
                canonicalHrefs,
                zone: 'unknown'
            });
        }

        const canonicalHref = canonicalElements[0].getAttribute('href');
        if(canonicalHref === null || canonicalHref.trim() === '') {
            this.addIssue({
                severity: 'warning',
                group: 'Canonical Issues',
                code: 'empty-canonical',
                message: 'Canonical link href is empty.',
                targetUrl: pageData.location.url,
                sourceUrl: pageData.location.url,
                rawHref: canonicalHref ?? '',
                pageUrl: pageData.location.url,
                canonicalUrl: canonicalHref ?? '',
                expectedCanonicalUrl: pageData.location.url,
                zone: 'unknown'
            });
            return null;
        }

        let canonicalUrl: URL;
        try {
            canonicalUrl = new URL(decodeURIComponent(canonicalHref).trim(), pageData.location.url);
        } catch (e) {
            if(pageData.parseWarnings.some(warning => warning.type === 'malformed-canonical'
                && warning.rawValue === canonicalHref)) {
                return null;
            }
            this.addIssue(this.issueFromParseWarning({
                type: 'malformed-canonical',
                message: e instanceof Error ? e.message : String(e),
                rawValue: canonicalHref,
                referer: pageData.location.url
            }));
            return null;
        }

        const canonicalHrefUrl = canonicalUrl.href;
        if(this.normalizeHostname(canonicalUrl.hostname) !== this.baseHostname) {
            this.addIssue({
                severity: 'warning',
                group: 'Canonical Issues',
                code: 'offsite-canonical',
                message: 'Canonical link points to an offsite URL.',
                targetUrl: canonicalHrefUrl,
                sourceUrl: pageData.location.url,
                rawHref: canonicalHref,
                pageUrl: pageData.location.url,
                canonicalUrl: canonicalHrefUrl,
                expectedCanonicalUrl: pageData.location.url,
                zone: 'unknown'
            });
            return null;
        }

        if(this.baseProtocol === 'https:' && canonicalUrl.protocol === 'http:') {
            this.addIssue({
                severity: 'warning',
                group: 'Canonical Issues',
                code: 'http-canonical',
                message: 'Canonical link uses HTTP on an HTTPS crawl.',
                targetUrl: canonicalHrefUrl,
                sourceUrl: pageData.location.url,
                rawHref: canonicalHref,
                pageUrl: pageData.location.url,
                canonicalUrl: canonicalHrefUrl,
                expectedCanonicalUrl: this.normalizeInternalUrl(canonicalHrefUrl.replace(/^http:/i, 'https:')),
                zone: 'unknown'
            });
        }

        const normalizedCanonical = this.normalizeInternalUrl(canonicalHrefUrl);
        this.canonicalReferences.push({
            sourceUrl: pageData.location.url,
            canonicalUrl: normalizedCanonical
        });

        const basePath = this.baseUrl.replace(/\/+$/, '');
        const pattern = new RegExp(`^${escapeRegExp(basePath)}`);
        if(pageData.location.url !== normalizedCanonical
            && this.isCanonicalQueryVariant(pageData.location.url, normalizedCanonical)) {
            this.addIssue({
                severity: 'notice',
                group: 'Canonical Issues',
                code: 'canonical-query-variant',
                message: 'Internal link target differs from its canonical URL only by query string.',
                targetUrl: pageData.location.url,
                sourceUrl: pageData.location.referer,
                htmlSnippet: pageData.location.htmlSnippet,
                finalUrl: normalizedCanonical,
                pageUrl: pageData.location.url,
                linkedUrl: pageData.location.url,
                canonicalUrl: normalizedCanonical,
                expectedCanonicalUrl: normalizedCanonical,
                zone: 'unknown'
            });
        } else if(pageData.location.url !== normalizedCanonical
            && this.allowedNonCanonicalLinks.indexOf(normalizedCanonical.replace(pattern, '')) === -1) {
            this.nonCanonicalTargets.add(pageData.location.url);
            this.addIssue({
                severity: 'warning',
                group: 'Canonical Issues',
                code: 'non-canonical-internal-link',
                message: 'Internal link target differs from its canonical URL.',
                targetUrl: pageData.location.url,
                sourceUrl: pageData.location.referer,
                htmlSnippet: pageData.location.htmlSnippet,
                finalUrl: normalizedCanonical,
                pageUrl: pageData.location.url,
                linkedUrl: pageData.location.url,
                canonicalUrl: normalizedCanonical,
                expectedCanonicalUrl: normalizedCanonical,
                zone: 'unknown'
            });
        }

        return normalizedCanonical;
    }

    private isCanonicalQueryVariant(pageUrl: string, canonicalUrl: string): boolean {
        try {
            const page = new URL(pageUrl);
            const canonical = new URL(canonicalUrl);
            page.search = '';
            canonical.search = '';
            return this.normalizeInternalUrl(page.href) === this.normalizeInternalUrl(canonical.href);
        } catch {
            return false;
        }
    }

    private shouldSkipOutgoingLinkAudit(pageData: PageData, canonicalUrl: string|null): boolean {
        if(canonicalUrl === null || canonicalUrl === pageData.location.url) {
            return false;
        }

        if(this.isCanonicalQueryVariant(pageData.location.url, canonicalUrl)) {
            return false;
        }

        return this.processedPageUrls.has(canonicalUrl);
    }

    private auditCanonicalTargets(): void {
        // Once crawling is done, verify that collected canonical targets actually resolved
        // and do not point through redirects.
        this.canonicalReferences.forEach(reference => {
            const statusRecord = this.statusByUrl.get(reference.canonicalUrl);
            if(typeof statusRecord === 'undefined') {
                return;
            }

            if(statusRecord.status === 0 || statusRecord.status >= 400) {
                this.addIssue({
                    severity: 'error',
                    group: 'Canonical Issues',
                    code: 'canonical-target-failed',
                    message: 'Canonical target failed to fetch.',
                    targetUrl: reference.canonicalUrl,
                    sourceUrl: reference.sourceUrl,
                    pageUrl: reference.sourceUrl,
                    canonicalUrl: reference.canonicalUrl,
                    expectedCanonicalUrl: reference.canonicalUrl,
                    statusCode: statusRecord.status,
                    zone: 'unknown'
                });
            } else if(statusRecord.status >= 300 && statusRecord.status < 400) {
                this.addIssue({
                    severity: 'warning',
                    group: 'Canonical Issues',
                    code: 'canonical-target-redirects',
                    message: 'Canonical target returns a redirect response.',
                    targetUrl: reference.canonicalUrl,
                    sourceUrl: reference.sourceUrl,
                    pageUrl: reference.sourceUrl,
                    canonicalUrl: reference.canonicalUrl,
                    expectedCanonicalUrl: statusRecord.location.redirectedTo,
                    statusCode: statusRecord.status,
                    finalUrl: statusRecord.location.redirectedTo,
                    redirectChain: statusRecord.location.redirectChain,
                    zone: 'unknown'
                });
            }
        });
    }

    private auditRedirects(): void {
        // Redirect analysis is deferred until final target statuses are known.
        this.redirectSources.forEach(location => {
            const chain = location.redirectChain ?? [location.url, location.redirectedTo ?? ''];
            const cleanChain = chain.filter(url => url !== '');
            const loopDetected = new Set(cleanChain).size !== cleanChain.length;
            const finalUrl = cleanChain[cleanChain.length - 1];
            const finalStatus = this.statusByUrl.get(finalUrl)?.status;
            const chained = cleanChain.length > 2;
            const startedWith302 = location.statusCode === 302 || location.redirectCode === 302;
            const finalIsNonCanonical = this.nonCanonicalTargets.has(finalUrl);

            if(loopDetected) {
                this.addIssue({
                    severity: 'error',
                    group: 'Redirects',
                    code: 'redirect-loop',
                    message: 'Redirect chain appears to loop.',
                    targetUrl: location.url,
                    sourceUrl: location.referer,
                    htmlSnippet: location.htmlSnippet,
                    finalUrl,
                    statusCode: location.statusCode,
                    redirectChain: cleanChain,
                    zone: 'unknown'
                });
                return;
            }

            if(typeof finalStatus === 'number' && (finalStatus === 0 || finalStatus >= 400)) {
                this.addIssue({
                    severity: 'error',
                    group: 'Redirects',
                    code: 'redirect-final-target-failed',
                    message: 'Redirect final target failed to fetch.',
                    targetUrl: location.url,
                    sourceUrl: location.referer,
                    htmlSnippet: location.htmlSnippet,
                    finalUrl,
                    statusCode: finalStatus,
                    redirectChain: cleanChain,
                    zone: 'unknown'
                });
                return;
            }

            if(chained) {
                this.addIssue({
                    severity: 'warning',
                    group: 'Redirects',
                    code: 'redirect-chain',
                    message: 'Redirect requires multiple hops.',
                    targetUrl: location.url,
                    sourceUrl: location.referer,
                    htmlSnippet: location.htmlSnippet,
                    finalUrl,
                    statusCode: location.statusCode,
                    redirectChain: cleanChain,
                    zone: 'unknown'
                });
            }

            if(startedWith302 && finalIsNonCanonical) {
                this.addIssue({
                    severity: 'warning',
                    group: 'Redirects',
                    code: 'redirect-final-target-non-canonical',
                    message: 'Temporary redirect final target is non-canonical.',
                    targetUrl: location.url,
                    sourceUrl: location.referer,
                    htmlSnippet: location.htmlSnippet,
                    finalUrl,
                    statusCode: location.statusCode,
                    redirectChain: cleanChain,
                    zone: 'unknown'
                });
            }
        });
    }

    private trackLinkOccurrences(pageData: PageData): void {
        pageData.rawLinks.forEach(link => {
            if(!link.isCrawlable || typeof link.normalizedUrl !== 'string') {
                return;
            }
            this.recordIssueOccurrence(link.normalizedUrl, pageData.location.url, link.zone ?? 'unknown');
        });
    }

    private trackPageAnchors(pageData: PageData): void {
        if(typeof pageData.jsdom === 'undefined') {
            return;
        }

        const anchors = new Set<string>();
        pageData.jsdom.querySelectorAll('[id], a[name]').forEach(element => {
            const id = element.getAttribute('id');
            if(id !== null && id !== '') {
                anchors.add(id);
            }
            const name = element.getAttribute('name');
            if(name !== null && name !== '') {
                anchors.add(name);
            }
        });
        this.pageAnchors.set(pageData.location.url, anchors);
    }

    private recordIssueOccurrence(targetUrl: string, referer: string, zone: LinkZone): void {
        // Occurrence tracking powers wrapper inference and helps reports show whether a fix
        // likely belongs in shared navigation/layout or on a single page.
        const summary = this.getLinkOccurrenceSummary(targetUrl);
        summary.occurrenceCount++;
        summary.pageUrls.add(referer);
        summary.zones[zone]++;
        summary.occurrences.push({referer, zone});
        if(wrapperZones.has(zone)) {
            summary.wrapperOccurrenceCount++;
            summary.wrapperPageUrls.add(referer);
        }
    }

    private getLinkOccurrenceSummary(targetUrl: string): LinkOccurrenceSummary {
        let summary = this.issueOccurrences.get(targetUrl);
        if(typeof summary === 'undefined') {
            summary = {
                targetUrl,
                occurrenceCount: 0,
                pageUrls: new Set<string>(),
                wrapperOccurrenceCount: 0,
                wrapperPageUrls: new Set<string>(),
                zones: {
                    nav: 0,
                    header: 0,
                    footer: 0,
                    aside: 0,
                    'before-main': 0,
                    'after-main': 0,
                    main: 0,
                    unknown: 0
                },
                occurrences: []
            };
            this.issueOccurrences.set(targetUrl, summary);
        }
        return summary;
    }

    private getWrapperMeta(targetUrl: string): WrapperMeta|null {
        // If the same issue appears across most scanned pages, treat it as a likely shared
        // wrapper/template issue so the report points developers toward one central fix.
        const summary = this.issueOccurrences.get(targetUrl);
        if(typeof summary === 'undefined' || this.scannedPageCount === 0) {
            return null;
        }

        const wrapperPagePercent = summary.wrapperPageUrls.size / this.scannedPageCount;
        if(wrapperPagePercent >= 0.75 && summary.wrapperPageUrls.size > 1) {
            return {
                summary,
                topWrapperZone: this.getTopZone(summary, true),
                wrapperPagePercent,
                pageUrls: summary.wrapperPageUrls,
                occurrenceCount: summary.wrapperOccurrenceCount,
                inferredSharedLayout: false
            };
        }

        const repeatedPagePercent = summary.pageUrls.size / this.scannedPageCount;
        if(repeatedPagePercent >= 0.75 && summary.pageUrls.size > 1) {
            return {
                summary,
                topWrapperZone: this.getTopZone(summary),
                wrapperPagePercent: repeatedPagePercent,
                pageUrls: summary.pageUrls,
                occurrenceCount: summary.occurrenceCount,
                inferredSharedLayout: true
            };
        }

        return null;
    }

    private getTopZone(summary: LinkOccurrenceSummary, wrapperOnly = false): LinkZone {
        let topZone: LinkZone = 'unknown';
        let topCount = 0;
        for(const zone of Object.keys(summary.zones) as LinkZone[]) {
            if(wrapperOnly && !wrapperZones.has(zone)) {
                continue;
            }
            if(summary.zones[zone] > topCount) {
                topZone = zone;
                topCount = summary.zones[zone];
            }
        }
        return topZone;
    }

    private reportWrapperMeta(meta: WrapperMeta, theme: string): void {
        const summary = meta.summary;
        const percent = Math.round(meta.wrapperPagePercent * 100);
        const label = meta.inferredSharedLayout
            ? 'Repeated issue: likely shared layout/template'
            : `Wrapper link: likely ${meta.topWrapperZone}`;
        this.reportLine(
            `${label}; found on `
                + `${meta.pageUrls.size} of ${this.scannedPageCount} scanned pages `
                + `(${percent}%), ${meta.occurrenceCount} occurrences.`,
            theme,
            4
        );

        const samples = Array.from(meta.pageUrls).slice(0, 3);
        if(samples.length > 0) {
            this.reportLine('Sample referers:', theme, 4);
            samples.forEach(sample => {
                this.reportLine(sample, theme, 5);
            });
        }

        if(this.verbosityLevel >= 1) {
            this.reportLine(`Zones: ${this.getZoneSummary(summary)}`, theme, 4);
        }

        if(this.verbosityLevel >= 2) {
            let occurrences = summary.occurrences;
            if(this.verbosityLevel >= 3) {
                occurrences = [...occurrences].sort((a, b) => a.referer.localeCompare(b.referer));
            }
            this.reportLine('Occurrences:', theme, 4);
            occurrences.forEach(occurrence => {
                this.reportLine(`${occurrence.zone}: ${occurrence.referer}`, theme, 5);
            });
        }
    }

    private getZoneSummary(summary: LinkOccurrenceSummary): string {
        const zones: string[] = [];
        for(const zone of Object.keys(summary.zones) as LinkZone[]) {
            const count = summary.zones[zone];
            if(count > 0) {
                zones.push(`${zone} ${count}`);
            }
        }
        return zones.join(', ');
    }

    private normalizeInternalUrl(url: string): string {
        const parsed = new URL(url);
        if(this.normalizeHostname(parsed.hostname) !== this.baseHostname) {
            return parsed.href;
        }

        return this.baseUrl.replace(/\/+$/, '') + parsed.pathname + parsed.search;
    }

    private stripHash(url: string): string {
        const parsed = new URL(url);
        parsed.hash = '';
        return this.normalizeHostname(parsed.hostname) === this.baseHostname
            ? this.normalizeInternalUrl(parsed.href)
            : parsed.href;
    }

    private normalizeHostname(hostname: string): string {
        return hostname.replace(/^www\./i, '').toLowerCase();
    }
}
