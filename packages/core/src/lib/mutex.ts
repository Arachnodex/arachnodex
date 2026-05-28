"use strict";

export class Mutex {
    private locked = false;
    private queue: Array<() => void> = [];

    async acquire(): Promise<() => void> {
        if (!this.locked) {
            this.locked = true;
            return () => this.release();
        }

        await new Promise<void>((resolve) => {
            this.queue.push(resolve);
        });

        this.locked = true;

        return () => this.release();
    }

    private release(): void {
        const next = this.queue.shift();
        if (next) {
            next();
            return;
        }

        this.locked = false;
    }
}
