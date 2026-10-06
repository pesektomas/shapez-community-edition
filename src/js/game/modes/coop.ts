import { TICK_RATE } from "../../../../shared/protocol";
import type { GameRoot } from "../root";
import { RegularGameMode } from "./regular";

export const COOP_GAME_MODE_ID = "coopMode";

export interface CoopGameModeParameters {
    seed: number;
    startLevel: number;
}

/**
 * Shared world played by multiple players in deterministic lockstep. Behaves
 * like the regular game, except that the simulation is driven by the co-op
 * session (fixed tickrate, no pausing) and the world lives on the server.
 */
export class CoopGameMode extends RegularGameMode {
    readonly parameters: CoopGameModeParameters;

    static override getId() {
        return COOP_GAME_MODE_ID;
    }

    constructor(root: GameRoot, payload?: CoopGameModeParameters) {
        super(root);
        this.parameters = payload ?? { seed: 0, startLevel: 1 };

        // Hints would pause/resume locally and the video offer links to an external page
        delete this.additionalHudParts.tutorialVideoOffer;
    }

    override getFixedTickrate() {
        return TICK_RATE;
    }

    override getIsSaveable() {
        // The world is persisted by the server from the leader's snapshots
        return false;
    }

    override getInitialSeed(): number | undefined {
        return this.parameters.seed;
    }

    /**
     * Called once when the world is created (not when it is restored). Fast
     * forwards the story to the configured start level.
     */
    override onNewGameInitialized() {
        const hubGoals = this.root.hubGoals;
        const levels = this.getLevelDefinitions();
        const startLevel = Math.max(1, Math.floor(this.parameters.startLevel));

        for (let i = 0; i < startLevel - 1 && i < levels.length; ++i) {
            hubGoals.gainedRewards.add(levels[i].reward);
        }
        hubGoals.level = startLevel;
        hubGoals.computeNextGoal();
    }
}
