"use strict";

import type { ArachnodexThread } from "./arachnodexThread.js";

export type ThreadState = {
    lastRequestTs: number | null;
    inFlight: boolean;
    claimed: boolean;
};

export const activeThreads: Map<ArachnodexThread, ThreadState> = new Map();
