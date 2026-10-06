import { decode, encode } from "@msgpack/msgpack";
import type { CoopSnapshot } from "./snapshot";

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
    const response = new Response(new Blob([data.slice()]).stream().pipeThrough(stream));
    return new Uint8Array(await response.arrayBuffer());
}

/**
 * Encodes the snapshot synchronously (so it can not change afterwards) and
 * compresses it asynchronously.
 */
export function encodeSnapshot(snapshot: CoopSnapshot): Promise<Uint8Array> {
    // NOTE: Keys with undefined values are dropped, like JSON would do
    const raw = encode(snapshot, { ignoreUndefined: true });
    return pipe(raw, new CompressionStream("gzip"));
}

export async function decodeSnapshot(data: Uint8Array): Promise<CoopSnapshot> {
    const raw = await pipe(data, new DecompressionStream("gzip"));
    return decode(raw) as CoopSnapshot;
}
