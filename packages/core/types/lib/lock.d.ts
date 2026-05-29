export declare class Lock {
    private locked;
    private hardLocked;
    forUnlock(): Promise<void>;
    isLocked(): boolean;
    lock(hardLock?: boolean): void;
    unlock(): void;
}
declare const _default: Lock;
export default _default;
