import { randomBytes } from "node:crypto";
import {
    HASH_INTERVAL_TURNS,
    MAX_ACTION_BYTES,
    MAX_CHAT_LENGTH,
    MAX_NAME_LENGTH,
    MAX_PLAYERS_PER_WORLD,
    PLAYER_COLORS,
    PROTOCOL_VERSION,
    TURN_MS,
    isActionType,
    type ClientMessage,
    type PlayerInfo,
    type ServerMessage,
    type TurnAction,
    type TurnRange,
    type WorldMeta,
} from "../../shared/protocol.ts";
import type { Clock } from "./clock.ts";
import type { PlayerRow, Store, WorldRow } from "./db.ts";
import { RateLimiter } from "./rate_limiter.ts";

export interface Logger {
    info(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
}

/** A connected client, the transport is abstracted for tests */
export interface Peer {
    send(message: ServerMessage): void;
    close(code?: number, reason?: string): void;
}

export interface RoomConfig {
    /** Expected build id of clients, empty to accept any build */
    buildId: string;
    password: string;
    snapshotIntervalTurns: number;
}

type HelloMessage = Extract<ClientMessage, { t: "hello" }>;

interface PeerState {
    peer: Peer;
    player: PlayerRow;
    joinedAt: number;
    /** First turn this peer simulates, hashes for earlier turns are not expected */
    syncedFromTurn: number;
    actionLimiter: RateLimiter;
    chatLimiter: RateLimiter;
    cursorLimiter: RateLimiter;
}

/** Persist the turn counter every N turns, see restore() */
const PERSIST_TURN_EVERY = 10;

/**
 * Turns which are skipped after a restart. Clients may have simulated turns
 * after the last persisted counter, those turn numbers must not be reused.
 */
const RESTART_TURN_MARGIN = 5 * PERSIST_TURN_EVERY;

/** Snapshots for a resync are requested this many turns in the future */
const RESYNC_SNAPSHOT_LEAD_TURNS = 10;

/** Give up waiting for a requested snapshot after this many turns */
const SNAPSHOT_REQUEST_TIMEOUT_TURNS = 100;

/** Evaluate hashes at the latest after this many turns */
const HASH_EVALUATION_TIMEOUT_TURNS = 30;

/**
 * One world with its connected players. The server does not simulate the
 * game, it only orders the actions into turns, stores the action log and
 * snapshots and compares the state hashes the clients report.
 */
export class Room {
    readonly world: WorldRow;
    nextTurn: number;

    private pending: TurnAction[] = [];
    private readonly peers = new Map<Peer, PeerState>();
    private players: PlayerRow[];
    private timer: unknown = null;

    /** Highest clientSeq per player, actions resent after a reconnect are dropped */
    private readonly lastClientSeq = new Map<number, number>();

    /** Reported hashes: turn -> playerId -> hash */
    private readonly hashes = new Map<number, Map<number, string>>();

    /** Players waiting for a resync from the snapshot of the given turn */
    private pendingResync: {
        turn: number;
        source: number;
        targets: Set<number>;
        requestedAt: number;
    } | null = null;

    private readonly store: Store;
    private readonly clock: Clock;
    private readonly config: RoomConfig;
    private readonly log: Logger;

    constructor(store: Store, world: WorldRow, clock: Clock, config: RoomConfig, log: Logger) {
        this.store = store;
        this.clock = clock;
        this.config = config;
        this.log = log;
        this.world = world;
        this.players = store.getPlayers(world.id);

        // After a crash, the persisted turn counter may lag behind. Never reuse
        // turn numbers clients might have seen already.
        const lastKnown = Math.max(world.lastTurn, store.getLastLoggedTurn(world.id));
        const margin = world.frozen ? 0 : RESTART_TURN_MARGIN;
        this.nextTurn = lastKnown < 0 ? 0 : lastKnown + 1 + margin;
    }

    get onlineCount() {
        return this.peers.size;
    }

    get isRunning() {
        return this.timer !== null;
    }

    getMeta(): WorldMeta {
        return {
            id: this.world.id,
            name: this.world.name,
            params: this.world.params,
            createdAt: this.world.createdAt,
        };
    }

    /////////////////// CONNECTIONS ///////////////////

    /**
     * Handles the hello message of a new connection. Returns false if the
     * peer was rejected (and closed).
     */
    join(peer: Peer, hello: HelloMessage): boolean {
        const reject = (code: Extract<ServerMessage, { t: "error" }>["code"], message: string) => {
            peer.send({ t: "error", code, message });
            peer.close(4000, code);
            return false;
        };

        if (hello.inviteKey !== this.world.inviteKey) {
            return reject("invalid_invite", "Invalid invite link");
        }
        if (this.config.password && hello.password !== this.config.password) {
            return reject("invalid_password", "Invalid server password");
        }
        if (!this.isClientVersionAccepted(hello.clientVersion)) {
            return reject("version_mismatch", "The game was updated, please reload the page");
        }

        let player = hello.playerToken ? this.players.find(p => p.token === hello.playerToken) : undefined;

        // A player may only be connected once, an old connection is replaced
        for (const [otherPeer, state] of this.peers) {
            if (player && state.player.id === player.id) {
                this.removePeer(otherPeer, "replaced");
                otherPeer.close(4001, "replaced");
            }
        }

        if (this.peers.size >= MAX_PLAYERS_PER_WORLD) {
            return reject("world_full", `The world is full (${MAX_PLAYERS_PER_WORLD} players)`);
        }

        const name = sanitizeName(hello.name);
        if (!player) {
            const id = this.players.reduce((max, p) => Math.max(max, p.id), 0) + 1;
            player = {
                id,
                token: randomBytes(16).toString("base64url"),
                name,
                color: PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length],
            };
            this.players.push(player);
        } else {
            player.name = name;
        }
        this.store.upsertPlayer(this.world.id, player);

        const range = this.getTurnRangeForJoin(hello.resumeFromTurn);
        const state: PeerState = {
            peer,
            player,
            joinedAt: this.clock.now(),
            syncedFromTurn: range.startTurn,
            actionLimiter: new RateLimiter(this.clock, 300, 60),
            chatLimiter: new RateLimiter(this.clock, 5, 1),
            cursorLimiter: new RateLimiter(this.clock, 40, 30),
        };
        this.peers.set(peer, state);

        peer.send({
            t: "welcome",
            playerId: player.id,
            playerToken: player.token,
            color: player.color,
            world: this.getMeta(),
            players: this.getPlayerInfos(),
            leaderId: this.getLeaderId(),
            snapshotIntervalTurns: this.config.snapshotIntervalTurns,
            ...range,
        });

        this.log.info(
            { worldId: this.world.id, playerId: player.id, resumed: range.resumed, turn: this.nextTurn },
            "player joined"
        );
        this.broadcastPlayers();
        this.broadcast({ t: "notice", kind: "playerJoined", playerId: player.id }, peer);

        if (!this.isRunning) {
            this.start();
        }
        return true;
    }

    leave(peer: Peer) {
        const state = this.peers.get(peer);
        if (!state) {
            return;
        }
        this.removePeer(peer, "left");
        this.broadcast({ t: "notice", kind: "playerLeft", playerId: state.player.id });
    }

    private removePeer(peer: Peer, reason: string) {
        const state = this.peers.get(peer);
        if (!state) {
            return;
        }
        this.peers.delete(peer);
        this.log.info({ worldId: this.world.id, playerId: state.player.id, reason }, "player left");

        if (this.peers.size === 0) {
            // Nobody is playing, freeze the world
            this.stop();
        } else {
            this.broadcastPlayers();
        }
    }

    private isClientVersionAccepted(version: unknown): boolean {
        if (typeof version !== "string") {
            return false;
        }
        const [protocol, build] = version.split("/");
        if (Number(protocol) !== PROTOCOL_VERSION) {
            return false;
        }
        return !this.config.buildId || build === this.config.buildId;
    }

    /**
     * Returns what a joining client needs: the latest snapshot and the turns
     * since, or only the missing turns when resuming a session.
     */
    private getTurnRangeForJoin(resumeFromTurn?: number): TurnRange & {
        snapshot: Extract<ServerMessage, { t: "welcome" }>["snapshot"];
        resumed: boolean;
    } {
        const snapshot = this.store.getLatestSnapshot(this.world.id);
        const oldestAvailable = this.getOldestAvailableTurn();

        if (
            typeof resumeFromTurn === "number" &&
            Number.isInteger(resumeFromTurn) &&
            resumeFromTurn >= oldestAvailable &&
            resumeFromTurn <= this.nextTurn
        ) {
            return {
                snapshot: null,
                resumed: true,
                startTurn: resumeFromTurn,
                nextTurn: this.nextTurn,
                turns: this.store.getTurns(this.world.id, resumeFromTurn, this.nextTurn),
            };
        }

        const startTurn = snapshot ? snapshot.turn : 0;
        return {
            snapshot: snapshot ? { turn: snapshot.turn, data: snapshot.data, hash: snapshot.hash } : null,
            resumed: false,
            startTurn,
            nextTurn: this.nextTurn,
            turns: this.store.getTurns(this.world.id, startTurn, this.nextTurn),
        };
    }

    /** The action log is complete from this turn on */
    private getOldestAvailableTurn(): number {
        const rows = this.store.db
            .prepare(`SELECT MIN(turn) AS turn FROM snapshots WHERE world_id = ?`)
            .get(this.world.id) as { turn: number | null };
        return rows.turn === null ? 0 : Number(rows.turn);
    }

    /////////////////// MESSAGES ///////////////////

    handleMessage(peer: Peer, message: ClientMessage, byteLength: number) {
        const state = this.peers.get(peer);
        if (!state) {
            return;
        }

        switch (message.t) {
            case "action":
                this.handleAction(state, message, byteLength);
                break;
            case "hash":
                this.handleHash(state, message.turn, message.hash);
                break;
            case "snapshot":
                this.handleSnapshot(state, message.turn, message.data, message.hash);
                break;
            case "cursor":
                if (state.cursorLimiter.take()) {
                    this.broadcast(
                        {
                            t: "cursor",
                            playerId: state.player.id,
                            x: Number(message.x) || 0,
                            y: Number(message.y) || 0,
                            layer: message.layer === "wires" ? "wires" : "regular",
                        },
                        peer
                    );
                }
                break;
            case "chat": {
                const text = String(message.text ?? "")
                    .trim()
                    .slice(0, MAX_CHAT_LENGTH);
                if (text && state.chatLimiter.take()) {
                    this.broadcast({ t: "chat", playerId: state.player.id, text, time: Date.now() });
                }
                break;
            }
            case "ping":
                peer.send({ t: "pong", time: message.time, serverTurn: this.nextTurn });
                break;
            case "hello":
                // Already joined
                break;
            default:
                peer.send({ t: "error", code: "bad_request", message: "Unknown message" });
        }
    }

    private handleAction(
        state: PeerState,
        message: Extract<ClientMessage, { t: "action" }>,
        byteLength: number
    ) {
        if (!isActionType(message.type) || typeof message.payload !== "object" || message.payload === null) {
            state.peer.send({ t: "error", code: "bad_request", message: "Invalid action" });
            return;
        }
        if (byteLength > MAX_ACTION_BYTES) {
            state.peer.send({ t: "error", code: "message_too_large", message: "Action too large" });
            return;
        }
        const clientSeq = Number(message.clientSeq) || 0;
        if (clientSeq <= (this.lastClientSeq.get(state.player.id) ?? -1)) {
            // Already received (resent after a reconnect)
            return;
        }
        if (!state.actionLimiter.take()) {
            state.peer.send({ t: "error", code: "rate_limited", message: "Too many actions" });
            return;
        }
        this.lastClientSeq.set(state.player.id, clientSeq);
        this.pending.push({
            playerId: state.player.id,
            clientSeq,
            type: message.type,
            payload: message.payload,
        } as TurnAction);
    }

    /////////////////// TURNS ///////////////////

    private start() {
        this.log.info({ worldId: this.world.id, turn: this.nextTurn }, "world started");
        this.store.setRunning(this.world.id);
        this.timer = this.clock.setInterval(() => this.closeTurn(), TURN_MS);
    }

    private stop() {
        if (this.timer !== null) {
            this.clock.clearInterval(this.timer);
            this.timer = null;
        }
        this.pending = [];
        this.store.freeze(this.world.id, this.nextTurn - 1);
        this.log.info({ worldId: this.world.id, turn: this.nextTurn }, "world frozen");
    }

    /**
     * Closes the current turn and sends it to everyone
     */
    closeTurn() {
        const n = this.nextTurn++;
        const actions = this.pending;
        this.pending = [];

        // Persist before broadcasting, so a joining client always gets a consistent log
        this.store.appendTurn(this.world.id, n, actions);
        if (n % PERSIST_TURN_EVERY === 0) {
            this.store.setLastTurn(this.world.id, n);
        }

        this.broadcast({ t: "turn", n, actions });
        this.checkTimeouts();
    }

    /////////////////// HASHES & SNAPSHOTS ///////////////////

    private handleHash(state: PeerState, turn: number, hash: string) {
        if (!Number.isInteger(turn) || turn % HASH_INTERVAL_TURNS !== 0 || turn >= this.nextTurn) {
            return;
        }
        if (turn < state.syncedFromTurn || typeof hash !== "string") {
            return;
        }
        let reports = this.hashes.get(turn);
        if (!reports) {
            reports = new Map();
            this.hashes.set(turn, reports);
        }
        reports.set(state.player.id, hash);

        const expected = [...this.peers.values()].filter(p => p.syncedFromTurn <= turn).length;
        if (reports.size >= expected) {
            this.evaluateHashes(turn);
        }
    }

    private evaluateHashes(turn: number) {
        const reports = this.hashes.get(turn);
        this.hashes.delete(turn);
        if (!reports || reports.size < 2) {
            return;
        }

        const groups = new Map<string, number[]>();
        for (const [playerId, hash] of reports) {
            groups.set(hash, [...(groups.get(hash) ?? []), playerId]);
        }
        if (groups.size === 1) {
            return;
        }

        // Majority wins, ties are resolved in favor of the leader
        const leaderId = this.getLeaderId();
        const sorted = [...groups.entries()].sort(
            ([, a], [, b]) =>
                b.length - a.length || Number(b.includes(leaderId)) - Number(a.includes(leaderId))
        );
        const [majorityHash, majority] = sorted[0];
        const desynced = sorted.slice(1).flatMap(([, ids]) => ids);

        this.log.warn(
            {
                worldId: this.world.id,
                turn,
                majorityHash,
                hashes: Object.fromEntries(reports),
                desynced,
                recentActions: this.store
                    .getTurns(this.world.id, Math.max(0, turn - HASH_INTERVAL_TURNS), turn)
                    .flatMap(t => t.actions.map(a => `${t.n}:${a.type}`)),
            },
            "desync detected"
        );

        const source = majority.includes(leaderId) ? leaderId : majority[0];
        this.requestResync(source, desynced);
    }

    private requestResync(source: number, targets: number[]) {
        const sourcePeer = this.findPeer(source);
        if (!sourcePeer) {
            return;
        }
        if (this.pendingResync) {
            for (const target of targets) {
                this.pendingResync.targets.add(target);
            }
            return;
        }
        const turn = this.nextTurn + RESYNC_SNAPSHOT_LEAD_TURNS;
        this.pendingResync = { turn, source, targets: new Set(targets), requestedAt: this.nextTurn };
        for (const target of targets) {
            this.findPeer(target)?.send({ t: "notice", kind: "desync", playerId: target });
        }
        sourcePeer.send({ t: "requestSnapshot", turn });
    }

    private handleSnapshot(state: PeerState, turn: number, data: Uint8Array, hash: string) {
        if (!Number.isInteger(turn) || turn >= this.nextTurn || !(data instanceof Uint8Array)) {
            return;
        }

        const resync = this.pendingResync;
        const isRequested = resync && resync.source === state.player.id && turn >= resync.turn;
        const isLeader = state.player.id === this.getLeaderId();
        const leaderDesynced = resync?.targets.has(state.player.id) ?? false;
        if (!isRequested && (!isLeader || leaderDesynced)) {
            return;
        }

        const latest = this.store.getLatestSnapshot(this.world.id);
        if (!latest || turn > latest.turn) {
            this.store.saveSnapshot(this.world.id, { turn, data, hash: String(hash) });
            this.log.info({ worldId: this.world.id, turn, bytes: data.byteLength }, "snapshot stored");
        }

        if (isRequested) {
            this.pendingResync = null;
            const range: TurnRange = {
                startTurn: turn,
                nextTurn: this.nextTurn,
                turns: this.store.getTurns(this.world.id, turn, this.nextTurn),
            };
            for (const target of resync.targets) {
                const targetState = this.findPeerState(target);
                if (targetState) {
                    targetState.syncedFromTurn = turn;
                    targetState.peer.send({ t: "resync", snapshot: { turn, data, hash }, ...range });
                }
            }
        }
    }

    private checkTimeouts() {
        // Evaluate hashes of players who never reported
        for (const turn of this.hashes.keys()) {
            if (this.nextTurn - turn > HASH_EVALUATION_TIMEOUT_TURNS) {
                this.evaluateHashes(turn);
            }
        }

        // Retry snapshot requests which were not answered
        const resync = this.pendingResync;
        if (resync && this.nextTurn - resync.requestedAt > SNAPSHOT_REQUEST_TIMEOUT_TURNS) {
            this.pendingResync = null;
            const candidates = [...this.peers.values()]
                .map(s => s.player.id)
                .filter(id => !resync.targets.has(id) && id !== resync.source);
            if (candidates.length > 0) {
                this.requestResync(candidates[0], [...resync.targets]);
            }
        }
    }

    /////////////////// HELPERS ///////////////////

    /** The leader uploads snapshots: the player connected the longest */
    getLeaderId(): number {
        let leader: PeerState | null = null;
        for (const state of this.peers.values()) {
            if (!leader || state.joinedAt < leader.joinedAt) {
                leader = state;
            }
        }
        return leader ? leader.player.id : 0;
    }

    private findPeerState(playerId: number) {
        for (const state of this.peers.values()) {
            if (state.player.id === playerId) {
                return state;
            }
        }
        return null;
    }

    private findPeer(playerId: number) {
        return this.findPeerState(playerId)?.peer ?? null;
    }

    private getPlayerInfos(): PlayerInfo[] {
        const online = new Set([...this.peers.values()].map(s => s.player.id));
        return this.players.map(p => ({ id: p.id, name: p.name, color: p.color, online: online.has(p.id) }));
    }

    private broadcastPlayers() {
        this.broadcast({ t: "players", list: this.getPlayerInfos(), leaderId: this.getLeaderId() });
    }

    private broadcast(message: ServerMessage, except: Peer | null = null) {
        for (const peer of this.peers.keys()) {
            if (peer !== except) {
                peer.send(message);
            }
        }
    }

    /** Stops the room (server shutdown) */
    shutdown() {
        if (this.isRunning) {
            this.stop();
        }
        for (const peer of this.peers.keys()) {
            peer.close(1001, "server shutdown");
        }
        this.peers.clear();
    }
}

function sanitizeName(name: unknown): string {
    const clean = String(name ?? "")
        .replace(/[\u0000-\u001f<>]/g, "")
        .trim()
        .slice(0, MAX_NAME_LENGTH);
    return clean || "Player";
}
