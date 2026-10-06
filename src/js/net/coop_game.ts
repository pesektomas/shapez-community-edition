import type { Application } from "../application";
import { COOP_GAME_MODE_ID } from "../game/modes/coop";
import { Savegame } from "../savegame/savegame";
import type { CoopSession } from "./coop_session";

/**
 * Creates the in-memory savegame of a co-op game. Co-op worlds are never
 * stored locally, the server keeps them.
 */
export function createCoopSavegame(app: Application, session: CoopSession): Savegame {
    const savegame = new Savegame(app, {
        internalId: "coop",
        metaDataRef: {
            internalId: "coop",
            lastUpdate: 0,
            version: Savegame.getCurrentVersion(),
            level: 0,
            name: session.worldName || "coop",
        },
    });
    const dump = session.getSnapshotDump();
    if (dump) {
        savegame.currentData.dump = dump;
    }
    return savegame;
}

/**
 * Enters the game with the given session (from any state)
 */
export function enterCoopGame(app: Application, session: CoopSession) {
    if (app.stateMgr.currentState?.key === "InGameState") {
        // The game state can not be re-entered directly
        app.stateMgr.moveToState("CoopState", { enterSession: session });
        return;
    }
    app.stateMgr.moveToState("InGameState", {
        gameModeId: COOP_GAME_MODE_ID,
        gameModeParameters: { ...session.world },
        savegame: createCoopSavegame(app, session),
        coopSession: session,
        fastEnter: true,
    });
}
