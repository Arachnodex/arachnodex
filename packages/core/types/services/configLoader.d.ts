import type { BaseCommandParser } from "../command/baseCommandParser.js";
import type { AppConfig, JSONObject, JSONPrimitive, JSONValue } from '../definitions.ts';
export declare class ConfigLoader {
    appConfig?: AppConfig;
    private appConfigName?;
    private readonly jobConfigs;
    private getDefaultAppConfig;
    loadAppConfig(configName?: string, command?: BaseCommandParser): AppConfig;
    private ensureAppConfig;
    loadJobConfigFile<T extends JSONObject>(defaults: T, configFile: string): T | null;
    getJobConfig<T extends JSONObject>(defaults: T, command: BaseCommandParser, configRequired?: boolean, validationCallback?: (config: T) => void): T;
    setConfigValue<T extends JSONObject>(configData: T, configPath: string, value: JSONPrimitive): T;
    private applyCommandConfigOverrides;
    getConfigString(configPath: string, configName?: string | null, defaultValue?: string): string;
    getConfigBoolean(configPath: string, configName?: string | null, defaultValue?: boolean): boolean;
    getConfigNumber(configPath: string, configName?: string | null, defaultValue?: number): number;
    getConfigRegExArray(configPath: string, configName?: string | null): RegExp[];
    getConfigValue<T extends JSONValue>(configPath: string, configName?: string | null, returnAs?: T): T;
}
export declare const ConfigService: ConfigLoader;
