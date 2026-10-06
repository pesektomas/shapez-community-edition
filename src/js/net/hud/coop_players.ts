import type { PlayerInfo } from "../../../../shared/protocol";
import { makeDiv } from "../../core/utils";
import { BaseHUDPart } from "../../game/hud/base_hud_part";
import { coopText, escapeHtml } from "../coop_texts";

/** Shows a "catching up" hint above this lag */
const LAG_WARNING_MS = 2000;

/**
 * Online players (top right), invite link and connection state
 */
export class HUDCoopPlayers extends BaseHUDPart {
    private element: HTMLElement;
    private listElement: HTMLElement;
    private bannerElement: HTMLElement;
    private connected = true;
    private lastBanner = "";

    override createElements(parent: HTMLElement) {
        const t = coopText();
        this.element = makeDiv(parent, "ingame_HUD_CoopPlayers", []);
        makeDiv(this.element, null, ["title"], t.players);
        this.listElement = makeDiv(this.element, null, ["list"]);
        const invite = document.createElement("button");
        invite.className = "invite styledButton";
        invite.textContent = t.copyInvite;
        this.element.appendChild(invite);
        this.bindClick(invite, this.copyInvite);

        this.bannerElement = makeDiv(parent, "ingame_HUD_CoopBanner", []);
    }

    override initialize() {
        const session = this.root.coop;
        session.signals.playersChanged.add(this.renderPlayers, this);
        session.signals.connectionChanged.add(connected => {
            this.connected = connected;
        });
        this.renderPlayers(session.players);

        session.signals.fatalError.add(code => {
            const t = coopText();
            const message = (t.errors as Record<string, string>)[code] ?? t.errors.default;
            if (code === "version_mismatch") {
                const buttons = this.root.hud.parts.dialogs.showWarning(t.status.error, escapeHtml(message), [
                    "restart:good",
                ]);
                buttons.restart.add(() => location.reload());
            } else {
                const buttons = this.root.hud.parts.dialogs.showWarning(t.status.error, escapeHtml(message), [
                    "ok:good",
                ]);
                buttons.ok.add(() => this.root.gameState.goBackToMenu());
            }
        });

        // Saving happens on the server
        document.getElementById("ingame_HUD_GameMenu")?.classList.add("coop");
    }

    private renderPlayers(players: PlayerInfo[]) {
        const me = this.root.coop.playerId;
        this.listElement.innerHTML = players
            .filter(p => p.online)
            .map(
                p => `<div class="player${p.id === me ? " me" : ""}">
                    <span class="dot" style="background:${escapeHtml(p.color)}"></span>
                    <span class="name">${escapeHtml(p.name)}</span>
                </div>`
            )
            .join("");
    }

    private copyInvite() {
        const link = this.root.coop.inviteLink;
        if (!link) {
            return;
        }
        void navigator.clipboard?.writeText(link).catch(() => {});
        this.root.hud.signals.notification.dispatch(coopText().inviteCopied, "success");
    }

    override update() {
        const t = coopText();
        let banner = "";
        if (!this.connected) {
            banner = t.disconnected;
        } else if (this.root.coop.lockstep.getLagMs() > LAG_WARNING_MS) {
            banner = t.lagging;
        }
        if (banner !== this.lastBanner) {
            this.lastBanner = banner;
            this.bannerElement.textContent = banner;
            this.bannerElement.classList.toggle("visible", banner !== "");
        }
    }

    private bindClick(element: HTMLElement, handler: () => void) {
        element.addEventListener("click", ev => {
            ev.stopPropagation();
            handler.call(this);
        });
        // The game listens on mousedown, keep the click for the button
        element.addEventListener("mousedown", ev => ev.stopPropagation());
    }
}
