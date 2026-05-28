export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray;
export interface JSONObject { [key: string]: JSONValue | undefined }
export type JSONArray = JSONValue[];

// Simple name→email maps as used in your JSON
export type RecipientMap = Record<string, string>;

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

export interface MailConfig {
    disabled: boolean;
    defaultSubject: string;
    developerRecipients: RecipientMap[]; // e.g., [{"First Last":"name@..."}]
    reportRecipients: RecipientMap[];    // same shape as above
    errorRecipients: RecipientMap[];     // same shape as above
    from: RecipientMap;                  // same shape as above
    replyTo: RecipientMap[];             // same shape as above
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
}

export type PageLink = {
    rawHref: string;
    hasHref: boolean;
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

export type PageData = {
    location: Location;
    links: string[];
    rawLinks: PageLink[];
    parseWarnings: PageParseWarning[];
    contentType: string;
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
