export declare class Mutex {
    private locked;
    private queue;
    acquire(): Promise<() => void>;
    private release;
}
