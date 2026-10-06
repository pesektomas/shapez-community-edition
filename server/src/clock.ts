/**
 * Time source of the server, replaced by a fake clock in tests
 */
export interface Clock {
    now(): number;
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
}

export const systemClock: Clock = {
    now: () => performance.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};
