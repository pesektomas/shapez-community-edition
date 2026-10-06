/**
 * COOP: Global switches for the serializer. Co-op snapshots must restore the
 * exact simulation state, so they serialize numbers without rounding.
 */
export const serializationOptions = {
    /** When true, floats are stored as exact doubles instead of 4 digits */
    lossless: false,
};

/**
 * Runs the given function with lossless number serialization enabled
 */
export function withLosslessSerialization<T>(fn: () => T): T {
    const previous = serializationOptions.lossless;
    serializationOptions.lossless = true;
    try {
        return fn();
    } finally {
        serializationOptions.lossless = previous;
    }
}

/**
 * Rounds the number like the regular serializer, unless lossless mode is active
 */
export function serializeNumber(value: number, round: (n: number) => number): number {
    return serializationOptions.lossless ? value : round(value);
}
