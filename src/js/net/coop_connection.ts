import { PROTOCOL_VERSION, type ServerMessage, type Turn, type TurnRange } from "../../../shared/protocol";
import type { Application } from "../application";
import { Logger } from "../core/logging";
import { Signal } from "../core/signal";
import { enterCoopGame } from "./coop_game";
import { CoopSession } from "./coop_session";
import { NetClient } from "./net_client";
import { NetTransport } from "./net_transport";
import { decodeSnapshot } from "./snapshot_codec";
import { rememberWorld } from "./coop_storage";
import { getInviteLink } from "./invite";

const logger = new Logger("coop/connection");

export type CoopConnectionStatus = "connecting" | "loading" | "playing" | "reconnecting" | "error" | "closed";

export interface CoopJoinOptions {
    worldId: string;
    inviteKey: string;
    name: string;
    password?: string;
    serverUrl?: string;
}

export function getClientVersion() {
    return `${PROTOCOL_VERSION}/${G_BUILD_COMMIT_HASH}`;
}

function tokenStorageKey(worldId: string) {
    return "tvarovna.token." + worldId;
}

function readToken(worldId: string): string | undefined {
    try {
        return localStorage.getItem(tokenStorageKey(worldId)) ?? undefined;
    } catch {
        return undefined;
    }
}

function writeToken(worldId: string, token: string) {
    try {
        localStorage.setItem(tokenStorageKey(worldId), token);
    } catch {
        // Private mode, the player gets a new identity next time
    }
}

/**
 * Connection to a co-op world. Joins the world, creates the game sessions
 * (again after a resync), feeds them with turns and keeps the connection
 * alive across network hiccups.
 */
export class CoopConnection {
    static current: CoopConnection | null = null;

    readonly app: Application;
    readonly options: CoopJoinOptions;
    readonly client: NetClient;
    readonly transport: NetTransport;

    session: CoopSession | null = null;
    playerId = 0;
    status: CoopConnectionStatus = "connecting";

    /** Turns which arrived while a snapshot was being decoded */
    private bufferedTurns: Turn[] = [];
    private loading = false;

    /** Set while the game state is restarted, so leaving it does not disconnect */
    private restarting = false;

    readonly signals = {
        statusChanged: new Signal<[CoopConnectionStatus, string]>(),
        error: new Signal<[string, string]>(),
    };

    constructor(app: Application, options: CoopJoinOptions) {
        this.app = app;
        this.options = options;
        this.client = new NetClient(options.serverUrl ?? NetClient.getDefaultUrl());
        this.transport = new NetTransport(this.client);

        this.client.signals.open.add(this.onOpen, this);
        this.client.signals.message.add(this.onMessage, this);
        this.client.signals.disconnected.add(this.onDisconnected, this);
        this.client.signals.closed.add(this.onClosed, this);
    }

    start() {
        CoopConnection.current?.close();
        CoopConnection.current = this;
        this.setStatus("connecting");
        this.client.connect();
    }

    close() {
        this.setStatus("closed");
        this.client.close();
        if (CoopConnection.current === this) {
            CoopConnection.current = null;
        }
    }

    private setStatus(status: CoopConnectionStatus, detail = "") {
        this.status = status;
        this.signals.statusChanged.dispatch(status, detail);
        this.session?.signals.connectionChanged.dispatch(status === "playing");
    }

    private onOpen() {
        const resumeFromTurn =
            this.session && !this.loading ? this.session.lockstep.latestTurn + 1 : undefined;
        this.client.send({
            t: "hello",
            worldId: this.options.worldId,
            inviteKey: this.options.inviteKey,
            name: this.options.name,
            clientVersion: getClientVersion(),
            playerToken: readToken(this.options.worldId),
            resumeFromTurn,
            password: this.options.password,
        });
    }

    private onDisconnected() {
        this.setStatus("reconnecting");
    }

    private onClosed(code: number, reason: string) {
        if (this.status !== "closed" && this.status !== "error") {
            this.setStatus("error", reason || "Connection closed (" + code + ")");
        }
    }

    private onMessage(message: ServerMessage) {
        switch (message.t) {
            case "welcome":
                void this.onWelcome(message);
                break;
            case "turn":
                if (this.loading || !this.session) {
                    this.bufferedTurns.push({ n: message.n, actions: message.actions });
                } else {
                    this.receiveTurn(message);
                }
                break;
            case "resync":
                logger.warn("Resync from the snapshot of turn", message.snapshot.turn);
                void this.loadWorld(message.snapshot.data, message);
                break;
            case "requestSnapshot":
                this.transport.requestedSnapshotTurn = message.turn;
                break;
            case "players":
                this.transport.isLeader = message.leaderId === this.playerId;
                this.session?.setPlayers(message.list);
                break;
            case "chat":
                this.session?.signals.chat.dispatch(message.playerId, message.text);
                break;
            case "cursor":
                this.session?.signals.cursor.dispatch(message.playerId, message.x, message.y, message.layer);
                break;
            case "notice":
                this.session?.signals.notice.dispatch(
                    message.kind,
                    String(message.playerId ?? message.text ?? "")
                );
                break;
            case "error":
                logger.warn("Server error:", message.code, message.message);
                if (message.code !== "rate_limited" && message.code !== "bad_request") {
                    this.setStatus("error", message.code);
                    this.signals.error.dispatch(message.code, message.message);
                    this.session?.signals.fatalError.dispatch(message.code);
                }
                break;
            case "pong":
                break;
        }
    }

    private async onWelcome(message: Extract<ServerMessage, { t: "welcome" }>) {
        this.playerId = message.playerId;
        this.transport.isLeader = message.leaderId === message.playerId;
        this.transport.snapshotIntervalTurns = message.snapshotIntervalTurns;
        writeToken(message.world.id, message.playerToken);
        rememberWorld({
            id: message.world.id,
            key: this.options.inviteKey,
            name: message.world.name,
            lastPlayed: Date.now(),
        });

        if (message.resumed && this.session) {
            // Back after a network hiccup, only the missing turns are sent
            logger.log("Session resumed at turn", message.startTurn);
            this.session.receiveTurnRange(message);
            this.flushBufferedTurns();
            this.session.setPlayers(message.players);
            this.session.resendPendingActions();
            this.setStatus("playing");
            return;
        }

        await this.loadWorld(message.snapshot ? message.snapshot.data : null, message, message);
    }

    /**
     * Creates a new game session from a snapshot (or a fresh world) and enters it
     */
    private async loadWorld(
        snapshotData: Uint8Array | null,
        range: TurnRange,
        welcome: Extract<ServerMessage, { t: "welcome" }> | null = null
    ) {
        this.setStatus("loading");
        this.loading = true;
        this.bufferedTurns = [];

        try {
            const snapshot = snapshotData ? await decodeSnapshot(snapshotData) : null;
            const previous = this.session;
            const session = new CoopSession({
                playerId: this.playerId,
                transport: this.transport,
                world: welcome ? welcome.world.params : previous.world,
                worldName: welcome ? welcome.world.name : previous.worldName,
                snapshot,
                startTurn: range.startTurn,
                turns: [],
                players: welcome ? welcome.players : previous?.players,
                inviteLink: getInviteLink(this.options.worldId, this.options.inviteKey),
            });
            session.receiveTurnRange(range);
            session.onLeave = () => {
                if (!this.restarting) {
                    this.close();
                }
            };

            this.session = session;
            this.loading = false;
            this.flushBufferedTurns();

            // Leaving the running game must not close the connection
            this.restarting = true;
            try {
                enterCoopGame(this.app, session);
            } finally {
                this.restarting = false;
            }
            this.setStatus("playing");
        } catch (err) {
            logger.error("Failed to load the world", err);
            this.loading = false;
            this.setStatus("error", "load_failed");
            this.signals.error.dispatch("load_failed", String(err));
        }
    }

    private flushBufferedTurns() {
        const turns = this.bufferedTurns;
        this.bufferedTurns = [];
        for (const turn of turns) {
            this.receiveTurn(turn);
        }
    }

    private receiveTurn(turn: Turn) {
        try {
            this.session.receiveTurn(turn);
        } catch (err) {
            // A turn got lost, reconnecting resumes from the last known turn
            logger.error("Turn gap, reconnecting", err);
            this.client.reconnect();
        }
    }
}
