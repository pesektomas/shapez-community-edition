/**
 * Small per-browser settings of co-op games (nickname, joined worlds)
 */

export interface RememberedWorld {
    id: string;
    key: string;
    name: string;
    lastPlayed: number;
}

const NAME_KEY = "tvarovna.name";
const WORLDS_KEY = "tvarovna.worlds";
const MAX_WORLDS = 20;

function read<T>(key: string, fallback: T): T {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

function write(key: string, value: unknown) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage not available (private mode), not critical
    }
}

export function getPlayerName(): string {
    return read<string>(NAME_KEY, "");
}

export function setPlayerName(name: string) {
    write(NAME_KEY, name);
}

export function getRememberedWorlds(): RememberedWorld[] {
    const worlds = read<RememberedWorld[]>(WORLDS_KEY, []);
    return Array.isArray(worlds) ? worlds.sort((a, b) => b.lastPlayed - a.lastPlayed) : [];
}

export function rememberWorld(world: RememberedWorld) {
    const worlds = getRememberedWorlds().filter(w => w.id !== world.id);
    worlds.unshift(world);
    write(WORLDS_KEY, worlds.slice(0, MAX_WORLDS));
}

export function forgetWorld(id: string) {
    write(
        WORLDS_KEY,
        getRememberedWorlds().filter(w => w.id !== id)
    );
}
