"use strict";

export type BotProtectionHeuristics = {
    headerMarkers: string[];
    bodyMarkers: string[];
}

export const botProtectionHeuristics: BotProtectionHeuristics = {
    headerMarkers: [
        // Imperva / Incapsula
        'x-iinfo:',
        'visid_incap_',
        'incap_ses_',
        'incapsula',

        // Cloudflare
        'cf-mitigated: challenge',

        // DataDome
        'datadome'
    ],
    bodyMarkers: [
        // Imperva / Incapsula
        '/_incapsula_resource',

        // Cloudflare
        'cf-chl-',
        'checking your browser',

        // Generic bot challenge text
        'not a robot',
        'captcha',

        // DataDome
        'datadome'
    ]
};
