import type EventEmitter from "eventemitter3";
export declare class Lock {
    private readonly events;
    private locked;
    private hardLocked;
    constructor(events?: EventEmitter | null);
    forUnlock(): Promise<void>;
    isLocked(): boolean;
    lock(hardLock?: boolean): void;
    unlock(): void;
}
declare const _default: Lock;
export default _default;
