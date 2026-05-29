import type { ArachnodexThread } from "./arachnodexThread.js";
export type ThreadState = {
    lastRequestTs: number | null;
    inFlight: boolean;
    claimed: boolean;
};
export declare const activeThreads: Map<ArachnodexThread, ThreadState>;
