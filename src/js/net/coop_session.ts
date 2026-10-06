import {
    HASH_INTERVAL_TURNS,
    TICKS_PER_TURN,
    type Action,
    type BlueprintEntityData,
    type PlayerInfo,
    type Turn,
    type TurnAction,
    type WorldParams,
} from "../../../shared/protocol";
import { Logger } from "../core/logging";
import { Signal } from "../core/signal";
import { Vector } from "../core/vector";
import { globalConfig } from "../core/config";
import type { Entity } from "../game/entity";
import type { GameRoot } from "../game/root";
import { applyAction, serializeEntityData } from "./actions";
import { Lockstep } from "./lockstep";
import { applySnapshotExtras, createSnapshot, type CoopSnapshot } from "./snapshot";
import { computeStateHash } from "./state_hash";

const logger = new Logger("coop/session");

/** Maximum wall time spent on catch-up ticks per frame */
const CATCHUP_FRAME_BUDGET_MS = 25;

const MAX_UNDO_STEPS = 100;

/**
 * Connection between the session and the outside world (server or a local
 * stand-in for offline play and tests)
 */
export interface CoopTransport {
    sendAction(action: Action & { clientSeq: number }): void;
    sendHash(turn: number, hash: string): void;
    /** Called at every turn boundary, return true to upload a snapshot of this turn */
    wantsSnapshotAt(turn: number): boolean;
    sendSnapshot(turn: number, snapshot: CoopSnapshot, hash: string): void;
    /** Local transports can provide turns on demand */
    pollTurn?(n: number): TurnAction[] | null;
    sendCursor?(x: number, y: number, layer: string): void;
    sendChat?(text: string): void;
    /** Called when the game was left */
    close?(): void;
}

export interface CoopSessionOptions {
    playerId: number;
    transport: CoopTransport;
    world: WorldParams;
    worldName?: string;
    /** Snapshot to restore, or null to create a fresh world */
    snapshot: CoopSnapshot | null;
    /** First turn to simulate (the turn of the snapshot, or 0) */
    startTurn: number;
    /** Turns which were already played since the snapshot */
    turns: Turn[];
    players?: PlayerInfo[];
}

interface UndoStep {
    added: number[];
    removed: BlueprintEntityData[];
}

/**
 * Drives a co-op game: collects turns, applies actions at turn boundaries,
 * simulates ticks in lockstep and reports state hashes.
 */
export class CoopSession {
    readonly playerId: number;
    readonly transport: CoopTransport;
    readonly world: WorldParams;
    readonly worldName: string;
    readonly lockstep: Lockstep;

    root: GameRoot = null;

    /** Snapshot to restore once the game was loaded */
    private pendingSnapshot: CoopSnapshot | null;

    /** The action currently being applied, so listeners can read its flags */
    currentAction: TurnAction | null = null;

    /** Entities may only be added / removed by actions and the simulation */
    mutationsAllowed = true;

    private clientSeq = 0;

    /** Own actions which were sent but not applied yet */
    readonly pendingActions: Array<Action & { clientSeq: number }> = [];

    private undoStack: UndoStep[] = [];
    private recording: UndoStep | null = null;

    /** When set, ticks are only simulated through runTicks (tests) */
    manualTicking = false;

    players: PlayerInfo[];
    lastHash: { turn: number; hash: string } | null = null;

    readonly signals = {
        turnApplied: new Signal<[number]>(),
        actionApplied: new Signal<[TurnAction, boolean]>(),
        playersChanged: new Signal<[PlayerInfo[]]>(),
        cursor: new Signal<[number, number, number, string]>(),
        chat: new Signal<[number, string]>(),
        notice: new Signal<[string, string]>(),
        connectionChanged: new Signal<[boolean]>(),
    };

    constructor(options: CoopSessionOptions) {
        this.playerId = options.playerId;
        this.transport = options.transport;
        this.world = options.world;
        this.worldName = options.worldName ?? "";
        this.pendingSnapshot = options.snapshot;
        this.players = options.players ?? [];
        this.lockstep = new Lockstep(options.startTurn);
        for (const turn of options.turns) {
            this.lockstep.addTurn(turn.n, turn.actions);
        }
    }

    get hasSnapshot() {
        return this.pendingSnapshot !== null;
    }

    getSnapshotDump() {
        return this.pendingSnapshot?.dump ?? null;
    }

    /**
     * Called when the game root was created
     */
    attach(root: GameRoot) {
        this.root = root;
        this.mutationsAllowed = true;

        root.signals.entityAdded.add(this.onEntityAdded, this);
        root.signals.entityQueuedForDestroy.add(this.onEntityQueuedForDestroy, this);
    }

    /**
     * Called after the game was created or restored and the post load hook ran
     */
    onGameLoaded() {
        if (this.pendingSnapshot) {
            applySnapshotExtras(this.root, this.pendingSnapshot.extras);
            this.pendingSnapshot = null;

            // The camera is part of the savegame, but should not be shared
            this.root.camera.center = new Vector(-5, 2).multiplyScalar(globalConfig.tileSize);
        }
        this.mutationsAllowed = false;
        logger.log("Co-op game ready at turn", this.lockstep.nextTurn);
    }

    /**
     * Receives a turn from the server
     */
    receiveTurn(turn: Turn) {
        this.lockstep.addTurn(turn.n, turn.actions);
        for (const action of turn.actions) {
            if (action.playerId === this.playerId) {
                const index = this.pendingActions.findIndex(a => a.clientSeq === action.clientSeq);
                if (index >= 0) {
                    this.pendingActions.splice(index, 1);
                }
            }
        }
    }

    /**
     * Sends an action to all players. It gets applied once the server
     * included it in a turn.
     */
    dispatch(action: Action) {
        const message = { ...action, clientSeq: ++this.clientSeq } as Action & { clientSeq: number };
        this.pendingActions.push(message);
        this.transport.sendAction(message);
    }

    /** Whether the local player already requested to delete this entity */
    isDeletePending(uid: number): boolean {
        return this.pendingActions.some(
            action => action.type === "deleteBuildings" && action.payload.uids.includes(uid)
        );
    }

    /**
     * Reverts the last building change of the local player
     */
    undo(): boolean {
        const step = this.undoStack.pop();
        if (!step) {
            return false;
        }
        if (step.added.length > 0) {
            this.dispatch({ type: "deleteBuildings", payload: { uids: step.added, undo: true } });
        }
        if (step.removed.length > 0) {
            this.dispatch({ type: "restoreBuildings", payload: { entities: step.removed } });
        }
        return true;
    }

    /**
     * Called once per frame instead of GameTime.performTicks
     * @returns false if the game stopped
     */
    performFrame(deltaMs: number, updateMethod: () => boolean): boolean {
        if (this.manualTicking) {
            return true;
        }
        this.pollLocalTurns();

        const plan = this.lockstep.planTicks(deltaMs);
        for (let i = 0; i < plan.regular; ++i) {
            if (!this.step(updateMethod)) {
                return false;
            }
        }

        if (plan.catchUp > 0) {
            const start = performance.now();
            for (let i = 0; i < plan.catchUp; ++i) {
                if (!this.step(updateMethod)) {
                    return false;
                }
                if (performance.now() - start > CATCHUP_FRAME_BUDGET_MS) {
                    break;
                }
            }
        }
        return true;
    }

    /**
     * Simulates the given amount of ticks synchronously (tests, catching up)
     */
    runTicks(count: number, updateMethod: () => boolean): number {
        let done = 0;
        while (done < count) {
            this.pollLocalTurns();
            if (this.lockstep.getAvailableTicks() === 0) {
                break;
            }
            if (!this.step(updateMethod)) {
                break;
            }
            done++;
        }
        return done;
    }

    private pollLocalTurns() {
        if (!this.transport.pollTurn) {
            return;
        }
        // Local transports provide one turn ahead of the simulation
        while (this.lockstep.latestTurn < this.lockstep.nextTurn) {
            const n = this.lockstep.latestTurn + 1;
            const actions = this.transport.pollTurn(n);
            if (!actions) {
                break;
            }
            this.receiveTurn({ n, actions });
        }
    }

    /**
     * Simulates one tick, starting a new turn if required
     */
    private step(updateMethod: () => boolean): boolean {
        const lockstep = this.lockstep;
        if (lockstep.getAvailableTicks() === 0) {
            return true;
        }

        if (lockstep.isAtTurnBoundary) {
            this.onTurnBoundary(lockstep.nextTurn);
            const actions = lockstep.beginTurn();
            this.applyTurnActions(actions);
        }

        this.mutationsAllowed = true;
        const result = updateMethod();
        this.mutationsAllowed = false;
        if (!result) {
            return false;
        }

        const root = this.root;
        root.time.timeSeconds += root.dynamicTickrate.deltaSeconds;
        root.productionAnalytics.update();

        const finishedTurn = lockstep.nextTurn;
        lockstep.onTickDone();
        if (lockstep.isAtTurnBoundary) {
            this.signals.turnApplied.dispatch(finishedTurn);
        }
        return true;
    }

    private applyTurnActions(actions: TurnAction[]) {
        this.mutationsAllowed = true;
        for (const action of actions) {
            const isLocal = action.playerId === this.playerId;
            this.currentAction = action;
            this.recording = isLocal ? { added: [], removed: [] } : null;

            const changed = applyAction(this.root, action);

            if (this.recording && (this.recording.added.length > 0 || this.recording.removed.length > 0)) {
                // Undo steps are not recorded for undo itself
                if (action.type !== "restoreBuildings" && !this.isUndoDelete(action)) {
                    this.undoStack.push(this.recording);
                    if (this.undoStack.length > MAX_UNDO_STEPS) {
                        this.undoStack.shift();
                    }
                }
            }
            this.recording = null;
            this.currentAction = null;
            this.signals.actionApplied.dispatch(action, changed);
        }
        this.mutationsAllowed = false;
    }

    private isUndoDelete(action: TurnAction) {
        return action.type === "deleteBuildings" && action.payload.undo === true;
    }

    private onEntityAdded(entity: Entity) {
        this.assertMutationAllowed("add", entity);
        if (this.recording) {
            this.recording.added.push(entity.uid);
        }
    }

    private onEntityQueuedForDestroy(entity: Entity) {
        this.assertMutationAllowed("destroy", entity);
        if (this.recording && entity.components.StaticMapEntity) {
            const index = this.recording.added.indexOf(entity.uid);
            if (index >= 0) {
                this.recording.added.splice(index, 1);
            } else {
                this.recording.removed.push(serializeEntityData(entity));
            }
        }
    }

    private assertMutationAllowed(kind: string, entity: Entity) {
        if (G_IS_DEV && !this.mutationsAllowed) {
            const message = `COOP: Entity ${kind} outside of applyAction / simulation (uid ${entity.uid})`;
            logger.error(message);
            assertAlways(false, message);
        }
    }

    /**
     * Called before the actions of the given turn get applied
     */
    private onTurnBoundary(turn: number) {
        const wantsSnapshot = this.transport.wantsSnapshotAt(turn);
        const wantsHash = turn > 0 && turn % HASH_INTERVAL_TURNS === 0;
        if (!wantsSnapshot && !wantsHash) {
            return;
        }

        const snapshot = createSnapshot(this.root);
        const hash = computeStateHash(this.root, snapshot);
        this.lastHash = { turn, hash };

        if (wantsHash) {
            this.transport.sendHash(turn, hash);
        }
        if (wantsSnapshot) {
            this.transport.sendSnapshot(turn, snapshot, hash);
        }
    }

    /** Returns the hash of the current state (tests, debugging) */
    getStateHash(): string {
        return computeStateHash(this.root);
    }

    getTicksPerTurn() {
        return TICKS_PER_TURN;
    }

    getPlayer(id: number): PlayerInfo | null {
        return this.players.find(p => p.id === id) ?? null;
    }

    setPlayers(players: PlayerInfo[]) {
        this.players = players;
        this.signals.playersChanged.dispatch(players);
    }

    /**
     * Called by the waypoint action, shows a notification for other players
     */
    onWaypointAdded(action: TurnAction) {
        if (action.playerId !== this.playerId) {
            const player = this.getPlayer(action.playerId);
            this.signals.notice.dispatch(
                "waypoint",
                `${player ? player.name : "?"}: ${(action.payload as { label: string }).label}`
            );
        }
    }

    destroy() {
        this.transport.close?.();
        this.root = null;
    }
}
