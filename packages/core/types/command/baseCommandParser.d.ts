import type { ArgumentConfig, JobCommand } from "../definitions.js";
export interface CommandParserInterface {
    getConfigName(): string;
}
export declare abstract class BaseCommandParser implements CommandParserInterface {
    getConfigName(): string;
    arguments: {
        [k: string]: ArgumentConfig;
    };
    jobs: {
        [k: string]: JobCommand;
    };
    constructor(args: string[], switches: {
        [k: string]: ArgumentConfig;
    });
    getDescription(): string;
    helpRequested(): boolean;
    protected shouldAutoShowHelp(): boolean;
    _getConfigName(defaultName: string): string;
    getHelpMessage(): string;
    showHelpMessage(): void | Promise<void>;
    protected shouldHideSwitchInHelp(_argument: ArgumentConfig): boolean;
    private registerAdditionalSwitches;
    private registerSwitchAliases;
    private getSwitchNames;
    private isReservedSwitchName;
    private parseSwitchToken;
    private unwrapInlineValue;
    private applySwitchValue;
    private validateSwitchInput;
    private startJob;
    private isValidJobName;
    private isValidPackageName;
    private isJobSwitchToken;
    private isJobSwitch;
    private getUniqueSwitches;
    private formatSwitchUsage;
}
