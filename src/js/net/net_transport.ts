import { SNAPSHOT_INTERVAL_TURNS, type Action } from "../../../shared/protocol";
import { Logger } from "../core/logging";
import type { CoopTransport } from "./coop_session";
import type { NetClient } from "./net_client";
import type { CoopSnapshot } from "./snapshot";
import { encodeSnapshot } from "./snapshot_codec";

const logger = new Logger("coop/transport");

/**
 * Transport of a co-op session over the network
 */
export class NetTransport implements CoopTransport {
    readonly client: NetClient;

    /** Whether this client uploads the periodic snapshots */
    isLeader = false;

    /** The leader uploads a snapshot every N turns (configured by the server) */
    snapshotIntervalTurns = SNAPSHOT_INTERVAL_TURNS;

    /** Turn of a snapshot the server asked for */
    requestedSnapshotTurn: number | null = null;

    constructor(client: NetClient) {
        this.client = client;
    }

    sendAction(action: Action & { clientSeq: number }) {
        this.client.send({ t: "action", ...action });
    }

    sendHash(turn: number, hash: string) {
        this.client.send({ t: "hash", turn, hash });
    }

    wantsSnapshotAt(turn: number): boolean {
        if (this.requestedSnapshotTurn !== null && turn >= this.requestedSnapshotTurn) {
            return true;
        }
        return this.isLeader && turn > 0 && turn % this.snapshotIntervalTurns === 0;
    }

    sendSnapshot(turn: number, snapshot: CoopSnapshot, hash: string) {
        this.requestedSnapshotTurn = null;
        const start = performance.now();
        encodeSnapshot(snapshot).then(
            data => {
                logger.log(
                    "Uploading snapshot of turn",
                    turn,
                    data.byteLength,
                    "bytes",
                    "after",
                    Math.round(performance.now() - start),
                    "ms"
                );
                this.client.send({ t: "snapshot", turn, data, hash });
            },
            err => logger.error("Failed to encode snapshot", err)
        );
    }

    sendCursor(x: number, y: number, layer: string) {
        this.client.send({ t: "cursor", x, y, layer });
    }

    sendChat(text: string) {
        this.client.send({ t: "chat", text });
    }
}
