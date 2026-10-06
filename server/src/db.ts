import { DatabaseSync } from "node:sqlite";
import type { TurnAction, WorldParams } from "../../shared/protocol.ts";

export interface WorldRow {
    id: string;
    name: string;
    inviteKey: string;
    params: WorldParams;
    createdAt: number;
    /** Highest turn which was closed (persisted lazily while running, see Room) */
    lastTurn: number;
    /** Whether the world was stopped cleanly, so lastTurn is exact */
    frozen: boolean;
}

export interface SnapshotRow {
    turn: number;
    data: Uint8Array;
    hash: string;
    createdAt: number;
}

export interface PlayerRow {
    id: number;
    token: string;
    name: string;
    color: string;
}

/** How many snapshots to keep per world */
const SNAPSHOTS_TO_KEEP = 3;

/**
 * Persistence of worlds, snapshots and the action log in a single SQLite file
 */
export class Store {
    readonly db: DatabaseSync;

    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS worlds (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                invite_key TEXT NOT NULL,
                seed INTEGER NOT NULL,
                start_level INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                last_turn INTEGER NOT NULL DEFAULT -1,
                -- 1 when the world was stopped cleanly and last_turn is exact
                frozen INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS snapshots (
                world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
                turn INTEGER NOT NULL,
                data BLOB NOT NULL,
                hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (world_id, turn)
            );

            CREATE TABLE IF NOT EXISTS action_log (
                world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
                turn INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                player_id INTEGER NOT NULL,
                client_seq INTEGER NOT NULL,
                type TEXT NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (world_id, turn, seq)
            );

            CREATE TABLE IF NOT EXISTS players (
                world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
                id INTEGER NOT NULL,
                token TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                PRIMARY KEY (world_id, id)
            );
        `);
    }

    close() {
        this.db.close();
    }

    createWorld(world: Omit<WorldRow, "lastTurn" | "frozen">) {
        this.db
            .prepare(
                `INSERT INTO worlds (id, name, invite_key, seed, start_level, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(
                world.id,
                world.name,
                world.inviteKey,
                world.params.seed,
                world.params.startLevel,
                world.createdAt
            );
    }

    getWorld(id: string): WorldRow | null {
        const row = this.db.prepare(`SELECT * FROM worlds WHERE id = ?`).get(id) as
            | Record<string, unknown>
            | undefined;
        if (!row) {
            return null;
        }
        return {
            id: row.id as string,
            name: row.name as string,
            inviteKey: row.invite_key as string,
            params: { seed: Number(row.seed), startLevel: Number(row.start_level) },
            createdAt: Number(row.created_at),
            lastTurn: Number(row.last_turn),
            frozen: Number(row.frozen) === 1,
        };
    }

    countWorlds(): number {
        return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM worlds`).get() as { n: number }).n);
    }

    setRunning(worldId: string) {
        this.db.prepare(`UPDATE worlds SET frozen = 0 WHERE id = ?`).run(worldId);
    }

    freeze(worldId: string, lastTurn: number) {
        this.db.prepare(`UPDATE worlds SET frozen = 1, last_turn = ? WHERE id = ?`).run(lastTurn, worldId);
    }

    setLastTurn(worldId: string, turn: number) {
        this.db.prepare(`UPDATE worlds SET last_turn = MAX(last_turn, ?) WHERE id = ?`).run(turn, worldId);
    }

    /** Highest turn which has logged actions */
    getLastLoggedTurn(worldId: string): number {
        const row = this.db
            .prepare(`SELECT MAX(turn) AS turn FROM action_log WHERE world_id = ?`)
            .get(worldId) as {
            turn: number | null;
        };
        return row.turn === null ? -1 : Number(row.turn);
    }

    appendTurn(worldId: string, turn: number, actions: TurnAction[]) {
        if (actions.length === 0) {
            return;
        }
        const insert = this.db.prepare(
            `INSERT INTO action_log (world_id, turn, seq, player_id, client_seq, type, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        this.db.exec("BEGIN");
        try {
            actions.forEach((action, seq) => {
                insert.run(
                    worldId,
                    turn,
                    seq,
                    action.playerId,
                    action.clientSeq,
                    action.type,
                    JSON.stringify(action.payload)
                );
            });
            this.db.exec("COMMIT");
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }

    /** Returns all turns with actions in [fromTurn, toTurn) */
    getTurns(worldId: string, fromTurn: number, toTurn: number): Array<{ n: number; actions: TurnAction[] }> {
        const rows = this.db
            .prepare(
                `SELECT turn, player_id, client_seq, type, payload FROM action_log
                 WHERE world_id = ? AND turn >= ? AND turn < ? ORDER BY turn, seq`
            )
            .all(worldId, fromTurn, toTurn) as Array<Record<string, unknown>>;

        const turns: Array<{ n: number; actions: TurnAction[] }> = [];
        for (const row of rows) {
            const n = Number(row.turn);
            let turn = turns[turns.length - 1];
            if (!turn || turn.n !== n) {
                turn = { n, actions: [] };
                turns.push(turn);
            }
            turn.actions.push({
                playerId: Number(row.player_id),
                clientSeq: Number(row.client_seq),
                type: row.type,
                payload: JSON.parse(row.payload as string),
            } as TurnAction);
        }
        return turns;
    }

    saveSnapshot(worldId: string, snapshot: Omit<SnapshotRow, "createdAt">) {
        this.db.exec("BEGIN");
        try {
            this.db
                .prepare(
                    `INSERT OR REPLACE INTO snapshots (world_id, turn, data, hash, created_at) VALUES (?, ?, ?, ?, ?)`
                )
                .run(worldId, snapshot.turn, snapshot.data, snapshot.hash, Date.now());

            // Keep only the newest snapshots, and the actions after the oldest one
            const kept = this.db
                .prepare(`SELECT turn FROM snapshots WHERE world_id = ? ORDER BY turn DESC LIMIT ?`)
                .all(worldId, SNAPSHOTS_TO_KEEP) as Array<{ turn: number }>;
            const oldestKept = Number(kept[kept.length - 1].turn);
            this.db.prepare(`DELETE FROM snapshots WHERE world_id = ? AND turn < ?`).run(worldId, oldestKept);
            this.db
                .prepare(`DELETE FROM action_log WHERE world_id = ? AND turn < ?`)
                .run(worldId, oldestKept);
            this.db.exec("COMMIT");
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }

    getLatestSnapshot(worldId: string): SnapshotRow | null {
        const row = this.db
            .prepare(`SELECT * FROM snapshots WHERE world_id = ? ORDER BY turn DESC LIMIT 1`)
            .get(worldId) as Record<string, unknown> | undefined;
        if (!row) {
            return null;
        }
        return {
            turn: Number(row.turn),
            data: new Uint8Array(row.data as Uint8Array),
            hash: row.hash as string,
            createdAt: Number(row.created_at),
        };
    }

    getPlayers(worldId: string): PlayerRow[] {
        return (
            this.db
                .prepare(`SELECT id, token, name, color FROM players WHERE world_id = ? ORDER BY id`)
                .all(worldId) as Array<Record<string, unknown>>
        ).map(row => ({
            id: Number(row.id),
            token: row.token as string,
            name: row.name as string,
            color: row.color as string,
        }));
    }

    upsertPlayer(worldId: string, player: PlayerRow) {
        this.db
            .prepare(
                `INSERT INTO players (world_id, id, token, name, color) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (world_id, id) DO UPDATE SET name = excluded.name`
            )
            .run(worldId, player.id, player.token, player.name, player.color);
    }

    /** Creates a consistent copy of the database, used for backups */
    backup(targetPath: string) {
        this.db.prepare(`VACUUM INTO ?`).run(targetPath);
    }
}
