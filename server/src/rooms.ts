import { randomBytes, randomInt } from "node:crypto";
import { START_LEVELS, type StartMode, type WorldMeta } from "../../shared/protocol.ts";
import type { Clock } from "./clock.ts";
import type { Store } from "./db.ts";
import { Room, type Logger, type RoomConfig } from "./room.ts";

/**
 * Creates worlds and keeps the rooms of worlds which are in use
 */
export class Rooms {
    private readonly rooms = new Map<string, Room>();
    private readonly store: Store;
    private readonly clock: Clock;
    private readonly config: RoomConfig;
    private readonly log: Logger;

    constructor(store: Store, clock: Clock, config: RoomConfig, log: Logger) {
        this.store = store;
        this.clock = clock;
        this.config = config;
        this.log = log;
    }

    createWorld({ name, startMode }: { name: string; startMode: StartMode }): {
        meta: WorldMeta;
        inviteKey: string;
    } {
        const id = randomBytes(8).toString("base64url");
        const inviteKey = randomBytes(16).toString("base64url");
        const params = { seed: randomInt(0, 100000), startLevel: START_LEVELS[startMode] };
        const createdAt = Date.now();
        const cleanName =
            String(name || "")
                .trim()
                .slice(0, 60) || "Tvarovna";
        this.store.createWorld({ id, name: cleanName, inviteKey, params, createdAt });
        this.log.info({ worldId: id, params }, "world created");
        return { meta: { id, name: cleanName, params, createdAt }, inviteKey };
    }

    /** Returns the room of the world, loading it lazily */
    get(worldId: string): Room | null {
        let room = this.rooms.get(worldId);
        if (!room) {
            const world = this.store.getWorld(worldId);
            if (!world) {
                return null;
            }
            room = new Room(this.store, world, this.clock, this.config, this.log);
            this.rooms.set(worldId, room);
        }
        return room;
    }

    /** Unloads rooms without players (called periodically) */
    sweep() {
        for (const [id, room] of this.rooms) {
            if (room.onlineCount === 0) {
                this.rooms.delete(id);
            }
        }
    }

    get loadedCount() {
        return this.rooms.size;
    }

    get onlinePlayers() {
        let count = 0;
        for (const room of this.rooms.values()) {
            count += room.onlineCount;
        }
        return count;
    }

    shutdown() {
        for (const room of this.rooms.values()) {
            room.shutdown();
        }
        this.rooms.clear();
    }
}
