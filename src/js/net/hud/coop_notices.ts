import type { TurnAction } from "../../../../shared/protocol";
import { getRomanNumber } from "../../core/utils";
import { BaseHUDPart } from "../../game/hud/base_hud_part";
import { enumNotificationType } from "../../game/hud/parts/notifications";
import { T } from "../../translations";
import { coopText, fill } from "../coop_texts";
import type { HUDCoopChat } from "./coop_chat";

/**
 * Notifications about the other players: joins, purchases, markers,
 * finished levels, desyncs.
 */
export class HUDCoopNotices extends BaseHUDPart {
    override initialize() {
        const session = this.root.coop;

        session.signals.notice.add((kind, detail) => {
            const t = coopText();
            const player = session.getPlayer(Number(detail));
            switch (kind) {
                case "playerJoined":
                    this.notify(
                        fill(t.playerJoined, { name: player?.name ?? "?" }),
                        enumNotificationType.info
                    );
                    break;
                case "playerLeft":
                    this.notify(fill(t.playerLeft, { name: player?.name ?? "?" }), enumNotificationType.info);
                    break;
                case "desync":
                    this.notify(t.desync, enumNotificationType.warning);
                    break;
                case "waypoint":
                    this.notify(detail, enumNotificationType.info);
                    break;
            }
        });

        session.signals.actionApplied.add((action: TurnAction, changed: boolean) => {
            if (changed && action.type === "unlockUpgrade") {
                const player = session.getPlayer(action.playerId);
                const upgradeId = action.payload.upgradeId;
                // The level after the purchase is the tier which was bought
                const tier = this.root.hubGoals.getUpgradeLevel(upgradeId) + 1;
                const name = T.shopUpgrades[upgradeId]?.name ?? upgradeId;
                this.notify(
                    fill(coopText().upgradeBought, {
                        name: player?.name ?? "?",
                        upgrade: name,
                        tier: T.ingame.shop.tier.replace("<x>", getRomanNumber(tier)),
                    }),
                    enumNotificationType.upgrade
                );
            }
        });

        this.root.signals.storyGoalCompleted.add(level => {
            this.chat()?.addSystemMessage(fill(coopText().levelCompleted, { level }));
        });
    }

    private chat() {
        return (this.root.hud.parts as unknown as Record<string, unknown>).coopChat as
            | HUDCoopChat
            | undefined;
    }

    private notify(text: string, type: string) {
        this.root.hud.signals.notification.dispatch(text, type);
        this.chat()?.addSystemMessage(text);
    }
}
