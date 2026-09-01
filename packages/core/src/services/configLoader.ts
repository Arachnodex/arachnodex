"use strict";

// Load Dependencies
import fse from 'fs-extra'
import type {BaseCommandParser} from "../command/baseCommandParser.js";
import type {AppConfig, JSONObject, JSONArray, JSONPrimitive, JSONValue, DeepPartial} from '../definitions.ts';

type AppConfigInput = DeepPartial<AppConfig> & Pick<AppConfig, 'siteName' | 'domain' | 'baseUrl'>;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null;
}
function isJSONObject(v: unknown): v is JSONObject {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isJSONArray(v: unknown): v is JSONArray {
    return Array.isArray(v);
}

function isRecipient(v: unknown): boolean {
    if(typeof v === 'string') {
        return true;
    }
    return isRecord(v) && Object.values(v).every(value => typeof value === 'string');
}

function assertRecipient(v: unknown, path: string): void {
    if(!isRecipient(v)) {
        throw new Error(`${path} must be string or string-valued object`);
    }
}

function assertRecipientArray(v: unknown, path: string): void {
    if(!Array.isArray(v) || !v.every(isRecipient)) {
        throw new Error(`${path} must be an array of strings or string-valued objects`);
    }
}

function assertAppConfig(v: unknown): asserts v is AppConfigInput {
    if (!isRecord(v)) throw new Error('Config must be an object');
    if (typeof v.siteName !== 'string') throw new Error('siteName must be string');
    if (typeof v.domain !== 'string') throw new Error('domain must be string');
    if (typeof v.baseUrl !== 'string') throw new Error('baseUrl must be string');
    if (typeof v.pathPrefix !== 'undefined' && typeof v.pathPrefix !== 'string') throw new Error('pathPrefix must be string');
    if (typeof v.entryFile !== 'undefined' && typeof v.entryFile !== 'string') throw new Error('entryFile must be string');
    if (typeof v.dontResetUrls !== 'undefined' && typeof v.dontResetUrls !== 'boolean') throw new Error('dontResetUrls must be boolean');
    if (typeof v.numThreads !== 'undefined' && typeof v.numThreads !== 'number') throw new Error('numThreads must be number');
    if (typeof v.requestDelayMs !== 'undefined' && typeof v.requestDelayMs !== 'number') throw new Error('requestDelayMs must be number');
    if (typeof v.requestTimeoutMs !== 'undefined' && typeof v.requestTimeoutMs !== 'number') throw new Error('requestTimeoutMs must be number');
    if (typeof v.requestTimeoutMaxRetries !== 'undefined' && typeof v.requestTimeoutMaxRetries !== 'number') throw new Error('requestTimeoutMaxRetries must be number');
    if (typeof v.requestHead !== 'undefined') {
        if (!isRecord(v.requestHead)) throw new Error('requestHead must be object');
        if (typeof v.requestHead.enabled !== 'undefined' && typeof v.requestHead.enabled !== 'boolean') {
            throw new Error('requestHead.enabled must be boolean');
        }
        if (typeof v.requestHead.failureWarningIgnorePatterns !== 'undefined'
            && (!Array.isArray(v.requestHead.failureWarningIgnorePatterns)
                || !v.requestHead.failureWarningIgnorePatterns.every(x => typeof x === 'string'))) {
            throw new Error('requestHead.failureWarningIgnorePatterns must be string[]');
        }
    }
    if (typeof v.requestTls !== 'undefined') {
        if (!isRecord(v.requestTls)) throw new Error('requestTls must be object');
        if (typeof v.requestTls.rejectUnauthorized !== 'undefined'
            && typeof v.requestTls.rejectUnauthorized !== 'boolean') {
            throw new Error('requestTls.rejectUnauthorized must be boolean');
        }
    }
    if (typeof v.muteResponseStatus !== 'undefined' && typeof v.muteResponseStatus !== 'boolean') throw new Error('muteResponseStatus must be boolean');
    if (typeof v.muteAll !== 'undefined' && typeof v.muteAll !== 'boolean') throw new Error('muteAll must be boolean');
    if (typeof v.disableColorOutput !== 'undefined' && typeof v.disableColorOutput !== 'boolean') throw new Error('disableColorOutput must be boolean');
    if (typeof v.urlCantContain !== 'undefined'
        && (!Array.isArray(v.urlCantContain) || !v.urlCantContain.every(x => typeof x === 'string'))) {
        throw new Error('urlCantContain must be string[]');
    }
    if (typeof v.urlMustContain !== 'undefined'
        && (!Array.isArray(v.urlMustContain) || !v.urlMustContain.every(x => typeof x === 'string'))) {
        throw new Error('urlMustContain must be string[]');
    }
    if (typeof v.treatHashAsUniquePage !== 'undefined' && typeof v.treatHashAsUniquePage !== 'boolean') throw new Error('treatHashAsUniquePage must be boolean');
    if (typeof v.mail !== 'undefined') {
        if (!isRecord(v.mail)) throw new Error('mail must be object');
        if (typeof v.mail.developerRecipients !== 'undefined') {
            assertRecipientArray(v.mail.developerRecipients, 'mail.developerRecipients');
        }
        if (typeof v.mail.reportRecipients !== 'undefined') {
            assertRecipientArray(v.mail.reportRecipients, 'mail.reportRecipients');
        }
        if (typeof v.mail.errorRecipients !== 'undefined') {
            assertRecipientArray(v.mail.errorRecipients, 'mail.errorRecipients');
        }
        if (typeof v.mail.from !== 'undefined') {
            assertRecipient(v.mail.from, 'mail.from');
        }
        if (typeof v.mail.replyTo !== 'undefined') {
            assertRecipientArray(v.mail.replyTo, 'mail.replyTo');
        }
        if (typeof v.mail.transport !== 'undefined') {
            if (!isRecord(v.mail.transport)) throw new Error('mail.transport must be object');
            if (typeof v.mail.transport.auth !== 'undefined') {
                if (!isRecord(v.mail.transport.auth)) throw new Error('mail.transport.auth must be object');
                if (typeof v.mail.transport.auth.username !== 'undefined'
                    && typeof v.mail.transport.auth.username !== 'string') {
                    throw new Error('mail.transport.auth.username must be string');
                }
                if (typeof v.mail.transport.auth.password !== 'undefined'
                    && typeof v.mail.transport.auth.password !== 'string') {
                    throw new Error('mail.transport.auth.password must be string');
                }
            }
            if (typeof v.mail.transport.tls !== 'undefined') {
                if (!isRecord(v.mail.transport.tls)) throw new Error('mail.transport.tls must be object');
                if (typeof v.mail.transport.tls.rejectUnauthorized !== 'undefined'
                    && typeof v.mail.transport.tls.rejectUnauthorized !== 'boolean') {
                    throw new Error('mail.transport.tls.rejectUnauthorized must be boolean');
                }
            }
        }
    }
}

function readJsonUnknown(file: string): unknown {
    // fs-extra's typing returns `any`; contain it here
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return fse.readJsonSync(file);
}

function getAtPath(root: unknown, path: string): JSONValue | null {
    const parts = path.split('.').filter(Boolean);
    if (parts.length === 0) return null;

    let acc: unknown = root;

    for (let i = 0; i < parts.length; i++) {
        const key = parts[i];
        if (!isRecord(acc) || !(key in acc)) return null;
        acc = (acc)[key];
    }

    // accept only JSONValue shapes
    if (
        acc === null ||
        typeof acc === 'string' ||
        typeof acc === 'number' ||
        typeof acc === 'boolean' ||
        Array.isArray(acc) ||
        isRecord(acc)
    ) {
        return acc as JSONValue;
    }

    return null;
}

export class ConfigLoader {

    // local storage for config data
    appConfig?: AppConfig;
    private appConfigName?: string;
    private readonly jobConfigs = new Map<string, JSONObject>();

    private getDefaultAppConfig(): AppConfig {
        return {
            siteName: '',
            domain: '',
            baseUrl: '',
            pathPrefix: '',
            entryFile: '',
            dontResetUrls: false,
            numThreads: 10,
            requestDelayMs: 0,
            requestTimeoutMs: 30000,
            requestTimeoutMaxRetries: 3,
            requestHead: {
                enabled: true,
                failureWarningIgnorePatterns: []
            },
            requestTls: {
                rejectUnauthorized: true
            },
            muteResponseStatus: false,
            muteAll: false,
            disableColorOutput: false,
            urlCantContain: [],
            urlMustContain: [],
            treatHashAsUniquePage: false,
            mail: {
                disabled: true,
                defaultSubject: "Arachnodex {{domain}} Report [{{jobs}}]",
                developerRecipients: [],
                reportRecipients: [],
                errorRecipients: [],
                from: {},
                replyTo: [],
                transport: {
                    host: '',
                    port: 465,
                    secure: true,
                    auth: {
                        username: "",
                        password: ""
                    },
                    tls: {
                        "rejectUnauthorized": true
                    }
                }
            }
        };
    }

    loadAppConfig(configName = 'default', command?: BaseCommandParser): AppConfig {
        if(this.appConfigName === configName
            && typeof this.appConfig !== 'undefined'
            && typeof command === 'undefined') {
            return this.appConfig;
        }

        const configFile = `./config/${configName}.json`;
        const defaults = this.getDefaultAppConfig();

        if (fse.pathExistsSync(configFile)) {
            const u = readJsonUnknown(configFile);
            assertAppConfig(u);
            const fileCfg: AppConfigInput = u;
            const fileMail = isRecord(fileCfg.mail) ? fileCfg.mail : {};
            const fileTransport = isRecord(fileCfg.mail?.transport) ? fileCfg.mail.transport : {};
            const fileAuth = isRecord(fileCfg.mail?.transport?.auth) ? fileCfg.mail.transport.auth : {};
            const fileTls = isRecord(fileCfg.mail?.transport?.tls) ? fileCfg.mail.transport.tls : {};
            let appConfig: AppConfig = {
                ...defaults,
                ...fileCfg,
                requestHead: {
                    ...defaults.requestHead,
                    ...(isRecord(fileCfg.requestHead) ? fileCfg.requestHead : {})
                },
                requestTls: {
                    ...defaults.requestTls,
                    ...(isRecord(fileCfg.requestTls) ? fileCfg.requestTls : {})
                },
                mail: {
                    ...defaults.mail,
                    ...fileMail,
                    transport: {
                        ...defaults.mail.transport,
                        ...fileTransport,
                        auth: {
                            ...defaults.mail.transport.auth,
                            ...fileAuth
                        },
                        tls: {
                            ...defaults.mail.transport.tls,
                            ...fileTls
                        }
                    }
                }
            } as AppConfig;
            if(typeof command !== 'undefined') {
                appConfig = this.applyCommandConfigOverrides(appConfig, command);
            }
            this.appConfig = appConfig;
            this.appConfigName = configName;
            return appConfig;
        }

        throw new Error('No application config loaded.');
    }

    private ensureAppConfig(): AppConfig {
        if(typeof this.appConfig === 'undefined') {
            return this.loadAppConfig();
        }

        return this.appConfig;
    }


    loadJobConfigFile<T extends JSONObject>(defaults: T, configFile:string): T|null {
        if (!fse.pathExistsSync(configFile)) return null;

        const raw: unknown = readJsonUnknown(configFile); // unknown by design

        // validate shape at least shallowly
        if (!isJSONObject(raw)) {
            throw new Error(`Config file '${configFile}' must contain a JSON object`);
        }

        // Treat file data as a partial overlay of defaults
        const overlay = raw as Partial<T>;

        // Merge and return as T (defaults is T; overlay is Partial<T>)
        return {...defaults, ...overlay};
    }

    getJobConfig<T extends JSONObject>(
        defaults: T,
        command: BaseCommandParser,
        configRequired = false,
        validationCallback?: (config: T) => void): T
    {
        const configName = command.getConfigName();

        if(!this.jobConfigs.has(configName)) {
            const configFile = `./config/${configName}.json`;
            let jobConfig = this.loadJobConfigFile(defaults, configFile);
            if (!jobConfig) {
                if (configRequired) {
                    throw new Error(`A config file named '${configName}.json' is required but was not found.`);
                } else {
                    jobConfig = defaults;
                }
            }


            jobConfig = this.applyCommandConfigOverrides(jobConfig, command);

            // Run config validation if one was passed in.
            // Validation callbacks are responsible for their own
            // Error emitting and terminating execution if necessary.
            if (typeof validationCallback !== 'undefined') {
                validationCallback(jobConfig);
            }

            this.jobConfigs.set(configName, jobConfig);
        }

        return this.jobConfigs.get(configName)! as T;
    }



    // Overwrite (or create) config data at the supplied path
    setConfigValue<T extends object>(
        configData: T,
        configPath: string,
        value: JSONPrimitive
    ): T {
        // Clone current config so we can mutate safely
        const next = structuredClone(configData) as Record<string, unknown>;

        const parts = configPath.split('.').filter(Boolean);
        if (parts.length > 0) {
            // Walk the path using a typed dictionary view
            let acc: Record<string, unknown> = next;

            for (let i = 0; i < parts.length; i++) {
                const key = parts[i];
                const isLast = i === parts.length - 1;

                if (isLast) {
                    // JSONPrimitive fits your schema for leaf values per your method signature
                    acc[key] = value;
                    break;
                }

                const cur = acc[key];
                if (!isRecord(cur)) {
                    const child: Record<string, unknown> = {};
                    acc[key] = child;
                    acc = child;
                } else {
                    acc = cur;
                }
            }
        }

        // cast back to the original generic type T
        return next as unknown as T;
    }

    private applyCommandConfigOverrides<T extends object>(configData: T, command: BaseCommandParser): T {
        let next = configData;
        const seen = new Set<unknown>();
        for (const i in command.arguments) {
            const arg = command.arguments[i];
            if(seen.has(arg)) {
                continue;
            }
            seen.add(arg);

            if (typeof arg.configPath !== 'string' || arg.active !== true) {
                continue;
            }

            if(typeof arg.type === 'undefined') {
                next = this.setConfigValue(next, arg.configPath, true);
                continue;
            }

            if((arg.type === 'string' || arg.type === 'number')
                && (typeof arg.input === 'string' || typeof arg.input === 'number')) {
                next = this.setConfigValue(next, arg.configPath, arg.input);
            }
        }

        return next;
    }

    // Type-Safe config string fetcher
    getConfigString(configPath: string, configName?: string|null, defaultValue = ""): string {
        const value = this.getConfigValue(configPath, configName);
        return typeof value === 'string' ? value : defaultValue;
    }

    // Type-Safe config boolean fetcher
    getConfigBoolean(configPath: string, configName?: string|null, defaultValue = false): boolean {
        const value = this.getConfigValue(configPath, configName);
        if(typeof value === 'boolean') { return value; }
        return defaultValue;
    }

    // Type-Safe config number fetcher
    getConfigNumber(configPath: string, configName?: string|null, defaultValue = 0): number {
        const value = this.getConfigValue(configPath, configName);
        return typeof value === 'number' ? value : defaultValue;
    }

    // Type-Safe config RegExp[] fetcher
    // Returns [] at base if nothing else.
    getConfigRegExArray(configPath: string, configName?: string|null): RegExp[] {
        let value = this.getConfigValue(configPath, configName);
        if(typeof value === 'string') { value = [value]; }
        const typedData:RegExp[] = [];
        if(Array.isArray(value)) {
            value.forEach(item => {
                if (typeof item === 'string') {
                    typedData.push(new RegExp(item));
                }
            });
        }
        return typedData;
    }

    // Fetch raw data from the config object - Loosely Typed.
    getConfigValue<T extends JSONValue>(configPath: string, configName?: string|null, returnAs?: T): T
    {
        const name = configName ?? null;
        const src =
            name !== null && name !== 'app' && name !== 'default' && this.jobConfigs.has(name)
                ? this.jobConfigs.get(name)!
                : this.ensureAppConfig();

        const val = getAtPath(src, configPath);

        if (returnAs !== undefined && isJSONObject(returnAs) && isJSONObject(val)) {
            for (const [k, v] of Object.entries(val)) returnAs[k] = v;
            return returnAs;
        }

        if (returnAs !== undefined && isJSONArray(returnAs) && isJSONArray(val)) {
            returnAs.length = 0;
            for (const item of val) returnAs.push(item);
            return returnAs;
        }

        return val as T;
    }
}

export const ConfigService = new ConfigLoader();
