/*
// Example pattern for default properties in class
// from stack overflow: https://stackoverflow.com/questions/35074365/typescript-interface-default-values\
*/

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
    jsdom?:never;
}

export type JobError = {
    errorObject: Error;
    message: string;
    location?: Location;
}




export type Report = {
    id: string;
    job?: string;
}
