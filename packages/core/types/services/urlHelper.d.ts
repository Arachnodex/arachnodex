import type { Location } from "../definitions.ts";
import type { ConfigLoader } from "./configLoader.js";
export declare class UrlHelperService {
    private readonly config;
    baseUrl: string;
    domain: string;
    urlCantContain: RegExp[];
    urlMustContain: RegExp[];
    dontResetUrls: boolean;
    treatHashAsUniquePage: boolean;
    private initialized;
    constructor(config?: ConfigLoader);
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
export declare const UrlHelper: UrlHelperService;
