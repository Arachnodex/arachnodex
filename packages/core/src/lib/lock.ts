"use strict";
import { setTimeout as sleep } from "timers/promises";
import type EventEmitter from "eventemitter3";
import eventBus from "./eventBus.js";
export class Lock {
    private locked = false;
    private hardLocked = false;

    constructor(private readonly events: EventEmitter | null = null) {}

    async forUnlock() : Promise<void> {
        while (this.locked && !this.hardLocked) {
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
        (this.events ?? eventBus).emit('lock-state-update', true);
    }

    unlock(): void {
        if(!this.hardLocked) {
            this.locked = false;
            (this.events ?? eventBus).emit('lock-state-update', false);
        }
    }
}

export default new Lock();
