const htmlMediaTypes = new Set<string>([
    'text/html',
    'text/x-html',
    'text/x-server-parsed-html',
    'text/xhtml',
    'application/html',
    'application/x-html',
    'application/xhtml',
    'application/xhtml+xml'
]);

export function normalizeContentTypeHeader(value: unknown): string {
    const values: unknown[] = Array.isArray(value) ? value : [value];
    const header = values
        .filter((entry): entry is string => typeof entry === 'string')
        .join(',');
    return header.split(',', 1)[0].split(';', 1)[0].trim().toLowerCase();
}

export function isHtmlContentType(value: unknown): boolean {
    const mediaType = normalizeContentTypeHeader(value);
    return htmlMediaTypes.has(mediaType)
        || /^application\/(?:[a-z0-9!#$&^_.+-]+\.)+xhtml\+xml$/.test(mediaType);
}
