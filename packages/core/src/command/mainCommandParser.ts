"use strict";
import type {ArgumentConfig, JobCommand} from "../definitions.ts";
import {BaseCommandParser} from "./baseCommandParser.js";
import type {JobCommandParser} from "./jobCommandParser.js";
import {JobCommandParser as DefaultJobCommandParser} from "./jobCommandParser.js";
import {getJobModuleName} from "../jobs/jobModules.js";

type JobCommandParserFactory = (args: string[], job: string) => JobCommandParser;
type JobCommandParserCtor = new (args: string[], job: string) => JobCommandParser;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}

function hasNamedJcpCtor(v: unknown): v is { CommandParser: JobCommandParserCtor } {
    return isRecord(v) && typeof v.CommandParser === 'function';
}

export class MainCommandParser extends BaseCommandParser {

    constructor(args: string[]) {

        // Preferably this would be a return from a method
        // but the parent constructor has no access IN the
        // constructor so I guess this is best alternative?
        const switches :{[k: string]: ArgumentConfig} = {
            '-m': {
                switch: '-m',
                aliases: ['--mute-status'],
                value: false,
                configPath: 'muteResponseStatus',
                description: 'Mute crawler response status console output.',
                note: 'Job output and errors are still displayed.'
            },
            '-mm': {
                switch: '-mm',
                aliases: ['--mute-all'],
                value: false,
                configPath: 'muteAll',
                description: 'Mute ALL non error console output.',
                note: 'This includes non-error output from jobs.'
            },
            '-nc': {
                switch: '-nc',
                aliases: ['--no-color'],
                value: false,
                configPath: 'disableColorOutput',
                description: 'Disable all color output in console messages.',
                note: 'Useful for plain logs or terminals that do not support ANSI colors.'
            },
            '-nm': {
                switch: '-nm',
                aliases: ['--no-mail'],
                value: false,
                configPath: 'mail.disabled',
                description: 'No Email - No reports will be sent, including error reports.',
                note: 'Overrides mail reporting for this run.'
            },
            '-t': {
                switch: '-t',
                aliases: ['--threads'],
                value: true,
                type: 'number',
                label: 'count',
                configPath: 'numThreads',
                description: 'Specify the maximum number of worker threads to use.',
                note: 'Can be set as -t <count> or --threads=<count>.'
            },
            '-v': {
                switch: '-v',
                aliases: ['--verbose'],
                value: false,
                type: 'number',
                description: 'Verbose Level 1 - Show crawler statistics at the end of the output.',
                note: 'Use -vv or -vvv for more detail.'
            },
            '-p': {
                switch: '-p',
                aliases: ['--profile'],
                value: false,
                description: 'Enable profiler milestone output.',
                note: 'Profiler entries include main crawler and job-scoped timing marks.'
            },
            '--test-report-email': {
                switch: '--test-report-email',
                value: false,
                description: 'Render and send a test regular report email without crawling.',
                note: 'Uses selected jobs, deterministic sample crawl stats, and the configured mail transport.'
            },
            '-vv': {
                switch: '-vv',
                value: false,
                type: 'number',
                description: 'Verbose Level 2 - Show full URL lists for each statistic category.',
                note: 'Includes level 1 output.'
            },
            '-vvv': {
                switch: '-vvv',
                value: false,
                type: 'number',
                description: 'Verbose Level 3 - Same as level 2 but the URL lists are sorted alphabetically.',
                note: 'Useful when comparing crawl output between runs.'
            }
        };

        super(args, switches);
    }

    getDescription(): string {
        return 'Arachnodex spiders a configured site and runs one or more jobs against pages discovered during the crawl.';
    }

    protected shouldAutoShowHelp(): boolean {
        return false;
    }

    async showHelpMessage() {
        console.log(this.getHelpMessage());

        // Load selected job parsers on demand so help output includes job-specific switches.
        for (const jobName of Object.keys(this.jobs)) {
            console.log('-------------------------------------------------');
            console.log(`Job: ${jobName}`);
            console.log('-------------------------------------------------');
            console.log(await this.getJobHelpMessage(jobName));
        }

        process.exit(0);
    }

    // Get config via command line -c switch or return 'default'
    getConfigName(): string {
        return super._getConfigName('default');
    }


    getVerbosityLevel():number {
        if(this.arguments['-vvv'].active === true) { return 3; }
        if(this.arguments['-vv'].active === true) { return 2; }
        if(this.arguments['-v'].active === true) { return 1; }
        return 0;
    }

    profilerEnabled(): boolean {
        return this.arguments['-p'].active === true;
    }

    testReportEmailEnabled(): boolean {
        return this.arguments['--test-report-email'].active === true;
    }

    getJobs():{[k: string]: JobCommand} {
        return this.jobs;
    }

    private async getJobHelpMessage(jobName: string): Promise<string> {
        const command = (await this.getJobCommandParserFactory(jobName))([], jobName);
        return command.getHelpMessage();
    }

    private async getJobCommandParserFactory(jobName: string): Promise<JobCommandParserFactory> {
        // Help uses the same dynamic package resolution as the real job loader so third-party
        // jobs can document their own switches without core knowing about them in advance.
        const moduleName = getJobModuleName(jobName);
        const jobModuleUnknown: unknown = await import(moduleName);
        if (hasNamedJcpCtor(jobModuleUnknown)) {
            return (args: string[], job: string) => new jobModuleUnknown.CommandParser(args, job);
        }

        return (args: string[], job: string) => new DefaultJobCommandParser(args, {}, job);
    }

}
