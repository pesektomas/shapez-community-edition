import type { GameRoot } from "../game/root";
import { createSnapshot, type CoopSnapshot } from "./snapshot";

/**
 * Returns the canonical simulation state: the snapshot without parts which
 * are per-player (camera, pinned shapes) or not simulated (real time).
 */
export function getCanonicalState(root: GameRoot, snapshot: CoopSnapshot = createSnapshot(root)) {
    const { camera: _camera, pinnedShapes: _pinned, time, ...dump } = snapshot.dump;
    return {
        dump: {
            ...dump,
            time: { timeSeconds: time.timeSeconds },
        },
        extras: snapshot.extras,
    };
}

/**
 * 64 bit hash (two independent 32 bit FNV-1a style lanes) of a string,
 * returned as 16 hex characters.
 */
export function hashString(str: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193 ^ 0x9e3779b9;
    for (let i = 0; i < str.length; ++i) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ c, 0x5bd1e995);
        h2 ^= h2 >>> 15;
    }
    h1 ^= h1 >>> 13;
    h1 = Math.imul(h1, 0x85ebca6b);
    h1 ^= h1 >>> 16;
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export function computeStateHash(root: GameRoot, snapshot?: CoopSnapshot): string {
    return hashString(JSON.stringify(getCanonicalState(root, snapshot)));
}
