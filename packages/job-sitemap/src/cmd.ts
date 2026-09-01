"use strict";

import {CommandExit, JobCommandParser, type ArgumentConfig} from "@arachnodex/core";

export default class SitemapCmd extends JobCommandParser {


    constructor(args: string[], job: string)  {

        const switches:{[k: string]: ArgumentConfig} = {
            '-V': {
                switch: '-V',
                aliases: ['--version'],
                value: false,
                description: 'Output the Sitemap job version and terminate.',
                note: 'No crawl is performed when this switch is used.'
            },
        };

        super(args, switches, job);

        if(this.arguments['-V'].active === true) {
            console.log('Sitemap Generator Job Version 1.0.3');
            throw new CommandExit(0);
        }
    }

    getDescription(): string {
        return 'The Sitemap job creates a sitemap from crawlable internal URLs discovered while spidering the configured site.';
    }

}
