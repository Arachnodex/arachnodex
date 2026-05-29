import type { Location } from "../definitions.ts";
declare class _urlHelper {
    baseUrl: string;
    domain: string;
    urlCantContain: RegExp[];
    urlMustContain: RegExp[];
    dontResetUrls: boolean;
    treatHashAsUniquePage: boolean;
    private initialized;
    loadConfig(): void;
    private ensureConfigLoaded;
    validateLocation(url: string, ruleSet: string): boolean;
    prepareUrl(location: Location): boolean;
    createLocationFromLink(link: string, currentLoc: Location): Location | null;
    isWebLink(href: string | null | undefined): boolean;
    resetUrl(location: Location): void;
    assignUrlSegment(location: Location): void;
    private getDocumentRootBase;
    private isHttpUrl;
    private isInternalHostname;
    private normalizeHostname;
    private removeBaseUrl;
}
export declare const UrlHelper: _urlHelper;
export {};
