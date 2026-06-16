"use strict";

import {CommandExit, JobCommandParser, type ArgumentConfig} from "@arachnodex/core";

export default class NfaReportCmd extends JobCommandParser {

    version = "1.0.4";

    constructor(args: string[], job: string) {
        const switches: {[k: string]: ArgumentConfig} = {
            "-V": {
                switch: "-V",
                aliases: ["--version"],
                value: false,
                description: "Output the NFA Report job version and terminate.",
                note: "No crawl is performed when this switch is used."
            },
            "-v": {
                switch: "-v",
                aliases: ["--verbose"],
                value: false,
                configPath: "verbose",
                description: "Print non-fingerprinted asset findings as they are discovered.",
                note: "Core quiet mode still suppresses this output."
            },
            "-n": {
                switch: "-n",
                aliases: ["--nested"],
                value: false,
                configPath: "nested",
                description: "Scan same-site CSS and JavaScript bodies for nested asset references.",
                note: "Nested JavaScript scanning is conservative and skips ordinary module specifiers."
            },
            "-p": {
                switch: "-p",
                aliases: ["--prompt"],
                value: false,
                description: "Output NFA findings as copy/paste prompts grouped by reference type.",
                note: "Use this when you want to hand a focused cache-busting fix prompt to an agent working in the target project."
            }
        };

        super(args, switches, job);

        if(this.arguments["-V"].active === true) {
            console.log(`NFA Report Job Version ${this.version}`);
            throw new CommandExit(0);
        }
    }

    getDescription(): string {
        return "The NFA Report job reports asset, media, and document references that are missing filename fingerprints or approved query-string cache-bust values.";
    }

}
