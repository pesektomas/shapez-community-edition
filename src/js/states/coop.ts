import { START_LEVELS, type StartMode } from "../../../shared/protocol";
import { GameState } from "../core/game_state";
import { Logger } from "../core/logging";
import { CoopConnection, type CoopConnectionStatus } from "../net/coop_connection";
import { NetClient } from "../net/net_client";
import { enterCoopGame } from "../net/coop_game";
import type { CoopSession } from "../net/coop_session";
import { getPlayerName, getRememberedWorlds, setPlayerName, type RememberedWorld } from "../net/coop_storage";
import { coopText, escapeHtml, setCoopLanguage } from "../net/coop_texts";
import { getInvitePath, parseInviteLink } from "../net/invite";

const logger = new Logger("state/coop");

export interface CoopStatePayload {
    /** Enter the game with this session right away (used to restart a co-op game) */
    enterSession?: CoopSession;
}

interface ServerConfig {
    passwordRequired: boolean;
    sourceUrl: string;
}

/**
 * Co-op landing page: nickname, new world, my worlds, joining via invite
 * link. Also used as an intermediate state when a running co-op game has to
 * be restarted from a snapshot.
 */
export class CoopState extends GameState {
    private connection: CoopConnection | null = null;
    private config: ServerConfig = { passwordRequired: false, sourceUrl: "" };

    constructor() {
        super("CoopState");
    }

    override getInnerHTML() {
        return `<div class="coopLanding"></div>`;
    }

    override getHasFadeIn() {
        return false;
    }

    override getThemeMusic() {
        return null;
    }

    override onEnter(payload: CoopStatePayload) {
        const language = this.app.settings.getLanguage();
        setCoopLanguage(!language || language === "auto-detect" ? navigator.language : language);

        if (payload.enterSession) {
            const session = payload.enterSession;
            logger.log("Restarting co-op game");
            this.renderStatus("loading", "");
            setTimeout(() => enterCoopGame(this.app, session), 0);
            return;
        }

        this.render();
        void this.loadServerConfig();
    }

    override onLeave() {
        // The connection lives on in the game
        this.connection?.signals.statusChanged.removeAll();
        this.connection?.signals.error.removeAll();
    }

    private get container() {
        return this.htmlElement.querySelector(".coopLanding") as HTMLElement;
    }

    private async loadServerConfig() {
        try {
            const res = await fetch("/api/config");
            if (res.ok) {
                const config = (await res.json()) as ServerConfig;
                const changed =
                    config.passwordRequired !== this.config.passwordRequired ||
                    config.sourceUrl !== this.config.sourceUrl;
                this.config = config;
                if (changed) {
                    this.render();
                }
            }
        } catch {
            // No server (e.g. static hosting), only offline play works
        }
    }

    /////////////////// RENDERING ///////////////////

    private render() {
        const t = coopText();
        const invite = parseInviteLink(location.href);
        const name = escapeHtml(getPlayerName());
        const worlds = getRememberedWorlds();

        const passwordField = this.config.passwordRequired
            ? `<label class="field"><span>${t.password}</span><input type="password" class="password" autocomplete="current-password"></label>`
            : "";

        const startModes = (Object.keys(START_LEVELS) as StartMode[])
            .map(
                (mode, i) => `
                <label class="startMode">
                    <input type="radio" name="startMode" value="${mode}" ${i === 0 ? "checked" : ""}>
                    <span class="title">${t.startModes[mode][0]}</span>
                    <span class="desc">${t.startModes[mode][1]}</span>
                </label>`
            )
            .join("");

        const joinPanel = invite
            ? `<section class="panel joinPanel">
                    <h2>${t.joinWorld} <span class="worldName"></span></h2>
                    <label class="field"><span>${t.nickname}</span>
                        <input type="text" class="nickname" maxlength="24" value="${name}" placeholder="${t.nicknamePlaceholder}" autofocus>
                    </label>
                    ${passwordField}
                    <button class="styledButton joinButton">${t.join}</button>
               </section>`
            : "";

        this.container.innerHTML = `
            <header>
                <h1>${t.title}</h1>
                <p class="subtitle">${t.subtitle}</p>
            </header>
            <div class="error"></div>
            ${joinPanel}
            <div class="columns">
                <section class="panel createPanel">
                    <h2>${t.newWorld}</h2>
                    ${
                        invite
                            ? ""
                            : `<label class="field"><span>${t.nickname}</span>
                                <input type="text" class="nickname" maxlength="24" value="${name}" placeholder="${t.nicknamePlaceholder}">
                               </label>`
                    }
                    <label class="field"><span>${t.worldName}</span>
                        <input type="text" class="worldNameInput" maxlength="60" placeholder="${t.worldNamePlaceholder}">
                    </label>
                    <div class="startModes">${startModes}</div>
                    ${invite ? "" : passwordField}
                    <button class="styledButton createButton">${t.create}</button>
                </section>
                <section class="panel worldsPanel">
                    <h2>${t.myWorlds}</h2>
                    <ul class="worlds">${
                        worlds.length === 0
                            ? `<li class="empty">${t.noWorlds}</li>`
                            : worlds.map(world => this.renderWorld(world)).join("")
                    }</ul>
                    <h2>${t.joinByLink}</h2>
                    <div class="linkRow">
                        <input type="text" class="linkInput" placeholder="${t.linkPlaceholder}">
                        <button class="styledButton linkButton">${t.join}</button>
                    </div>
                </section>
            </div>
            <footer>
                <button class="styledButton singleplayerButton">${t.singleplayer}</button>
                <p class="credits">${t.credits}${
                    this.config.sourceUrl
                        ? ` · <a href="${escapeHtml(this.config.sourceUrl)}" target="_blank" rel="noopener">${t.source}</a>`
                        : ""
                }</p>
            </footer>
            <div class="statusOverlay"><div class="statusBox"><div class="spinner"></div><div class="statusText"></div></div></div>
        `;

        this.bindEvents(invite);
        if (invite) {
            void this.loadWorldName(invite.worldId, invite.inviteKey);
        }
    }

    private renderWorld(world: RememberedWorld) {
        const date = new Date(world.lastPlayed).toLocaleString();
        return `<li><button class="worldEntry" data-id="${escapeHtml(world.id)}" data-key="${escapeHtml(world.key)}">
            <span class="name">${escapeHtml(world.name)}</span>
            <span class="date">${coopText().lastPlayed} ${escapeHtml(date)}</span>
        </button></li>`;
    }

    private bindEvents(invite: { worldId: string; inviteKey: string } | null) {
        const root = this.container;
        root.querySelectorAll<HTMLInputElement>("input.nickname").forEach(input =>
            input.addEventListener("input", () => {
                root.querySelectorAll<HTMLInputElement>("input.nickname").forEach(other => {
                    if (other !== input) {
                        other.value = input.value;
                    }
                });
            })
        );

        if (invite) {
            const joinButton = root.querySelector(".joinButton");
            this.trackClicks(joinButton, () => this.join(invite.worldId, invite.inviteKey));
            root.querySelector<HTMLElement>(".joinPanel").addEventListener("keydown", ev => {
                if (ev.key === "Enter") {
                    this.join(invite.worldId, invite.inviteKey);
                }
            });
        }

        this.trackClicks(root.querySelector(".createButton"), () => void this.createWorld());
        this.trackClicks(root.querySelector(".singleplayerButton"), () => this.moveToState("MainMenuState"));
        this.trackClicks(root.querySelector(".linkButton"), () => this.joinByLink());
        root.querySelector<HTMLInputElement>(".linkInput").addEventListener("keydown", ev => {
            if (ev.key === "Enter") {
                this.joinByLink();
            }
        });

        root.querySelectorAll<HTMLElement>(".worldEntry").forEach(entry => {
            this.trackClicks(entry, () => this.join(entry.dataset.id, entry.dataset.key));
        });

        // Keyboard input must reach the inputs, the game captures keys otherwise
        root.querySelectorAll("input").forEach(input => {
            input.addEventListener("keydown", ev => ev.stopPropagation());
        });
    }

    private async loadWorldName(worldId: string, inviteKey: string) {
        try {
            const res = await fetch(
                `/api/worlds/${encodeURIComponent(worldId)}?k=${encodeURIComponent(inviteKey)}`
            );
            if (!res.ok) {
                this.showError(res.status === 404 ? "invalid_invite" : "default");
                return;
            }
            const data = (await res.json()) as { world: { name: string } };
            const element = this.container.querySelector(".worldName");
            if (element) {
                element.textContent = "„" + data.world.name + "“";
            }
        } catch {
            this.showError("no_server");
        }
    }

    private renderStatus(status: CoopConnectionStatus, detail: string) {
        const t = coopText();
        if (!this.container.querySelector(".statusOverlay")) {
            this.container.innerHTML = `<div class="statusOverlay"><div class="statusBox"><div class="spinner"></div><div class="statusText"></div></div></div>`;
        }
        const overlay = this.container.querySelector(".statusOverlay") as HTMLElement;
        const text = overlay.querySelector(".statusText") as HTMLElement;

        if (status === "error" || status === "closed") {
            overlay.classList.remove("visible");
            this.showError(detail || "default");
            return;
        }
        overlay.classList.add("visible");
        text.textContent = t.status[status];
    }

    private showError(code: string) {
        const t = coopText();
        const element = this.container.querySelector(".error") as HTMLElement | null;
        if (!element) {
            return;
        }
        const message = (t.errors as Record<string, string>)[code] ?? t.errors.default;
        element.innerHTML = escapeHtml(message);
        if (code === "version_mismatch") {
            const button = document.createElement("button");
            button.className = "styledButton";
            button.textContent = t.reload;
            button.addEventListener("click", () => location.reload());
            element.appendChild(button);
        }
        element.classList.add("visible");
    }

    /////////////////// ACTIONS ///////////////////

    private readNickname(): string | null {
        const input = this.container.querySelector<HTMLInputElement>("input.nickname");
        const name = input ? input.value.trim() : "";
        if (!name) {
            this.showError("name_required");
            input?.focus();
            return null;
        }
        setPlayerName(name);
        return name;
    }

    private readPassword(): string | undefined {
        return this.container.querySelector<HTMLInputElement>("input.password")?.value || undefined;
    }

    private async createWorld() {
        const name = this.readNickname();
        if (!name) {
            return;
        }
        const startMode =
            this.container.querySelector<HTMLInputElement>("input[name=startMode]:checked")?.value ?? "fresh";
        const worldName = this.container.querySelector<HTMLInputElement>(".worldNameInput").value.trim();
        const password = this.readPassword();

        try {
            const res = await fetch("/api/worlds", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: worldName || name + " & spol.", startMode, password }),
            });
            if (!res.ok) {
                this.showError(res.status === 403 ? "invalid_password" : "create_failed");
                return;
            }
            const data = (await res.json()) as { world: { id: string }; inviteKey: string };
            this.join(data.world.id, data.inviteKey);
        } catch {
            this.showError("no_server");
        }
    }

    private joinByLink() {
        const link = this.container.querySelector<HTMLInputElement>(".linkInput").value.trim();
        const invite = parseInviteLink(link);
        if (!invite) {
            this.showError("invalid_invite");
            return;
        }
        this.join(invite.worldId, invite.inviteKey);
    }

    join(worldId: string, inviteKey: string) {
        const name = this.readNickname();
        if (!name) {
            return;
        }

        // Read before the URL changes (tests may pass the server URL in it)
        const serverUrl = NetClient.getDefaultUrl();

        // The address bar shows the invite link, so it can be shared right away
        history.replaceState(history.state, "", getInvitePath(worldId, inviteKey));

        const connection = new CoopConnection(this.app, {
            worldId,
            inviteKey,
            name,
            password: this.readPassword(),
            serverUrl,
        });
        this.connection = connection;
        connection.signals.statusChanged.add((status, detail) => this.renderStatus(status, detail));
        connection.signals.error.add(code => this.showError(code));
        connection.start();
    }
}
