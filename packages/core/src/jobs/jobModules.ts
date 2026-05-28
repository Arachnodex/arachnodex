"use strict";

const explicitPackagePrefix = 'npm:';

export function getJobModuleName(jobHandle: string): string {
    // Short handles are reserved for official-style packages. Scoped packages and npm:
    // prefixed names are imported exactly so third-party jobs can live under any namespace.
    if(jobHandle.startsWith(explicitPackagePrefix)) {
        return jobHandle.substring(explicitPackagePrefix.length);
    }

    if(jobHandle.startsWith('@')) {
        return jobHandle;
    }

    return `@arachnodex/job-${jobHandle}`;
}
