"use strict";
import { setTimeout as sleep } from "timers/promises";
import eventBus from "./eventBus.js";
export class Lock {
    private locked = false;
    private hardLocked = false;

    async forUnlock() : Promise<void> {
        while (this.locked) {
            await sleep(25);
        }
    }

    isLocked(): boolean {
        return this.locked;
    }

    lock(hardLock = false): void {
        this.locked = true;
        if(hardLock) {
            this.hardLocked = true;
        }
        eventBus.emit('lock-state-update', true);
    }

    unlock(): void {
        if(!this.hardLocked) {
            this.locked = false;
            eventBus.emit('lock-state-update', false);
        }
    }
}

export default new Lock();
