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
    ConfigService,
    defaultRequestHeaders,
    OutputHelper,
    UrlHelper,
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
}

interface LinkIssuesConfig extends JSONObject {
    allowedNonCanonicalLinks: string[];
    emailReportEnabled: boolean;
    emailReportTriggerLevels: LinkIssueSeverity[]|null;
    undesirablePathCharacterPattern: string;
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
const reportIndent = '  ';
const reportGroupOrder = [
    'Client Errors',
    'Server Errors',
    'Failed Fetches',
    'Redirects',
    'External Links',
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
    scannedPageCount = 0;

    baseUrl: string;
    baseProtocol: string;
    baseHostname: string;
    allowedNonCanonicalLinks: string[] = [];
    undesirablePathCharacterPattern = /[^\w\-/.]/;
    emailReportTriggerLevels: LinkIssueSeverity[]|null = ['error', 'warning', 'notice'];
    includeNotices: boolean;
    includeExternal: boolean;
    promptOutput: boolean;

    constructor(handle: string, command: JobCommandParser, profiler: Profiler) {
        super(handle, command, profiler);
        this.console = new OutputHelper();
        this.baseUrl = ConfigService.getConfigString('baseUrl');
        const base = new URL(this.baseUrl);
        this.baseProtocol = base.protocol;
        this.baseHostname = this.normalizeHostname(base.hostname);
        this.includeNotices = command.arguments['-n']?.active === true
            || command.arguments['--include-notices']?.active === true;
        this.includeExternal = command.arguments['-e']?.active === true
            || command.arguments['--include-external']?.active === true;
        this.promptOutput = command.arguments['-p']?.active === true
            || command.arguments['--prompt']?.active === true;

    }

    loadConfig(): void {
        // Config controls reporting thresholds and URL-quality policy. Command switches
        // decide whether optional notice/external/prompt output is enabled for this run.
        const config = ConfigService.getJobConfig<LinkIssuesConfig>({
            allowedNonCanonicalLinks: [],
            emailReportTriggerLevels: ['error', 'warning', 'notice'],
            undesirablePathCharacterPattern: '[^\\w\\-/.]',
            emailReportEnabled: true
        }, this.command, false);
        this.emailReportEnabled = config.emailReportEnabled;
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
        this.processedPageUrls.add(_pageData.location.url);
    }

    async onEnd() {
        try {
            // End-of-crawl checks need the full site picture: external URL de-dupes,
            // redirect chains, cross-page fragments, and canonical target statuses.
            this.profiler.markJob(this.handle, 'shutdown', 'starting shutdown');
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
            this.completed = true;
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
        if(typeof issue.sourceUrl === 'string' && typeof issue.zone !== 'undefined') {
            this.recordIssueOccurrence(key, issue.sourceUrl, issue.zone);
            if(reportKey !== key) {
                this.recordIssueOccurrence(reportKey, issue.sourceUrl, issue.zone);
            }
        }
    }

    private getIssueKey(issue: LinkIssue): string {
        return [
            issue.severity,
            issue.group,
            issue.code,
            issue.targetUrl ?? '',
            issue.normalizedUrl ?? '',
            issue.rawHref ?? '',
            issue.statusCode ?? ''
        ].join('|');
    }

    private shouldSuppressIssue(issue: LinkIssue): boolean {
        return this.isFilteredInternalUrl(issue.sourceUrl)
            || this.isFilteredInternalUrl(issue.targetUrl)
            || this.isFilteredInternalUrl(issue.normalizedUrl)
            || this.isFilteredInternalUrl(issue.finalUrl);
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
        return !UrlHelper.validateLocation(normalizedUrl, 'urlCantContain')
            || !UrlHelper.validateLocation(normalizedUrl, 'urlMustContain');
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
        if(typeof issue.rawHref === 'string') {
            details.push(`Raw href: ${issue.rawHref === '' ? '[empty]' : issue.rawHref}`);
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
            '- Before changing markup, determine whether each listed anchor is true navigation or a UI/action trigger.',
            '- If JavaScript event handlers, dropdown behavior, modal triggers, tabs, accordions, or similar UI behavior are attached, preserve that behavior while using the semantically correct element.',
            '- Preserve existing behavior and avoid unrelated refactors.',
            '- After making changes, run the project checks and rerun the link issue report if available.'
        ];

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
                    'Use a browser or curl to confirm the target because some external services handle HEAD differently than GET.'
                ];
            case 'external-error':
                return [
                    `These external links returned ${status}error responses to crawler checks.`,
                    'Verify the URL in a browser, then update it to a reachable destination or remove it if the resource is gone.',
                    'If the site blocks automated checks but works for users, document that decision before suppressing or ignoring it.'
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
                    'If curl/browser verification succeeds, treat this as a crawler environment DNS issue; if it fails from a normal shell too, investigate the hostname, DNS records, or network resolver.'
                ];
            case 'external-fetch-failed':
                return [
                    'These external links did not respond to the crawler HEAD request.',
                    'Verify each target manually; replace dead URLs, remove obsolete links, or keep working URLs that merely block automated checks.',
                    'Avoid changing working third-party URLs solely because their server rejects HEAD requests.'
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
        if(typeof issue.rawHref === 'string') {
            details.push(`Raw href: ${issue.rawHref === '' ? '[empty]' : issue.rawHref}`);
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
            entry.count++;
            if(typeof issue.sourceUrl === 'string') {
                entry.sourceUrls.add(issue.sourceUrl);
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
            'fetch-failed'
        ].indexOf(issue.code) !== -1;
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
        if(typeof issue.rawHref === 'string') {
            this.reportLine(`Raw href: ${issue.rawHref === '' ? '[empty]' : issue.rawHref}`, theme, 4);
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
                    normalizedUrl: link.normalizedUrl,
                    decodedPath,
                    zone: link.zone ?? 'unknown'
                });
            }

            this.auditFragment(link, pageData);
            this.trackExternalLink(link);
        });
    }

    private compileUndesirablePathCharacterPattern(pattern: string): RegExp {
        try {
            return new RegExp(pattern);
        } catch {
            return /[^\w\-/.]/;
        }
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
        if(typeof link.normalizedUrl !== 'string') {
            return null;
        }

        let parsed: URL;
        try {
            parsed = new URL(link.normalizedUrl);
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
                zones: new Set<LinkZone>()
            };
            this.externalLinks.set(link.normalizedUrl, record);
        }

        record.sources.add(link.referer);
        record.rawHrefs.add(link.rawHref);
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
                ...defaultRequestHeaders
            },
            httpAgent: new http.Agent({
                timeout: externalCheckTimeoutMs
            }),
            httpsAgent: new https.Agent({
                timeout: externalCheckTimeoutMs,
                requestCert: false,
                rejectUnauthorized: ConfigService.getConfigBoolean('requestTls.rejectUnauthorized', null, true)
            })
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
                while(index < externalLinks.length) {
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
            await this.auditExternalLink(externalLink, {
                ...config,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    private async auditExternalLink(externalLink: ExternalLinkRecord, config: AxiosRequestConfig): Promise<void> {
        // HEAD is the primary external check. Fallback GET/HTTPS-upgrade checks reduce false
        // positives from sites that block HEAD or only serve the secure URL.
        const sourceUrl = Array.from(externalLink.sources)[0];
        const rawHref = Array.from(externalLink.rawHrefs)[0];
        const zone = Array.from(externalLink.zones)[0] ?? 'unknown';
        try {
            const response = await this.externalHead(externalLink.targetUrl, config);
            if(this.isBotProtectionResponse(response)) {
                return;
            }
        } catch (e) {
            if(axios.isAxiosError(e) && typeof e.response !== 'undefined') {
                if(this.isBotProtectionResponse(e.response)) {
                    return;
                }
                const status = e.response.status;
                if(status >= 300 && status < 400) {
                    this.addIssue({
                        severity: 'warning',
                        group: 'External Links',
                        code: 'external-redirect',
                        message: 'External link returned a redirect response.',
                        targetUrl: externalLink.targetUrl,
                        sourceUrl,
                        rawHref,
                        statusCode: status,
                        finalUrl: String(e.response.headers.location ?? ''),
                        zone
                    });
                } else if(status >= 400) {
                    const httpsUrl = await this.getReachableHttpsUpgradeUrl(externalLink.targetUrl, config);
                    if(httpsUrl !== null) {
                        this.addIssue({
                            severity: 'error',
                            group: 'External Links',
                            code: 'external-http-upgrade-available',
                            message: 'External HTTP link failed, but the HTTPS version responded successfully.',
                            targetUrl: externalLink.targetUrl,
                            sourceUrl,
                            rawHref,
                            statusCode: status,
                            finalUrl: httpsUrl,
                            zone
                        });
                        return;
                    }

                    if(await this.externalGetShowsReachableOrProtected(
                        externalLink.targetUrl,
                        this.getExternalFallbackConfig(config)
                    )) {
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
                        statusCode: status,
                        zone
                    });
                }
                return;
            }

            if(this.isTemporaryDnsFailure(e)) {
                this.addIssue({
                    severity: 'warning',
                    group: 'External Links',
                    code: 'external-dns-temporary-failure',
                    message: 'External link DNS lookup failed with EAI_AGAIN.',
                    targetUrl: externalLink.targetUrl,
                    sourceUrl,
                    rawHref,
                    statusCode: 0,
                    networkErrorCode: 'EAI_AGAIN',
                    networkErrorMessage: e instanceof Error ? e.message : String(e),
                    zone
                });
                return;
            }

            const httpsUrl = await this.getReachableHttpsUpgradeUrl(externalLink.targetUrl, config);
            if(httpsUrl !== null) {
                this.addIssue({
                    severity: 'error',
                    group: 'External Links',
                    code: 'external-http-upgrade-available',
                    message: 'External HTTP link failed, but the HTTPS version responded successfully.',
                    targetUrl: externalLink.targetUrl,
                    sourceUrl,
                    rawHref,
                    statusCode: 0,
                    finalUrl: httpsUrl,
                    zone
                });
                return;
            }

            if(await this.externalGetShowsBotProtection(
                externalLink.targetUrl,
                this.getExternalFallbackConfig(config)
            )) {
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
                statusCode: 0,
                zone
            });
        }
    }

    private async externalGetShowsReachableOrProtected(url: string, config: AxiosRequestConfig): Promise<boolean> {
        try {
            const response = await this.externalGet(url, config, false);
            return response.status >= 200 && response.status < 300
                || response.status >= 300 && response.status < 400
                || this.isBotProtectionResponse(response);
        } catch (e) {
            return axios.isAxiosError(e)
                && typeof e.response !== 'undefined'
                && (
                    this.isBotProtectionResponse(e.response)
                    || e.response.status >= 200 && e.response.status < 400
                );
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
        const httpsUrl = this.getHttpsUpgradeUrl(url);
        if(httpsUrl === null) {
            return null;
        }

        const fallbackConfig = this.getExternalFallbackConfig(config);
        try {
            const response = await this.externalHead(httpsUrl, fallbackConfig, false);
            if(response.status >= 200 && response.status < 300 || this.isBotProtectionResponse(response)) {
                return httpsUrl;
            }
        } catch (e) {
            if(axios.isAxiosError(e) && typeof e.response !== 'undefined') {
                if(this.isBotProtectionResponse(e.response)
                    || e.response.status >= 200 && e.response.status < 400) {
                    return httpsUrl;
                }
            }
        }

        return await this.externalGetShowsReachableOrProtected(httpsUrl, fallbackConfig)
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

    private async externalGetShowsBotProtection(url: string, config: AxiosRequestConfig): Promise<boolean> {
        try {
            const response = await this.externalGet(url, config, false);
            return this.isBotProtectionResponse(response);
        } catch (e) {
            return axios.isAxiosError(e)
                && typeof e.response !== 'undefined'
                && this.isBotProtectionResponse(e.response);
        }
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
            try {
                return await request();
            } catch (e) {
                lastError = e;
                if(!this.shouldRetryExternalRequest(e) || attempt === maxAttempts) {
                    throw e;
                }
            }
        }

        throw lastError;
    }

    private shouldRetryExternalRequest(error: unknown): boolean {
        return axios.isAxiosError(error) && typeof error.response === 'undefined';
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
            && this.allowedNonCanonicalLinks.indexOf(normalizedCanonical.replace(pattern, '')) === -1) {
            this.nonCanonicalTargets.add(pageData.location.url);
            this.addIssue({
                severity: 'warning',
                group: 'Canonical Issues',
                code: 'non-canonical-internal-link',
                message: 'Internal link target differs from its canonical URL.',
                targetUrl: pageData.location.url,
                sourceUrl: pageData.location.referer,
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

    private shouldSkipOutgoingLinkAudit(pageData: PageData, canonicalUrl: string|null): boolean {
        return canonicalUrl !== null
            && canonicalUrl !== pageData.location.url
            && this.processedPageUrls.has(canonicalUrl);
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
