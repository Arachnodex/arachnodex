import EventEmitter from "eventemitter3";
import type { ArachnodexThread } from "./arachnodexThread.js";
import type { ThreadState } from "./activeThreads.js";
import { ConfigLoader } from "./services/configLoader.js";
import { UrlHelperService } from "./services/urlHelper.js";
import { Lock } from "./lib/lock.js";
import { Mutex } from "./lib/mutex.js";
export declare class ArachnodexRuntime {
    readonly events: EventEmitter<string | symbol, any>;
    readonly config: ConfigLoader;
    readonly urlHelper: UrlHelperService;
    readonly activeThreads: Map<ArachnodexThread, ThreadState>;
    readonly lock: Lock;
    readonly turnMutex: Mutex;
    throttledRequestCount: number;
    dispose(): void;
}
