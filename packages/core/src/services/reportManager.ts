"use strict";

import {existsSync, readFileSync} from "fs";
import {dirname, resolve} from "path";
import {fileURLToPath} from "url";
import axios from "axios";
import Handlebars from "handlebars";
import nodemailer from 'nodemailer';
import type SMTPConnection from "nodemailer/lib/smtp-connection/index.js";
import type {MailOptions} from "nodemailer/lib/smtp-transport/index.js";
import type {Transporter} from "nodemailer";
import {ConfigService} from "./configLoader.js";
import {OutputHelper} from "./outputHelper.js";
import type {BaseJob} from "../jobs/baseJob.js";
import type {
    CrawlerError,
    CrawlerStats,
    Location,
    MailTransportConfig,
    RecipientMap,
    ReportData,
    ReportDataValue
} from "../definitions.js";
import type {Profiler} from "./profiler.js";

type JobReportTemplateData = {
    jobHandle: string;
    reportTitle: string;
    reportMessage: string;
    reportMessageHtml: string;
    reportData: Array<{label: string, value: string, valueHtml: string}>;
    reportHtml: string;
}

type ErrorReportEntry = {
    index: number;
    message: string;
    messageHtml: string;
    errorName: string;
    errorMessage: string;
    errorMessageHtml: string;
    stack: string;
    stackHtml: string;
    fatal: boolean;
    locationDetails: Array<{label: string, value: string, valueHtml: string}>;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const resourceBase = [
    resolve(moduleDir, '../resources'),
    resolve(moduleDir, '../src/resources'),
    resolve(process.cwd(), 'src/resources')
].find(path => existsSync(path)) ?? resolve(moduleDir, '../resources');

export class ReportManager {

    private logoDataUri?: string;
    private readonly profiler: Profiler;
    private readonly console: OutputHelper;

    constructor(profiler: Profiler) {
        this.profiler = profiler;
        this.console = new OutputHelper();
    }

    async sendReport(stats: CrawlerStats, jobs: BaseJob[]): Promise<boolean> {
        if (!this.isSendingAllowed()) {
            return false;
        }

        const reportJobs = jobs.filter(job => job.shouldSendEmailReport());
        if(reportJobs.length === 0) {
            return false;
        }

        let mailer: Transporter;
        let mailOptions: MailOptions;
        try {
            mailer = this.createMailer();
            const jobReports = this.getJobReports(reportJobs);
            mailOptions = this.getMailOptions(stats, jobReports, reportJobs);
        } catch(e) {
            this.reportMailSetupError('regular report', e);
            return false;
        }

        this.profiler.mark('report-email', 'sending combined report email');
        const sent = await this.sendMail(mailer, mailOptions, 'regular report');
        if(sent) {
            this.profiler.mark('report-email', 'sent combined report email');
        }
        return sent;
    }

    async sendErrorReport(errors: CrawlerError[], stats: CrawlerStats, jobs: BaseJob[], fatalOnly = false): Promise<boolean> {
        if (!this.isSendingAllowed()) {
            return false;
        }

        const reportErrors = this.getReportableErrors(errors, fatalOnly);
        if(reportErrors.length === 0) {
            return false;
        }

        let mailer: Transporter;
        let mailOptions: MailOptions;
        const label = fatalOnly ? 'fatal error report' : 'crawler error report';
        try {
            mailer = this.createMailer();
            mailOptions = this.getErrorMailOptions(stats, reportErrors, jobs, fatalOnly);
        } catch(e) {
            this.reportMailSetupError(label, e);
            return false;
        }

        this.profiler.mark('error-report-email', 'sending error report email');
        const sent = await this.sendMail(mailer, mailOptions, label);
        if(sent) {
            this.profiler.mark('error-report-email', 'sent error report email');
        }

        return sent;
    }

    isSendingAllowed(): boolean {
        return !ConfigService.getConfigBoolean('mail.disabled');
    }

    createMailer(): Transporter {
        let transportConfig: MailTransportConfig = {
            host: "",
            port: 467,
            secure: true,
            auth: {
                username: "",
                password: ""
            },
            tls: {
                rejectUnauthorized: true
            }
        };
        transportConfig = ConfigService.getConfigValue('mail.transport', null, transportConfig);

        if (typeof transportConfig !== 'object' ||
            transportConfig === null ||
            Array.isArray(transportConfig)) {
            throw new Error('No mail transport configuration.');
        }

        const tspOptions: SMTPConnection.Options = {
            host: transportConfig.host,
            port: Number(transportConfig.port),
            secure: transportConfig.secure,
            tls: {
                rejectUnauthorized: transportConfig.tls?.rejectUnauthorized ?? true
            }
        };

        const authUser = transportConfig.auth?.username ?? '';
        const authPw = transportConfig.auth?.password ?? '';
        if (authUser !== '' && authPw !== '') {
            tspOptions.authMethod = 'login';
            tspOptions.auth = {
                user: authUser,
                pass: authPw
            };
        }

        return nodemailer.createTransport(tspOptions);
    }

    getJobReports(jobs: BaseJob[]): string[] {
        return jobs.map(job => {
            this.profiler.markJob(job.handle, 'report-email', 'rendering report email content');
            const templateData: JobReportTemplateData = {
                jobHandle: job.handle,
                reportTitle: job.getReportTitle(),
                reportMessage: job.getReportMessage(),
                reportMessageHtml: this.linkifyHtml(job.getReportMessage()),
                reportData: this.formatReportData(job.getReportData()),
                reportHtml: job.getReportHtml()
            };

            const report = this.renderJobReport(job.getReportTemplate(), templateData);
            this.profiler.markJob(job.handle, 'report-email', 'rendered report email content');
            return report;
        });
    }

    renderJobReport(templateFile: string, templateData: JobReportTemplateData): string
    {
        const templatePath = templateFile !== '' ? templateFile : this.getResourcePath('email-job-report.html.hbs');
        const template = Handlebars.compile(readFileSync(templatePath, 'utf8'));
        return template(templateData);
    }

    getMailOptions(stats: CrawlerStats, jobReports: string[], jobs: BaseJob[]): MailOptions {
        const subject = this.renderSubject(jobs);
        const html = this.renderMainTemplate(stats, jobReports, jobs, subject);

        return {
            from: this.formatRecipientMap(ConfigService.getConfigValue<RecipientMap>('mail.from', null, {})),
            to: this.formatRecipientMaps(ConfigService.getConfigValue<RecipientMap[]>('mail.reportRecipients', null, [])),
            replyTo: this.formatRecipientMaps(ConfigService.getConfigValue<RecipientMap[]>('mail.replyTo', null, [])),
            subject,
            html,
            text: this.htmlToText(html)
        };
    }

    getErrorMailOptions(
        stats: CrawlerStats,
        errors: CrawlerError[],
        jobs: BaseJob[],
        fatalOnly: boolean
    ): MailOptions {
        const subject = this.renderErrorSubject(errors, jobs, fatalOnly);
        const html = this.renderErrorTemplate(stats, errors, jobs, subject, fatalOnly);
        const errorRecipients = this.formatRecipientMaps(
            ConfigService.getConfigValue<RecipientMap[]>('mail.errorRecipients', null, [])
        );
        const developerRecipients = this.formatRecipientMaps(
            ConfigService.getConfigValue<RecipientMap[]>('mail.developerRecipients', null, [])
        );
        const finalFallbackRecipients = this.formatRecipientMaps(
            ConfigService.getConfigValue<RecipientMap[]>('mail.reportRecipients', null, [])
        );

        return {
            from: this.formatRecipientMap(ConfigService.getConfigValue<RecipientMap>('mail.from', null, {})),
            to: errorRecipients !== ''
                ? errorRecipients
                : (developerRecipients !== '' ? developerRecipients : finalFallbackRecipients),
            replyTo: this.formatRecipientMaps(ConfigService.getConfigValue<RecipientMap[]>('mail.replyTo', null, [])),
            subject,
            html,
            text: this.htmlToText(html)
        };
    }

    private renderMainTemplate(stats: CrawlerStats, jobReports: string[], jobs: BaseJob[], subject: string): string {
        const template = Handlebars.compile(readFileSync(this.getResourcePath('email-report.html.hbs'), 'utf8'));
        return template({
            logoDataUri: this.getLogoDataUri(),
            subject,
            siteName: ConfigService.getConfigString('siteName'),
            domain: ConfigService.getConfigString('domain'),
            baseUrl: ConfigService.getConfigString('baseUrl'),
            generatedAt: new Date().toISOString(),
            durationSeconds: this.profiler.getDurationSeconds().toFixed(2),
            stats,
            jobCount: jobs.length,
            jobNames: jobs.map(job => job.getName()).join(', '),
            jobReportsHtml: jobReports.join('\n')
        });
    }

    private async sendMail(mailer: Transporter, mailOptions: MailOptions, label: string): Promise<boolean> {
        const recipients = this.mailOptionToString(mailOptions.to);
        if(recipients === '') {
            this.console.log(`Email ${label} was not sent: no recipients configured.`, 'yellow.bold', true);
            return false;
        }

        this.console.log(`Sending ${label} email to ${recipients}...`, 'cyan.bold', true);
        try {
            await mailer.sendMail(mailOptions);
            this.console.log(`Sent ${label} email successfully.`, 'green.bold', true);
            return true;
        } catch(e) {
            this.console.log(`Failed to send ${label} email.`, 'red.bold', true);
            this.console.log(e instanceof Error ? e.message : String(e), 'red', true);
            return false;
        }
    }

    private reportMailSetupError(label: string, e: unknown): void {
        this.console.log(`Failed to prepare ${label} email.`, 'red.bold', true);
        this.console.log(e instanceof Error ? e.message : String(e), 'red', true);
    }

    private mailOptionToString(value: MailOptions['to']): string {
        if(typeof value === 'undefined') {
            return '';
        }
        if(typeof value === 'string') {
            return value;
        }
        if(Array.isArray(value)) {
            return value.map(item => this.mailOptionToString(item)).filter(item => item !== '').join(', ');
        }
        if(typeof value === 'object' && value !== null && 'address' in value) {
            return String(value.address);
        }

        return String(value);
    }

    private renderSubject(jobs: BaseJob[]): string {
        const template = Handlebars.compile(ConfigService.getConfigString('mail.defaultSubject'));
        return template({
            domain: ConfigService.getConfigString('domain'),
            siteName: ConfigService.getConfigString('siteName'),
            jobs: jobs.map(job => job.getName()).join(', ')
        });
    }

    private renderErrorSubject(errors: CrawlerError[], jobs: BaseJob[], fatalOnly: boolean): string {
        const severity = fatalOnly ? 'Fatal Error' : 'Crawler Errors';
        const jobsLabel = jobs.length > 0 ? ` [${jobs.map(job => job.getName()).join(', ')}]` : '';
        return `Arachnodex ${ConfigService.getConfigString('domain')} ${severity} Report${jobsLabel} (${errors.length})`;
    }

    private renderErrorTemplate(
        stats: CrawlerStats,
        errors: CrawlerError[],
        jobs: BaseJob[],
        subject: string,
        fatalOnly: boolean
    ): string {
        const template = Handlebars.compile(readFileSync(this.getResourcePath('email-error-report.html.hbs'), 'utf8'));
        return template({
            logoDataUri: this.getLogoDataUri(),
            subject,
            siteName: ConfigService.getConfigString('siteName'),
            domain: ConfigService.getConfigString('domain'),
            baseUrl: ConfigService.getConfigString('baseUrl'),
            generatedAt: new Date().toISOString(),
            durationSeconds: this.profiler.getDurationSeconds().toFixed(2),
            stats,
            jobCount: jobs.length,
            jobNames: jobs.map(job => job.getName()).join(', '),
            fatalOnly,
            errorCount: errors.length,
            errors: errors.map((error, index) => this.formatErrorReportEntry(error, index))
        });
    }

    private getReportableErrors(errors: CrawlerError[], fatalOnly: boolean): CrawlerError[] {
        return errors.filter(error => {
            if(error.suppressEmail === true) {
                return false;
            }
            if(fatalOnly) {
                return error.fatal === true;
            }
            if(error.fatal === true) {
                return true;
            }
            return !this.isSiteFindingError(error);
        });
    }

    private isSiteFindingError(error: CrawlerError): boolean {
        if(axios.isAxiosError(error.error)) {
            return true;
        }

        return [
            'URL Data Request Failed',
            'URL data request failed after successful HEAD request',
            'The server did not respond to the request'
        ].some(message => error.message.includes(message));
    }

    private formatErrorReportEntry(error: CrawlerError, index: number): ErrorReportEntry {
        const errorMessage = error.error?.message ?? '';
        const stack = error.error?.stack ?? '';
        return {
            index: index + 1,
            message: error.message,
            messageHtml: this.linkifyHtml(error.message),
            errorName: error.error?.name ?? 'Error',
            errorMessage,
            errorMessageHtml: this.linkifyHtml(errorMessage),
            stack,
            stackHtml: this.linkifyHtml(stack),
            fatal: error.fatal === true,
            locationDetails: this.formatLocationDetails(error.location)
        };
    }

    private formatLocationDetails(location?: Location): Array<{label: string, value: string, valueHtml: string}> {
        if(typeof location === 'undefined') {
            return [];
        }

        return Object.entries(location)
            .filter(([, value]) => typeof value !== 'undefined')
            .map(([label, value]) => {
                const formattedValue = Array.isArray(value) ? value.join(' => ') : String(value);
                return {
                    label,
                    value: formattedValue,
                    valueHtml: this.linkifyHtml(formattedValue)
                };
            });
    }

    private getLogoDataUri(): string {
        if(typeof this.logoDataUri === 'undefined') {
            const data = readFileSync(this.getResourcePath('arachnodex-logo-black.png')).toString('base64');
            this.logoDataUri = `data:image/png;base64,${data}`;
        }
        return this.logoDataUri;
    }

    private getResourcePath(fileName: string): string {
        return resolve(resourceBase, fileName);
    }

    private formatRecipientMaps(recipients: RecipientMap[]): string {
        return recipients
            .map(recipient => this.formatRecipientMap(recipient))
            .filter(recipient => recipient !== '')
            .join(', ');
    }

    private formatRecipientMap(recipient: RecipientMap): string {
        const entries = Object.entries(recipient);
        if(entries.length === 0) {
            return '';
        }

        return entries.map(([name, email]) => name === '' ? email : `"${name}" <${email}>`).join(', ');
    }

    private formatReportData(reportData: ReportData): Array<{label: string, value: string, valueHtml: string}> {
        return Object.entries(reportData).map(([label, value]) => {
            const formattedValue = this.formatReportDataValue(value);
            return {
                label,
                value: formattedValue,
                valueHtml: this.linkifyHtml(formattedValue)
            };
        });
    }

    private formatReportDataValue(value: ReportDataValue): string {
        if(value === null) {
            return '';
        }
        return String(value);
    }

    private htmlToText(html: string): string {
        return html
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private linkifyHtml(value: string): string {
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

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

}
