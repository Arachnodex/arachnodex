export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;
export interface JSONObject { [key: string]: JSONValue | undefined }
export type JSONArray = JSONValue[];

// Simple name-to-email maps as used in JSON.
export type RecipientMap = Record<string, string>;
export type Recipient = string | RecipientMap;

//export type ObjectMap = Record<string, JSONObject>;
export type ObjectMap<T extends JSONObject = JSONObject> = Record<string, T>;

export interface MailTransportTLS extends JSONObject {
    rejectUnauthorized?: boolean;
}

export interface MailAuth extends JSONObject {
    username: string;
    password: string;
}

export interface MailTransportConfig extends JSONObject {
    host: string;
    port: number | string;
    secure: boolean;
    auth?: MailAuth;
    tls?: MailTransportTLS;
}

export interface RequestTlsConfig extends JSONObject {
    rejectUnauthorized: boolean;
}

export interface MailConfig {
    disabled: boolean;
    defaultSubject: string;
    developerRecipients: Recipient[]; // e.g., ["name@..."] or [{"First Last":"name@..."}]
    reportRecipients: Recipient[];    // same shape as above
    errorRecipients: Recipient[];     // same shape as above
    from: Recipient;                  // same shape as above
    replyTo: Recipient[];             // same shape as above
    transport: MailTransportConfig;
}

export interface AppConfig {
    siteName: string;
    domain: string;
    baseUrl: string;
    pathPrefix: string;
    entryFile: string;
    dontResetUrls: boolean;
    numThreads: number;
    requestDelayMs: number;
    requestTimeoutMs: number;
    requestTimeoutMaxRetries: number;
    requestTls: RequestTlsConfig;
    muteResponseStatus: boolean;
    muteAll: boolean;
    disableColorOutput: boolean;
    urlCantContain: string[];
    urlMustContain: string[];
    treatHashAsUniquePage: boolean;
    mail: MailConfig;
}

export type CrawlerStats = {
    totals: {
        requestedHead: number,
        downloadedData: number,
        pagesScraped: number,
    },
    logs: {
        requestedHead: string[],
        downloadedData: string[],
        pagesScraped: string[],
    }
}

export type ReportDataValue = string|number|boolean|null;
export type ReportData = Record<string, ReportDataValue>;

export type CrawlerError = {
    message: string;
    error?: Error;
    location?: Location;
    suppressEmail?: boolean;
    fatal?: boolean;
}

export type Location = {
    url: string;
    rawUrl: string;
    referer?: string;
    htmlSnippet?: string;
    referredAsCanonical?: boolean;
    canonicalUrl?: string;
    redirectedFrom?: string;
    redirectedTo?: string;
    redirectRoot?: string;
    redirectChain?: string[];
    redirectCode?: number;
    hash?: string;
    queryString?: string;
    statusCode?: number;
    dataReceived?: boolean;
    retryAttempt?: number;
}

export type LinkIssueSeverity = 'error' | 'warning' | 'notice';

export type LinkZone = 'nav'|'header'|'footer'|'aside'|'before-main'|'after-main'|'main'|'unknown';

export type PageParseWarning = {
    type: 'malformed-href'|'malformed-canonical';
    message: string;
    rawValue: string;
    referer: string;
    htmlSnippet?: string;
}

export type PageLink = {
    rawHref: string;
    hasHref: boolean;
    htmlSnippet?: string;
    normalizedUrl?: string;
    referer: string;
    text?: string;
    target?: string;
    rel?: string;
    zone?: LinkZone;
    isExternal: boolean;
    isCrawlable: boolean;
    parseWarnings?: PageParseWarning[];
}

export type PageAuditOutcome =
    | {
        status: 'complete';
        contentType: string;
    }
    | {
        status: 'non-html';
        contentType: string;
        lastModified?: string;
    }
    | {
        status: 'failed';
        phase: 'body-fetch'|'parse';
        contentType: string;
        message: string;
        errorCode?: string;
        statusCode?: number;
    };

export type PageData = {
    location: Location;
    links: string[];
    rawLinks: PageLink[];
    parseWarnings: PageParseWarning[];
    contentType: string;
    auditOutcome?: PageAuditOutcome;
    canonical?: Location;
    jsdom?:Document;
}

export type JobCommand = {
    name: string;
    arguments: string[];
}

export type JobError = {
    errorObject: Error;
    message: string;
    location?: Location;
}

export type ArgumentConfig = {
    switch: string;
    aliases?: string[];
    value: boolean;
    description: string;
    note?: string;
    label?: string;
    type?: string;
    configPath?: string;
    input?: string|number;
    active?: boolean;
}

export type Report = {
    id: string;
    job?: string;
}

export type DeepPartial<T> =
    T extends (infer U)[] ? DeepPartial<U>[] :
        T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } :
            T;
