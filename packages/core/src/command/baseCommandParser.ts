"use strict";

import type { ArgumentConfig, JobCommand } from "../definitions.js";
import {CommandExit} from "./commandExit.js";

export interface CommandParserInterface {
    getConfigName(): string;
}

export abstract class BaseCommandParser implements CommandParserInterface {

    getConfigName(): string
    {
        return 'default';
    }

    arguments: {[k: string]: ArgumentConfig} = {
        '-c': {
            switch: '-c',
            aliases: ['--config'],
            value: true,
            type: 'string',
            label: 'config-name',
            description: 'Specify the name of the config which will be used to load config/<name>.json.',
            note: `Use this before the first job for the crawler config, or after a job name for that job's config.`
        },
        '-j': {
            switch: '-j',
            aliases: ['--job'],
            value: true,
            type: 'string',
            label: 'job-name|package',
            description: `Specify a job to run. Short names load official-style packages, e.g. 'example' loads` +
                ` @arachnodex/job-example. Scoped package names load exactly, e.g. @scope/job-example.` +
                ` Use npm:package-name for exact unscoped third-party packages.`,
            note: `When multiple jobs are supplied, each job receives the switches after its name until the next job switch.`
        },
        '-h': {
            switch: '-h',
            aliases: ['--help'],
            value: false,
            description: 'Display this help message.',
            note: `Use after a job name to show help for that job.`
        },
    }

    // Job command holder (only used in "MainMode" not for job based instances)
    jobs: {[k: string]: JobCommand} = {};


    constructor(args: string[], switches: {[k: string]: ArgumentConfig}) {

        this.registerSwitchAliases(this.arguments);
        this.registerAdditionalSwitches(switches);

        // todo load job arguments straight away if switches are presented after a job name (to get switch arguments from job)
        let lastSwitch: ArgumentConfig|null = null;
        let currentJob = "";
        args.forEach(arg => {
            const parsedSwitch = this.parseSwitchToken(arg);

                if(currentJob !== '' && !this.isJobSwitch(lastSwitch) && !this.isJobSwitchToken(parsedSwitch)) {
                    // Main parsing only needs to split job argument groups. Job-specific
                    // switch validation happens when the job command parser is initialized.
                    this.jobs[currentJob].arguments.push(arg);
                    return;
                }

                if (parsedSwitch !== null) {

                    const switchConfig = this.arguments[parsedSwitch.name];
                    if (typeof switchConfig === 'undefined') {
                        throw new Error(`Invalid switch: '${parsedSwitch.name}'.`);
                    }

                    if(lastSwitch !== null && lastSwitch.value) {
                        throw new Error(`Switch '${lastSwitch.switch}' must be followed by a <${lastSwitch.type}> value.`)
                    }

                    if(typeof parsedSwitch.value === 'string') {
                        this.applySwitchValue(switchConfig, parsedSwitch.value, currentJob);
                        if(this.isJobSwitch(switchConfig)) {
                            currentJob = parsedSwitch.value;
                        }
                        lastSwitch = null;
                        return;
                    }

                    // If switch is -j do not activate it
                    // Otherwise, activate switch
                    if(!this.isJobSwitch(switchConfig)) {
                        switchConfig.active = true;
                    }

                    // Set last switch to current switch
                    lastSwitch = switchConfig;

                } else {


                    // HANDLE NON-SWITCH ARGUMENT

                    if(lastSwitch !== null && lastSwitch.value) {
                        this.applySwitchValue(lastSwitch, arg, currentJob);
                        if(this.isJobSwitch(lastSwitch)) {
                            currentJob = arg;
                        }

                        // Reset lastSwitch since this iteration did not yield a switch.
                        lastSwitch = null;

                    } else {

                        // Switch values must directly follow a switch argument...
                        throw new Error(`Switch parameters must follow a switch that expects a parameter to follow it.`);

                    }
                }
            });

        if(this.arguments['-h'].active === true && this.shouldAutoShowHelp()) {
            void this.showHelpMessage();
            throw new CommandExit(0);
        }
    }

    getDescription(): string {
        return 'Arachnodex command.';
    }

    helpRequested(): boolean {
        return this.arguments['-h'].active === true;
    }

    protected shouldAutoShowHelp(): boolean {
        return true;
    }

    // Return config file name if specified on the commandline via the -c switch,
    // otherwise return the default string provided.
    _getConfigName(defaultName: string):string {
        return typeof this.arguments['-c'].input === 'string' ? String(this.arguments['-c'].input) : defaultName;
    }

    getHelpMessage(): string {
        const rows = this.getUniqueSwitches().filter(argument => !this.shouldHideSwitchInHelp(argument)).map(argument => {
            const command = this.formatSwitchUsage(argument);
            const note = typeof argument.note === 'string' && argument.note.length > 0
                ? ` ${argument.note}`
                : '';
            return {
                command,
                description: `${argument.description}${note}`
            };
        });

        const commandWidth = rows.reduce((width, row) => Math.max(width, row.command.length), 0);
        const lines: string[] = [
            this.getDescription(),
            '',
            'Commands:'
        ];
        rows.forEach(row => {
            lines.push(`  ${row.command.padEnd(commandWidth)}  ${row.description}`);
            lines.push('');
        });

        return lines.join('\n');
    }

    showHelpMessage(): void|Promise<void> {
        console.log(this.getHelpMessage());
    }

    protected shouldHideSwitchInHelp(_argument: ArgumentConfig): boolean {
        return false;
    }

    private registerAdditionalSwitches(switches: {[k: string]: ArgumentConfig}): void {
        Object.keys(switches).forEach(switchArg => {
            const switchConfig = switches[switchArg];
            const names = this.getSwitchNames(switchConfig);

            names.forEach(name => {
                if(this.isReservedSwitchName(name)) {
                    throw new Error(`The '${name}' switch is reserved by the crawler and cannot be defined by a job.`);
                }
                if(typeof this.arguments[name] !== 'undefined') {
                    throw new Error(`The '${name}' switch has already been defined.`);
                }
            });

            names.forEach(name => {
                this.arguments[name] = switchConfig;
            });
        });
    }

    private registerSwitchAliases(switches: {[k: string]: ArgumentConfig}): void {
        Object.keys(switches).forEach(switchArg => {
            const switchConfig = switches[switchArg];
            this.getSwitchNames(switchConfig).forEach(name => {
                switches[name] = switchConfig;
            });
        });
    }

    private getSwitchNames(argument: ArgumentConfig): string[] {
        return [argument.switch, ...(argument.aliases ?? [])];
    }

    private isReservedSwitchName(name: string): boolean {
        return typeof this.arguments[name] !== 'undefined';
    }

    private parseSwitchToken(arg: string): {name: string, value?: string}|null {
        if(arg.substring(0, 1) !== '-') {
            return null;
        }

        const equalsPosition = arg.indexOf('=');
        if(equalsPosition === -1) {
            return {name: arg};
        }

        return {
            name: arg.substring(0, equalsPosition),
            value: this.unwrapInlineValue(arg.substring(equalsPosition + 1))
        };
    }

    private unwrapInlineValue(value: string): string {
        if(value.length >= 2
            && (
                value.startsWith('"') && value.endsWith('"')
                || value.startsWith("'") && value.endsWith("'")
            )) {
            return value.substring(1, value.length - 1);
        }

        return value;
    }

    private applySwitchValue(argument: ArgumentConfig, value: string, currentJob: string): void {
        if(!argument.value) {
            throw new Error(`Switch '${argument.switch}' does not accept a value.`);
        }

        this.validateSwitchInput(argument, value);

        if(this.isJobSwitch(argument)) {
            this.startJob(value);
            return;
        }

        if(currentJob !== '') {
            throw new Error(`Switch '${argument.switch}' belongs to the crawler and must be set before the first job.`);
        }

        argument.active = true;
        argument.input = argument.type === 'number' ? Number(value) : value;
    }

    private validateSwitchInput(argument: ArgumentConfig, value: string): void {
        if(argument.type === 'number') {
            const numericValue = Number(value);
            if(!Number.isFinite(numericValue)) {
                throw new Error(`The value set for switch '${argument.switch}' requires a <number> type.`);
            }
            if(argument.switch === '-t' && (!Number.isInteger(numericValue) || numericValue < 1)) {
                throw new Error(`The value set for switch '${argument.switch}' requires a positive integer.`);
            }
            return;
        }

        if(argument.type === 'string' && value === '') {
            throw new Error(`The value set for switch '${argument.switch}' requires a non-empty <string> value.`);
        }
    }

    private startJob(jobName: string): void {
        if(!this.isValidJobName(jobName)) {
            throw new Error(
                `Invalid job '${jobName}'. Use a short name like 'sitemap', a scoped package name like ` +
                `'@scope/job-example', or 'npm:package-name' for an exact unscoped package.`
            );
        }

        this.jobs[jobName] = {
            name: jobName,
            arguments: [],
        };
    }

    private isValidJobName(jobName: string): boolean {
        if(jobName.startsWith('npm:')) {
            return this.isValidPackageName(jobName.substring(4));
        }

        if(jobName.startsWith('@')) {
            return this.isValidPackageName(jobName);
        }

        return /^[a-z0-9][a-z0-9-]*$/.test(jobName);
    }

    private isValidPackageName(packageName: string): boolean {
        const packageSegment = '[a-z0-9][a-z0-9._~-]*';
        const unscopedPackage = new RegExp(`^${packageSegment}$`);
        const scopedPackage = new RegExp(`^@${packageSegment}/${packageSegment}$`);
        return unscopedPackage.test(packageName) || scopedPackage.test(packageName);
    }

    private isJobSwitchToken(parsedSwitch: {name: string, value?: string}|null): boolean {
        return parsedSwitch !== null && this.isJobSwitch(this.arguments[parsedSwitch.name]);
    }

    private isJobSwitch(argument?: ArgumentConfig|null): boolean {
        return typeof argument !== 'undefined' && argument !== null && argument === this.arguments['-j'];
    }

    private getUniqueSwitches(): ArgumentConfig[] {
        const switches: ArgumentConfig[] = [];
        const seen = new Set<ArgumentConfig>();
        Object.keys(this.arguments).forEach(name => {
            const argument = this.arguments[name];
            if(seen.has(argument)) {
                return;
            }

            switches.push(argument);
            seen.add(argument);
        });

        return switches;
    }

    private formatSwitchUsage(argument: ArgumentConfig): string {
        return this.getSwitchNames(argument).map(name => {
            if(!argument.value) {
                return name;
            }

            const label = argument.label ?? argument.type ?? 'value';
            if(name.startsWith('--')) {
                return `${name}=<${label}>`;
            }

            return `${name} <${label}>`;
        }).join(', ');
    }


}
