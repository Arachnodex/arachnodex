"use strict";

import type {Location} from "../definitions.ts";
import {ConfigService} from "./configLoader.js";

class _urlHelper {

    baseUrl = '';
    domain = '';
    validator: RegExp = /^$/;
    urlCantContain: RegExp[] = [];
    urlMustContain: RegExp[] = [];
    dontResetUrls = false;
    treatHashAsUniquePage = false;
    private initialized = false;

    loadConfig(): void {

        // populate locally needed config data as props
        this.baseUrl = ConfigService.getConfigString('baseUrl');
        this.domain = ConfigService.getConfigString('domain');
        this.urlCantContain = ConfigService.getConfigRegExArray('urlCantContain');
        this.urlMustContain = ConfigService.getConfigRegExArray('urlMustContain');
        this.validator = new RegExp('^(//|https?://)([wW]{3}\\.)?' + this.domain);
        this.dontResetUrls = ConfigService.getConfigBoolean('dontResetUrls');
        this.treatHashAsUniquePage = ConfigService.getConfigBoolean('treatHashAsUniquePage');

        // Force path prefix if provided
        const prefix = ConfigService.getConfigString('pathPrefix');
        if(prefix !== '') {
            this.urlMustContain.push(new RegExp(this.domain + prefix));
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

        //todo implement following at least basic javascript onclick links?

        // Handle full https:// style links. Return false if domain
        // does not match, other wise reset the URL and return true.
        if (location.url.match(/^\/\/|^https?:\/\//)) {

            // Accept as internal if starts by matching our base url validation pattern
            if (location.url.match(this.validator)) {
                this.resetUrl(location);
                return true;
            }

            // Off-site link :(
            return false;
        }

        // Do not follow "protocol" links like mailto:, tel:, ftp://, etc.
        if (location.url.match(/^[^.]*:/)) {
            return false
        }

        // Allow absolute path outright
        if (location.url.match(/^\//)) {
            this.resetUrl(location);
            return true;
        }


        // Relative Path
        // Assemble absolute URL based on the "directory" of the referring URL


        // Make sure we have a valid variable to work with
        const referer = location.referer ?? location.redirectedFrom ?? "";

        // No referer so it must be relative to document root.
        if (referer === "") {

            location.url = "/" + location.url;

        } else {

            // URL Does not end in a slash so we must treat the last segment as a "file"
            // We must remove the file segment and replace it with the new relative URL
            // to properly emulate the behavior of the browser.
            if (referer.substring(-1) !== '/') {
                const referer_parts = referer.split('/');
                referer_parts.pop();
                location.url = (referer_parts.join('/') ?? "/").replace(/\/+$/, '') + '/' + location.url;
            } else {
                // URL Ends with a slash so the referring URL is treated
                // as a directory in full and the new relative URL is appended
                // directly to the referring URL.
                location.url = referer + location.url;
            }

        }


        this.resetUrl(location);
        return true;
    }

    createLocationFromLink(link:string, currentLoc:Location): Location|null {
        this.ensureConfigLoaded();

        if(this.isWebLink(link)) {
            let fullUrl;
            if (link.match(/^#/)) {
                fullUrl = currentLoc.url + link;
            } else if (link.match(/^\/\//)) {
                fullUrl = new URL(link, this.baseUrl).href;
            } else if (!link.match(/^https?:\/\//i)) {
                if (link.match(/^\//)) {
                    // Absolute path
                    const base = this.baseUrl.trim().replace(/\/$/, '');
                    fullUrl = `${base}${link}`;
                } else {
                    // Relative Path
                    const base = currentLoc.url.trim().replace(/\/$/, '');
                    fullUrl = `${base}/${link}`;
                }
            } else {
                fullUrl = link;
            }

            return {
                url: fullUrl,
                rawUrl: fullUrl.replace(new RegExp('^' + this.baseUrl.replace(/\/$/i, '')), ''),
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

        // Remove all protocol and host segments of the URL
        // to reset to an absolute relative URL eg. "/contact" (adds slash if necessary)
        location.url = location.url.replace(this.validator, "");
        if (location.url.substring(0, 1) !== '/') {
            location.url = '/' + location.url;
        }

        // Prepend base url to make it a FULL url eg "https://www.example.com/contact"
        location.url = (this.baseUrl + location.url).trim();
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
}

export const UrlHelper = new _urlHelper();
