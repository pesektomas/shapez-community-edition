import type { Clock } from "./clock.ts";

/**
 * Token bucket: allows bursts up to `capacity`, refills `perSecond` tokens per second
 */
export class RateLimiter {
    private readonly clock: Clock;
    private readonly capacity: number;
    private readonly perSecond: number;
    private tokens: number;
    private last: number;

    constructor(clock: Clock, capacity: number, perSecond: number) {
        this.clock = clock;
        this.capacity = capacity;
        this.perSecond = perSecond;
        this.tokens = capacity;
        this.last = clock.now();
    }

    take(): boolean {
        const now = this.clock.now();
        this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
        this.last = now;
        if (this.tokens < 1) {
            return false;
        }
        this.tokens -= 1;
        return true;
    }
}
