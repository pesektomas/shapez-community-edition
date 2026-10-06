import { TICKS_PER_TURN, type Action, type TurnAction, type WorldParams } from "../../../shared/protocol";
import { Vector } from "../core/vector";
import { serializeEntityData } from "./actions";
import type { Application } from "../application";
import { GAME_LOADING_STATES, type InGameState } from "../states/ingame";
import { enterCoopGame } from "./coop_game";
import { CoopSession } from "./coop_session";
import { LocalTransport } from "./local_transport";
import { createSnapshot, type CoopSnapshot } from "./snapshot";
import { getCanonicalState } from "./state_hash";

interface Area {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface ScenarioStep {
    turn: number;
    playerId?: number;
    actions?: Action[];
    /** Copies all buildings of the area and pastes them at the target */
    blueprint?: { area: Area; to: { x: number; y: number }; free?: boolean; cost?: number };
    /** Deletes all buildings in the area */
    deleteArea?: Area;
    deleteLayer?: string;
    signalAt?: { x: number; y: number; signal: unknown };
    toggleAt?: { x: number; y: number };
}

/**
 * Test hooks exposed as window.__coop (dev builds only). Tests drive the
 * simulation through this API instead of the mouse, see e2e/.
 */
export class CoopTestApi {
    private transport: LocalTransport | null = null;

    constructor(private readonly app: Application) {}

    private get state(): InGameState | null {
        const state = this.app.stateMgr.currentState;
        return state && state.key === "InGameState" ? (state as InGameState) : null;
    }

    private get session(): CoopSession {
        const session = this.state?.core?.root?.coop;
        if (!session) {
            throw new Error("No co-op game running");
        }
        return session;
    }

    private async startSession(session: CoopSession) {
        session.manualTicking = true;
        enterCoopGame(this.app, session);

        // Wait until the game runs
        const deadline = performance.now() + 60_000;
        while (performance.now() < deadline) {
            const state = this.state;
            if (
                state &&
                state.core?.root?.coop === session &&
                state.stage === GAME_LOADING_STATES.s10_gameRunning
            ) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Timeout while starting the co-op game");
    }

    /** Creates a new world and waits until it is running */
    async newWorld({ seed, startLevel = 1 }: Partial<WorldParams>) {
        this.transport = new LocalTransport(1);
        const session = new CoopSession({
            playerId: 1,
            transport: this.transport,
            world: { seed: seed ?? 1234, startLevel },
            snapshot: null,
            startTurn: 0,
            turns: [],
        });
        await this.startSession(session);
    }

    /** Restores a snapshot obtained by getSnapshot() */
    async loadSnapshot({
        turn,
        world,
        snapshot,
    }: {
        turn: number;
        world: WorldParams;
        snapshot: CoopSnapshot;
    }) {
        this.transport = new LocalTransport(1);
        const session = new CoopSession({
            playerId: 1,
            transport: this.transport,
            world,
            snapshot: structuredClone(snapshot),
            startTurn: turn,
            turns: [],
        });
        await this.startSession(session);
    }

    /** Returns a snapshot of the current state, must be at a turn boundary */
    getSnapshot() {
        const session = this.session;
        if (!session.lockstep.isAtTurnBoundary) {
            throw new Error("Snapshots can only be taken at turn boundaries");
        }
        return {
            turn: session.lockstep.nextTurn,
            world: session.world,
            snapshot: structuredClone(createSnapshot(session.root)),
        };
    }

    /** Queues actions for the next turn (same path as actions from the network) */
    applyActions(actions: Array<Partial<TurnAction>>) {
        if (!this.transport || !this.session) {
            throw new Error("No co-op game running");
        }
        let seq = 0;
        for (const action of actions) {
            this.transport.queueTurnAction({
                playerId: 1,
                clientSeq: ++seq,
                ...action,
            } as TurnAction);
        }
    }

    /** Simulates n ticks synchronously */
    runTicks(n: number): number {
        const core = this.state.core;
        return this.session.runTicks(n, core.boundInternalTick);
    }

    getStateHash(): string {
        return this.session.getStateHash();
    }

    dumpState() {
        return getCanonicalState(this.session.root);
    }

    getInfo() {
        const session = this.session;
        const root = session.root;
        return {
            tick: session.lockstep.currentTick,
            turn: session.lockstep.nextTurn,
            entities: root.entityMgr.entities.size,
            level: root.hubGoals.level,
            timeSeconds: root.time.now(),
            storedShapes: { ...root.hubGoals.storedShapes },
        };
    }

    /**
     * Returns the uids of all entities whose origin is inside the area
     */
    getUidsInArea(area: Area, layer: string | null = null): number[] {
        const uids: number[] = [];
        for (const entity of this.session.root.entityMgr.entities.values()) {
            const staticComp = entity.components.StaticMapEntity;
            if (!staticComp || entity.queuedForDestroy || entity.destroyed) {
                continue;
            }
            if (layer && entity.layer !== layer) {
                continue;
            }
            const { x, y } = staticComp.origin;
            if (x >= area.x && x < area.x + area.w && y >= area.y && y < area.y + area.h) {
                uids.push(entity.uid);
            }
        }
        return uids;
    }

    /**
     * Creates the entity list of a blueprint from all buildings in the area,
     * relative to the area origin
     */
    getBlueprintFromArea(area: Area) {
        const entities = this.getUidsInArea(area).map(uid => this.session.root.entityMgr.findByUid(uid));
        return entities.map(entity => serializeEntityData(entity, new Vector(area.x, area.y)));
    }

    /**
     * Runs a scenario turn by turn and returns the state hash at every checkpoint
     */
    runScenario({
        steps,
        toTurn,
        checkpointEveryTicks = 1000,
    }: {
        steps: ScenarioStep[];
        toTurn: number;
        checkpointEveryTicks?: number;
    }) {
        const session = this.session;
        const checkpoints: Array<{ tick: number; hash: string }> = [];

        while (session.lockstep.nextTurn < toTurn) {
            const turn = session.lockstep.nextTurn;
            for (const step of steps) {
                if (step.turn !== turn) {
                    continue;
                }
                this.applyActions(this.resolveStep(step));
            }

            for (let i = 0; i < TICKS_PER_TURN; ++i) {
                if (this.runTicks(1) !== 1) {
                    throw new Error("Simulation stopped at turn " + turn);
                }
                const tick = session.lockstep.currentTick;
                if (checkpointEveryTicks > 0 && tick % checkpointEveryTicks === 0) {
                    checkpoints.push({ tick, hash: this.getStateHash() });
                }
            }
        }

        return { checkpoints, hash: this.getStateHash(), info: this.getInfo() };
    }

    private resolveStep(step: ScenarioStep): Array<Partial<TurnAction>> {
        const playerId = step.playerId ?? 1;
        const actions: Array<Partial<TurnAction>> = (step.actions ?? []).map(action => ({
            ...action,
            playerId,
        }));

        if (step.blueprint) {
            actions.push({
                playerId,
                type: "pasteBlueprint",
                payload: {
                    x: step.blueprint.to.x,
                    y: step.blueprint.to.y,
                    entities: this.getBlueprintFromArea(step.blueprint.area),
                    free: step.blueprint.free ?? false,
                    cost: step.blueprint.cost ?? 0,
                },
            });
        }

        const map = this.session.root.map;
        if (step.signalAt) {
            const entity = map.getLayerContentXY(step.signalAt.x, step.signalAt.y, "wires");
            if (entity) {
                actions.push({
                    playerId,
                    type: "setConstantSignal",
                    payload: { uid: entity.uid, signal: step.signalAt.signal },
                });
            }
        }

        if (step.toggleAt) {
            const entity = map.getLayerContentXY(step.toggleAt.x, step.toggleAt.y, "regular");
            if (entity) {
                actions.push({ playerId, type: "toggleLever", payload: { uid: entity.uid } });
            }
        }

        if (step.deleteArea) {
            actions.push({
                playerId,
                type: "deleteBuildings",
                payload: { uids: this.getUidsInArea(step.deleteArea, step.deleteLayer ?? null) },
            });
        }
        return actions;
    }

    /** Breaks the local state on purpose (recovery tests) */
    setFakeDesync() {
        const hubGoals = this.session.root.hubGoals;
        hubGoals.storedShapes["CuCuCuCu"] = (hubGoals.storedShapes["CuCuCuCu"] || 0) + 1;
    }

    /** Lets the game run in real time again (for watching / UI tests) */
    setManualTicking(flag: boolean) {
        this.session.manualTicking = flag;
    }
}

export function installCoopTestApi(app: Application) {
    // @ts-expect-error debug global
    window.__coop = new CoopTestApi(app);
}
