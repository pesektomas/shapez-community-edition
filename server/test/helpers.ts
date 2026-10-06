import { decode, encode } from "@msgpack/msgpack";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "../../shared/protocol.ts";
import { createServer, type CoopServer, type ServerOptions } from "../src/app.ts";
import type { Clock } from "../src/clock.ts";

/** Manually advanced clock, turns are only closed when the test advances time */
export class FakeClock implements Clock {
    time = 0;
    private timers = new Map<number, { callback: () => void; ms: number; next: number }>();
    private nextId = 1;

    now() {
        return this.time;
    }

    setInterval(callback: () => void, ms: number) {
        const id = this.nextId++;
        this.timers.set(id, { callback, ms, next: this.time + ms });
        return id;
    }

    clearInterval(handle: unknown) {
        this.timers.delete(handle as number);
    }

    /** Advances the time, running due timers in order */
    advance(ms: number) {
        const end = this.time + ms;
        for (;;) {
            let due: { id: number; next: number } | null = null;
            for (const [id, timer] of this.timers) {
                if (timer.next <= end && (!due || timer.next < due.next)) {
                    due = { id, next: timer.next };
                }
            }
            if (!due) {
                break;
            }
            const timer = this.timers.get(due.id)!;
            this.time = timer.next;
            timer.next += timer.ms;
            timer.callback();
        }
        this.time = end;
    }
}

export interface TestServer extends CoopServer {
    url: string;
    httpUrl: string;
    dbPath: string;
}

export function tempDbPath() {
    return join(mkdtempSync(join(tmpdir(), "tvarovna-test-")), "test.db");
}

export async function startServer(options: Partial<ServerOptions> = {}): Promise<TestServer> {
    const dbPath = options.dbPath ?? tempDbPath();
    const server = await createServer({ logLevel: "silent", ...options, dbPath });
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { ...server, url: `ws://127.0.0.1:${port}/ws`, httpUrl: `http://127.0.0.1:${port}`, dbPath };
}

export async function createWorld(server: TestServer, body: object = {}) {
    const res = await fetch(`${server.httpUrl}/api/worlds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Test", startMode: "fresh", ...body }),
    });
    return (await res.json()) as { world: { id: string }; inviteKey: string; path: string };
}

/**
 * Bare WebSocket client speaking the protocol, without the game
 */
export class Bot {
    readonly ws: WebSocket;
    readonly messages: ServerMessage[] = [];
    private waiters: Array<() => void> = [];
    closed = false;

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.on("message", data => {
            this.messages.push(decode(data as Buffer) as ServerMessage);
            this.notify();
        });
        ws.on("close", () => {
            this.closed = true;
            this.notify();
        });
    }

    static async connect(url: string): Promise<Bot> {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            ws.once("open", () => resolve());
            ws.once("error", reject);
        });
        return new Bot(ws);
    }

    static async join(
        server: TestServer,
        world: { world: { id: string }; inviteKey: string },
        extra: Partial<Extract<ClientMessage, { t: "hello" }>> = {}
    ) {
        const bot = await Bot.connect(server.url);
        bot.send({
            t: "hello",
            worldId: world.world.id,
            inviteKey: world.inviteKey,
            name: "bot",
            clientVersion: `${PROTOCOL_VERSION}/test`,
            ...extra,
        });
        await bot.waitFor(m => m.t === "welcome" || m.t === "error");
        return bot;
    }

    private notify() {
        const waiters = this.waiters;
        this.waiters = [];
        waiters.forEach(w => w());
    }

    send(message: ClientMessage) {
        this.ws.send(encode(message));
    }

    get welcome() {
        return this.messages.find(m => m.t === "welcome") as
            | Extract<ServerMessage, { t: "welcome" }>
            | undefined;
    }

    get turns() {
        return this.messages.filter(m => m.t === "turn") as Array<Extract<ServerMessage, { t: "turn" }>>;
    }

    of<T extends ServerMessage["t"]>(type: T) {
        return this.messages.filter(m => m.t === type) as Array<Extract<ServerMessage, { t: T }>>;
    }

    /** Waits until a message matching the predicate was received */
    async waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<ServerMessage> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const found = this.messages.find(predicate);
            if (found) {
                return found;
            }
            if (this.closed || Date.now() > deadline) {
                throw new Error(
                    "Timeout waiting for message, got: " + JSON.stringify(this.messages.map(m => m.t))
                );
            }
            await new Promise<void>(resolve => {
                this.waiters.push(resolve);
                setTimeout(resolve, 50);
            });
        }
    }

    /** Round trip to make sure the server processed everything sent before */
    async sync() {
        const time = Math.random();
        this.send({ t: "ping", time });
        await this.waitFor(m => m.t === "pong" && m.time === time);
    }

    close() {
        this.ws.close();
    }
}
