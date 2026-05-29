"use strict";

import EventEmitter from "eventemitter3";
import type {ArachnodexThread} from "./arachnodexThread.js";
import type {ThreadState} from "./activeThreads.js";
import {ConfigLoader} from "./services/configLoader.js";
import {UrlHelperService} from "./services/urlHelper.js";
import {Lock} from "./lib/lock.js";
import {Mutex} from "./lib/mutex.js";

export class ArachnodexRuntime {
    private readonly abortController = new AbortController();
    readonly events = new EventEmitter();
    readonly config = new ConfigLoader();
    readonly urlHelper = new UrlHelperService(this.config);
    readonly activeThreads: Map<ArachnodexThread, ThreadState> = new Map();
    readonly lock = new Lock(this.events);
    readonly turnMutex = new Mutex();
    throttledRequestCount = 0;

    get abortSignal(): AbortSignal {
        return this.abortController.signal;
    }

    get aborted(): boolean {
        return this.abortController.signal.aborted;
    }

    abort(reason = 'Arachnodex runtime aborted.'): void {
        if(!this.abortController.signal.aborted) {
            this.abortController.abort(reason);
        }
    }

    dispose(): void {
        this.abort('Arachnodex runtime disposed.');
        this.activeThreads.clear();
        this.events.removeAllListeners();
    }
}
