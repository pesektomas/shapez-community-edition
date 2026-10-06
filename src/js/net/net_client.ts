import { decode, encode } from "@msgpack/msgpack";
import type { ClientMessage, ServerMessage } from "../../../shared/protocol";
import { Logger } from "../core/logging";
import { Signal } from "../core/signal";

const logger = new Logger("coop/net");

const PING_INTERVAL_MS = 3000;
/** No message for this long means the connection is dead */
const CONNECTION_TIMEOUT_MS = 10_000;
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];

/**
 * WebSocket connection to the co-op server with msgpack messages,
 * keepalive pings and automatic reconnects.
 */
export class NetClient {
    readonly url: string;
    private ws: WebSocket | null = null;
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private lastMessageAt = 0;
    private closedByUser = false;

    /** Round trip time of the last ping */
    rttMs = 0;

    readonly signals = {
        open: new Signal<[]>(),
        message: new Signal<[ServerMessage]>(),
        /** Connection was lost, the client will reconnect */
        disconnected: new Signal<[]>(),
        /** Connection closed for good (by the server or by close()) */
        closed: new Signal<[number, string]>(),
    };

    constructor(url: string) {
        this.url = url;
    }

    static getDefaultUrl(): string {
        // Tests can route the connection through a proxy (dev builds only)
        const override = new URLSearchParams(location.search).get("ws");
        if (G_IS_DEV && override) {
            return override;
        }
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        return `${protocol}//${location.host}/ws`;
    }

    get isOpen() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    connect() {
        this.closedByUser = false;
        this.openSocket();
    }

    private openSocket() {
        const ws = new WebSocket(this.url);
        ws.binaryType = "arraybuffer";
        this.ws = ws;

        ws.addEventListener("open", () => {
            logger.log("Connected to", this.url);
            this.reconnectAttempt = 0;
            this.lastMessageAt = performance.now();
            this.startPing();
            this.signals.open.dispatch();
        });

        ws.addEventListener("message", event => {
            this.lastMessageAt = performance.now();
            let message: ServerMessage;
            try {
                message = decode(new Uint8Array(event.data as ArrayBuffer)) as ServerMessage;
            } catch (err) {
                logger.error("Malformed message from server", err);
                return;
            }
            if (message.t === "pong") {
                this.rttMs = performance.now() - message.time;
            }
            this.signals.message.dispatch(message);
        });

        ws.addEventListener("close", event => {
            if (this.ws !== ws) {
                return;
            }
            this.stopPing();
            this.ws = null;

            // 4000-4099 are final errors sent by the server (invalid invite, ...)
            const final =
                this.closedByUser || (event.code >= 4000 && event.code < 4100 && event.code !== 4001);
            if (final) {
                this.signals.closed.dispatch(event.code, event.reason);
                return;
            }
            logger.warn("Connection lost:", event.code, event.reason);
            this.signals.disconnected.dispatch();
            this.scheduleReconnect();
        });

        ws.addEventListener("error", () => {
            // A close event follows
        });
    }

    private scheduleReconnect() {
        if (this.reconnectTimer || this.closedByUser) {
            return;
        }
        const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.openSocket();
        }, delay);
    }

    private startPing() {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (performance.now() - this.lastMessageAt > CONNECTION_TIMEOUT_MS) {
                logger.warn("Connection timed out");
                // Do not wait for the close handshake of a dead connection
                this.reconnect();
                return;
            }
            this.send({ t: "ping", time: performance.now() });
        }, PING_INTERVAL_MS);
    }

    private stopPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    send(message: ClientMessage) {
        if (this.isOpen) {
            this.ws.send(encode(message, { ignoreUndefined: true }));
        }
    }

    /** Drops the current connection and connects again */
    reconnect() {
        const ws = this.ws;
        if (ws) {
            ws.dispatchEvent(new CloseEvent("close", { code: 1006, reason: "reconnect" }));
            ws.close();
        }
    }

    close() {
        this.closedByUser = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.stopPing();
        if (this.ws) {
            this.ws.close(1000, "bye");
        }
    }
}
