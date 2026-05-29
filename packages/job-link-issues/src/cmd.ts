"use strict";

import {CommandExit, JobCommandParser, type ArgumentConfig} from "@arachnodex/core";

export default class LinkIssuesCmd extends JobCommandParser {

    version: string = '1.0';

    constructor(args: string[], job: string)  {

        const switches:{[k: string]: ArgumentConfig} = {
            '-V': {
                switch: '-V',
                aliases: ['--version'],
                value: false,
                description: 'Output the Link Issues job version and terminate.',
                note: 'No crawl is performed when this switch is used.'
            },
            '-n': {
                switch: '-n',
                aliases: ['--include-notices'],
                value: false,
                description: 'Include notice level link issues in the report.',
                note: 'By default only errors and warnings are rendered.'
            },
            '-e': {
                switch: '-e',
                aliases: ['--include-external'],
                value: false,
                description: 'Check external links using HEAD requests.',
                note: 'External checks are deduped by URL and use the external-link timeout/retry policy.'
            },
            '-p': {
                switch: '-p',
                aliases: ['--prompt'],
                value: false,
                description: 'Output link issue findings as copy/paste prompts grouped by report section.',
                note: 'Use this when you want to hand a focused fix prompt to an agent working in the target project.'
            },
        };

        super(args, switches, job);

        if(this.arguments['-V'].active === true) {
            console.log('Link Issues Job Version ' + this.version);
            throw new CommandExit(0);
        }
    }

    getDescription(): string {
        return 'The Link Issues job reports broken, malformed, non-canonical, insecure, placeholder, redirect, fragment, and optional external-link issues found during the crawl.';
    }

}
