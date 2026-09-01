"use strict";

import {CommandExit, JobCommandParser, type ArgumentConfig} from "@arachnodex/core";

export default class CspReportCmd extends JobCommandParser {

    version = "1.0.1";

    constructor(args: string[], job: string) {
        const switches: {[k: string]: ArgumentConfig} = {
            "-V": {
                switch: "-V",
                aliases: ["--version"],
                value: false,
                description: "Output the CSP Report job version and terminate.",
                note: "No crawl is performed when this switch is used."
            },
            "-o": {
                switch: "-o",
                aliases: ["--output"],
                value: true,
                type: "string",
                label: "apache|nginx|lighttpd|raw",
                configPath: "outputFormat",
                description: "Choose the generated CSP header directive format.",
                note: "Defaults to apache."
            },
            "--no-nested": {
                switch: "--no-nested",
                value: false,
                description: "Disable nested same-site CSS and JavaScript scanning.",
                note: "Nested scanning is enabled by default."
            },
            "--unsafe-inline": {
                switch: "--unsafe-inline",
                value: false,
                configPath: "unsafeInline",
                description: "Allow unsafe-inline for observed inline script/style usage.",
                note: "Inline usage is still reported as a hardening item."
            },
            "-p": {
                switch: "-p",
                aliases: ["--prompt"],
                value: false,
                description: "After the CSP report, output copy/paste agent prompts for each warning group.",
                note: "Use this when you want to hand focused CSP cleanup work to an agent working in the target project."
            }
        };

        super(args, switches, job);

        if(this.arguments["-V"].active === true) {
            console.log(`CSP Report Job Version ${this.version}`);
            throw new CommandExit(0);
        }
    }

    getDescription(): string {
        return "The CSP Report job reports observed content dependencies and generates Content Security Policy header directives.";
    }

}
