import { STOP_PROPAGATION } from "../../core/signal";
import { makeDiv } from "../../core/utils";
import { BaseHUDPart } from "../../game/hud/base_hud_part";
import { coopText, escapeHtml } from "../coop_texts";

const MESSAGE_VISIBLE_MS = 12_000;
const MAX_MESSAGES = 8;
const KEY_ENTER = 13;
const KEY_Z = 90;

/**
 * Text chat (Enter opens it) and the undo shortcut (Ctrl+Z)
 */
export class HUDCoopChat extends BaseHUDPart {
    private element: HTMLElement;
    private messagesElement: HTMLElement;
    private input: HTMLInputElement;
    private messages: Array<{ element: HTMLElement; expireAt: number }> = [];

    override createElements(parent: HTMLElement) {
        this.element = makeDiv(parent, "ingame_HUD_CoopChat", []);
        this.messagesElement = makeDiv(this.element, null, ["messages"]);
        this.input = document.createElement("input");
        this.input.type = "text";
        this.input.maxLength = 300;
        this.input.placeholder = coopText().chatPlaceholder;
        this.input.className = "chatInput";
        this.element.appendChild(this.input);

        this.input.addEventListener("keydown", ev => {
            // Typing must not control the game
            ev.stopPropagation();
            if (ev.key === "Enter") {
                const text = this.input.value.trim();
                if (text) {
                    this.root.coop.transport.sendChat?.(text);
                }
                this.closeInput();
            } else if (ev.key === "Escape") {
                this.closeInput();
            }
        });
        this.input.addEventListener("keyup", ev => ev.stopPropagation());
        this.input.addEventListener("mousedown", ev => ev.stopPropagation());
        this.input.addEventListener("blur", () => this.closeInput());
    }

    override initialize() {
        const session = this.root.coop;
        session.signals.chat.add((playerId, text) => {
            const player = session.getPlayer(playerId);
            this.addMessage(
                `<span class="name" style="color:${escapeHtml(player?.color ?? "#fff")}">${escapeHtml(
                    player?.name ?? "?"
                )}</span> ${escapeHtml(text)}`
            );
        });

        this.root.gameState.inputReceiver.keydown.add(({ keyCode, ctrl, event }) => {
            if (keyCode === KEY_ENTER && !this.isOpen) {
                this.openInput();
                return STOP_PROPAGATION;
            }
            const meta = event instanceof KeyboardEvent && event.metaKey;
            if (keyCode === KEY_Z && (ctrl || meta)) {
                if (this.root.coop.undo()) {
                    this.root.soundProxy.playUiClick();
                } else {
                    this.root.soundProxy.playUiError();
                }
                return STOP_PROPAGATION;
            }
        });
    }

    /** Shows a system line in the chat */
    addSystemMessage(text: string) {
        this.addMessage(`<span class="system">${escapeHtml(text)}</span>`);
    }

    private addMessage(html: string) {
        const element = makeDiv(this.messagesElement, null, ["message"], html);
        this.messages.push({ element, expireAt: performance.now() + MESSAGE_VISIBLE_MS });
        while (this.messages.length > MAX_MESSAGES) {
            this.messages.shift().element.remove();
        }
    }

    get isOpen() {
        return this.element.classList.contains("open");
    }

    private openInput() {
        this.element.classList.add("open");
        this.input.value = "";
        this.input.focus();
    }

    private closeInput() {
        this.element.classList.remove("open");
        this.input.blur();
    }

    override update() {
        const now = performance.now();
        const open = this.isOpen;
        for (const message of this.messages) {
            message.element.classList.toggle("faded", !open && message.expireAt < now);
        }
    }
}
