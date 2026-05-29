"use strict";

import type {Location} from "../definitions.ts";
import {ConfigService} from "./configLoader.js";
import type {ConfigLoader} from "./configLoader.js";

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class UrlHelperService {

    baseUrl = '';
    domain = '';
    urlCantContain: RegExp[] = [];
    urlMustContain: RegExp[] = [];
    dontResetUrls = false;
    treatHashAsUniquePage = false;
    private initialized = false;

    constructor(private readonly config: ConfigLoader = ConfigService) {}

    loadConfig(): void {

        // populate locally needed config data as props
        this.baseUrl = this.config.getConfigString('baseUrl').replace(/\/+$/, '');
        this.domain = this.config.getConfigString('domain');
        this.urlCantContain = this.config.getConfigRegExArray('urlCantContain');
        this.urlMustContain = this.config.getConfigRegExArray('urlMustContain');
        this.dontResetUrls = this.config.getConfigBoolean('dontResetUrls');
        this.treatHashAsUniquePage = this.config.getConfigBoolean('treatHashAsUniquePage');

        // Force path prefix if provided
        const prefix = this.config.getConfigString('pathPrefix');
        if(prefix !== '') {
            this.urlMustContain.push(new RegExp(escapeRegExp(this.domain + prefix)));
        }

        this.initialized = true;
    }

    private ensureConfigLoaded(): void {
        if(!this.initialized) {
            this.loadConfig();
        }
    }

    validateLocation(url: string, ruleSet:string): boolean {
        this.ensureConfigLoaded();

        if(ruleSet !== 'urlCantContain' && ruleSet !== 'urlMustContain') {
            throw Error("ruleSet must match 'urlCantContain' or 'urlMustContain'");
        }

        if (this[ruleSet].length <= 0) {
            return true;
        }

        // CantContain operates via OR
        // MustContain operates via AND
        let found = 0;
        if (this[ruleSet].length > 0) {
            this[ruleSet].every(search => {

                if (url.match(search)) {
                    found++;
                    if(ruleSet === 'urlCantContain') { return false; } // brake out here (OR)
                }

                return true; // continue
            });
        }

        // OR -- return true if any rule matched, otherwise false.
        if(ruleSet === 'urlCantContain') {
            return (found === 0);
        }

        // AND - return true if ALL rules matched, otherwise false.
        return this[ruleSet].length === found;

    }


    prepareUrl(location: Location): boolean {
        this.ensureConfigLoaded();

        location.url = location.url.trim();

        // remove and store URL hash and query string data if present
        this.assignUrlSegment(location)

        // Add query string back to URL
        if(typeof location.queryString !== 'undefined' && location.queryString !== '') {
            location.url += "?" + location.queryString;
        }

        if(this.treatHashAsUniquePage) {
            // Add hash string back to URL
            if(typeof location.hash !== 'undefined' && location.hash !== '') {
                location.url += "#" + location.hash;
            }
        }

        if(!this.isWebLink(location.url)) {
            return false;
        }

        const base = location.referer ?? location.redirectedFrom ?? this.getDocumentRootBase();
        let parsed: URL;
        try {
            parsed = new URL(location.url, base);
        } catch {
            return false;
        }

        if(!this.isHttpUrl(parsed) || !this.isInternalHostname(parsed.hostname)) {
            return false;
        }

        location.url = parsed.href;
        this.resetUrl(location);
        return true;
    }

    createLocationFromLink(link:string, currentLoc:Location): Location|null {
        this.ensureConfigLoaded();

        const href = link.trim();
        if(this.isWebLink(href)) {
            let fullUrl: string;
            try {
                const baseUrl = currentLoc.url !== '' ? currentLoc.url : this.getDocumentRootBase();
                fullUrl = new URL(href, baseUrl).href;
            } catch {
                return null;
            }

            return {
                url: fullUrl,
                rawUrl: this.removeBaseUrl(fullUrl),
                referer: currentLoc.url

            };
        }
        return null;
    }

    isWebLink(href: string | null | undefined): boolean {
        if (href == null) return false;

        // Trim whitespace just in case
        href = href.trim();

        // Skip javascript: links
        if (/^javascript:/i.test(href)) return false;

        // Skip known non-web protocols
        if (/^(mailto|tel|ftp|file|data):/i.test(href)) return false;

        // Allow full HTTP/HTTPS URLs
        if (/^https?:\/\//i.test(href)) return true;

        // Allow root-relative paths
        if (href.startsWith("/")) return true;

        // Allow relative paths that don't start with a protocol
        return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
    }


    // Resets & normalizes the URL with the proper protocol and host based on the ConfigService.
    resetUrl(location:Location):void {
        this.ensureConfigLoaded();

        // Don't reset the URL if disabled in config
        if(this.dontResetUrls) { return; }

        let parsed: URL;
        try {
            parsed = new URL(location.url, this.getDocumentRootBase());
        } catch {
            return;
        }

        if(!this.isInternalHostname(parsed.hostname)) {
            return;
        }

        // Prepend base url to make it a FULL url eg "https://www.example.com/contact"
        location.url = `${this.baseUrl}${parsed.pathname}${parsed.search}${parsed.hash}`.trim();
    }

    // Removes either the hash or query string segment and stores them in the Location object
    assignUrlSegment(location: Location):void {
        let parts: string[] = location.url.split('#');
        location.url = parts.shift() ?? location.url;
        if(parts.length == 1) { location.hash = parts.shift(); }
        parts = location.url.split('?');
        location.url = parts.shift() ?? location.url;
        if(parts.length == 1) { location.queryString = parts.shift(); }
        // const character = segment === 'hash' ? '#' : '?';
        // const parts: string[] = location.url.split(character);
        // location.url = parts.shift() ?? "";
        // location[segment] = typeof parts[0] === 'string' ? parts[0] : "";
    }

    private getDocumentRootBase(): string {
        return this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    }

    private isHttpUrl(url: URL): boolean {
        return url.protocol === 'http:' || url.protocol === 'https:';
    }

    private isInternalHostname(hostname: string): boolean {
        return this.normalizeHostname(hostname) === this.normalizeHostname(this.domain);
    }

    private normalizeHostname(hostname: string): string {
        return hostname.toLowerCase().replace(/^www\./, '');
    }

    private removeBaseUrl(url: string): string {
        try {
            const parsed = new URL(url);
            const base = new URL(this.getDocumentRootBase());
            if(parsed.protocol === base.protocol && this.normalizeHostname(parsed.hostname) === this.normalizeHostname(base.hostname)) {
                return `${parsed.pathname}${parsed.search}${parsed.hash}`;
            }
        } catch {
            return url;
        }

        return url;
    }
}

export const UrlHelper = new UrlHelperService();
