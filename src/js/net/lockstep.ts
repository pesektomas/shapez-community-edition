import { TICK_RATE, TICKS_PER_TURN, type TurnAction } from "../../../shared/protocol";

export const TICK_MS = 1000 / TICK_RATE;

/** Above this many buffered ticks, the client simulates faster to catch up */
const CATCHUP_THRESHOLD_TICKS = TICKS_PER_TURN * 3;

/** While catching up, keep this many ticks buffered to absorb network jitter */
const CATCHUP_TARGET_BUFFER_TICKS = TICKS_PER_TURN;

/** Maximum time budget which may pile up (avoids bursts after hiccups) */
const MAX_BUDGET_TICKS = 4;

export interface TickPlan {
    /** Ticks to run in any case (real-time pace) */
    regular: number;
    /** Additional ticks to run while there is frame time left (catching up) */
    catchUp: number;
}

/**
 * Bookkeeping of the lockstep turns: which turns were received, where the
 * simulation currently is and how many ticks may be simulated this frame.
 *
 * Turn n covers the ticks [n * TICKS_PER_TURN, (n + 1) * TICKS_PER_TURN).
 * Its actions are applied right before its first tick.
 */
export class Lockstep {
    private readonly turns = new Map<number, TurnAction[]>();

    /** Next turn to begin (or the turn in progress, if tickInTurn > 0) */
    nextTurn: number;

    /** How many ticks of nextTurn were already simulated */
    tickInTurn = 0;

    /** Highest turn received so far */
    latestTurn: number;

    private budgetMs = 0;

    constructor(startTurn: number) {
        this.nextTurn = startTurn;
        this.latestTurn = startTurn - 1;
    }

    /** Absolute tick counter */
    get currentTick(): number {
        return this.nextTurn * TICKS_PER_TURN + this.tickInTurn;
    }

    get isAtTurnBoundary(): boolean {
        return this.tickInTurn === 0;
    }

    addTurn(n: number, actions: TurnAction[]) {
        if (n < this.nextTurn || (n === this.nextTurn && this.tickInTurn > 0)) {
            // Already simulated (duplicate after a reconnect)
            return;
        }
        if (n !== this.latestTurn + 1) {
            throw new Error(`Turn ${n} received out of order, expected ${this.latestTurn + 1}`);
        }
        this.turns.set(n, actions);
        this.latestTurn = n;
    }

    hasTurn(n: number): boolean {
        return this.turns.has(n);
    }

    /** Removes and returns the actions of the next turn, which must be available */
    beginTurn(): TurnAction[] {
        assert(this.tickInTurn === 0, "Turn already in progress");
        const actions = this.turns.get(this.nextTurn);
        assert(actions, "Turn not available: " + this.nextTurn);
        this.turns.delete(this.nextTurn);
        return actions;
    }

    /** Must be called after each simulated tick */
    onTickDone() {
        this.tickInTurn++;
        if (this.tickInTurn >= TICKS_PER_TURN) {
            this.tickInTurn = 0;
            this.nextTurn++;
        }
    }

    /** How many ticks could be simulated with the turns received so far */
    getAvailableTicks(): number {
        return Math.max(0, (this.latestTurn + 1 - this.nextTurn) * TICKS_PER_TURN - this.tickInTurn);
    }

    /** How far the simulation is behind the latest turn, in milliseconds */
    getLagMs(): number {
        return this.getAvailableTicks() * TICK_MS;
    }

    /**
     * Decides how many ticks to simulate for a frame which took deltaMs
     */
    planTicks(deltaMs: number): TickPlan {
        const available = this.getAvailableTicks();
        this.budgetMs = Math.min(this.budgetMs + Math.max(0, deltaMs), MAX_BUDGET_TICKS * TICK_MS);

        if (available === 0) {
            // Waiting for the server, do not let the budget pile up meanwhile
            this.budgetMs = Math.min(this.budgetMs, TICK_MS);
            return { regular: 0, catchUp: 0 };
        }

        const regular = Math.min(available, Math.floor(this.budgetMs / TICK_MS));
        this.budgetMs -= regular * TICK_MS;

        let catchUp = 0;
        const remaining = available - regular;
        if (remaining > CATCHUP_THRESHOLD_TICKS) {
            catchUp = remaining - CATCHUP_TARGET_BUFFER_TICKS;
        }

        return { regular, catchUp };
    }
}
