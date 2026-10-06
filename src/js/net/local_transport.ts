import type { Action, TurnAction } from "../../../shared/protocol";
import type { CoopTransport } from "./coop_session";
import type { CoopSnapshot } from "./snapshot";

/**
 * Transport without a server: every turn is created on demand from the
 * actions dispatched so far. Used for offline play and tests.
 */
export class LocalTransport implements CoopTransport {
    private pending: TurnAction[] = [];
    readonly hashes: Array<{ turn: number; hash: string }> = [];

    constructor(readonly playerId: number = 1) {}

    sendAction(action: Action & { clientSeq: number }) {
        this.pending.push({ ...action, playerId: this.playerId } as TurnAction);
    }

    /** Queues an action as if it was sent by the given player */
    queueTurnAction(action: TurnAction) {
        this.pending.push(action);
    }

    pollTurn(_n: number): TurnAction[] {
        const actions = this.pending;
        this.pending = [];
        return actions;
    }

    sendHash(turn: number, hash: string) {
        this.hashes.push({ turn, hash });
    }

    wantsSnapshotAt(_turn: number) {
        return false;
    }

    sendSnapshot(_turn: number, _snapshot: CoopSnapshot, _hash: string) {}
}
