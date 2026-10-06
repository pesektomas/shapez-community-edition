import { GameState } from "../core/game_state";
import { Logger } from "../core/logging";
import { enterCoopGame } from "../net/coop_game";
import type { CoopSession } from "../net/coop_session";

const logger = new Logger("state/coop");

export interface CoopStatePayload {
    /** Enter the game with this session right away (used to restart a co-op game) */
    enterSession?: CoopSession;
}

/**
 * Co-op landing state. Also used as an intermediate state when a running
 * co-op game has to be restarted from a snapshot.
 */
export class CoopState extends GameState {
    constructor() {
        super("CoopState");
    }

    override getInnerHTML() {
        return `<div class="coopLoading">…</div>`;
    }

    override getHasFadeIn() {
        return false;
    }

    override onEnter(payload: CoopStatePayload) {
        if (payload.enterSession) {
            const session = payload.enterSession;
            logger.log("Restarting co-op game");
            setTimeout(() => enterCoopGame(this.app, session), 0);
        }
    }
}
