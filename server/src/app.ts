import fastifyStatic from "@fastify/static";
import { decode, encode } from "@msgpack/msgpack";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
    MAX_MESSAGE_BYTES,
    PROTOCOL_VERSION,
    SNAPSHOT_INTERVAL_TURNS,
    START_LEVELS,
    type ClientMessage,
    type ServerMessage,
    type StartMode,
} from "../../shared/protocol.ts";
import { systemClock, type Clock } from "./clock.ts";
import { Store } from "./db.ts";
import type { Peer } from "./room.ts";
import { Rooms } from "./rooms.ts";

export interface ServerOptions {
    dbPath: string;
    /** Link to the source code, shown in the game (GPL) */
    sourceUrl?: string;
    /** Directory with the built game, optional (API only without it) */
    staticDir?: string;
    password?: string;
    buildId?: string;
    snapshotIntervalTurns?: number;
    clock?: Clock;
    logLevel?: string;
}

const HELLO_TIMEOUT_MS = 10_000;

export interface CoopServer {
    app: FastifyInstance;
    store: Store;
    rooms: Rooms;
    close(): Promise<void>;
}

export async function createServer(options: ServerOptions): Promise<CoopServer> {
    const app = Fastify({
        logger: { level: options.logLevel ?? "info" },
        bodyLimit: 64 * 1024,
        trustProxy: true,
    });

    const store = new Store(options.dbPath);
    const clock = options.clock ?? systemClock;
    const rooms = new Rooms(
        store,
        clock,
        {
            buildId: options.buildId ?? "",
            password: options.password ?? "",
            snapshotIntervalTurns: options.snapshotIntervalTurns ?? SNAPSHOT_INTERVAL_TURNS,
        },
        app.log
    );
    const sweepTimer = setInterval(() => rooms.sweep(), 60_000);

    /////////////////// HTTP API ///////////////////

    app.get("/healthz", async () => ({
        ok: true,
        protocol: PROTOCOL_VERSION,
        build: options.buildId ?? "",
        worlds: store.countWorlds(),
        loadedWorlds: rooms.loadedCount,
        onlinePlayers: rooms.onlinePlayers,
    }));

    app.get("/api/config", async () => ({
        passwordRequired: Boolean(options.password),
        sourceUrl: options.sourceUrl ?? "",
        protocol: PROTOCOL_VERSION,
    }));

    app.post<{ Body: { name?: string; startMode?: string; password?: string } }>(
        "/api/worlds",
        async (req, reply) => {
            const body = req.body ?? {};
            if (options.password && body.password !== options.password) {
                return reply.code(403).send({ error: "invalid_password" });
            }
            const startMode = (body.startMode ?? "fresh") as StartMode;
            if (!Object.hasOwn(START_LEVELS, startMode)) {
                return reply.code(400).send({ error: "invalid_start_mode" });
            }
            const { meta, inviteKey } = rooms.createWorld({ name: body.name ?? "", startMode });
            return { world: meta, inviteKey, path: `/w/${meta.id}?k=${inviteKey}` };
        }
    );

    app.get<{ Params: { id: string }; Querystring: { k?: string } }>(
        "/api/worlds/:id",
        async (req, reply) => {
            const room = rooms.get(req.params.id);
            if (!room || room.world.inviteKey !== req.query.k) {
                return reply.code(404).send({ error: "world_not_found" });
            }
            return { world: room.getMeta(), onlinePlayers: room.onlineCount, running: room.isRunning };
        }
    );

    /////////////////// STATIC FILES ///////////////////

    if (options.staticDir && existsSync(options.staticDir)) {
        const root = resolve(options.staticDir);
        const indexHtml = readFileSync(join(root, "index.html"), "utf-8");
        // The page URL changes to /w/<id> when joining, relative asset paths need a base
        const worldIndexHtml = indexHtml.replace("<head>", '<head><base href="/">');

        await app.register(fastifyStatic, {
            root,
            // index.html is served by the routes below
            index: false,
            setHeaders(res, path) {
                // Assets keep their names between builds, always revalidate the code
                if (/\.(html|js|css|json)$/.test(path)) {
                    res.setHeader("Cache-Control", "no-cache");
                } else {
                    res.setHeader("Cache-Control", "public, max-age=86400");
                }
            },
        });

        const sendIndex = async (_req: unknown, reply: import("fastify").FastifyReply) =>
            reply.header("Cache-Control", "no-cache").type("text/html; charset=utf-8").send(worldIndexHtml);
        app.get("/", sendIndex);
        app.get("/index.html", sendIndex);
        app.get("/w/:id", sendIndex);
    }

    /////////////////// WEBSOCKET ///////////////////

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

    app.server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/ws") {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => handleConnection(ws));
    });

    function handleConnection(ws: WebSocket) {
        const peer: Peer = {
            send(message: ServerMessage) {
                if (ws.readyState === ws.OPEN) {
                    ws.send(encode(message, { ignoreUndefined: true }));
                }
            },
            close(code?: number, reason?: string) {
                ws.close(code, reason);
            },
        };

        let room: ReturnType<Rooms["get"]> = null;
        const helloTimeout = setTimeout(() => ws.close(4002, "no hello"), HELLO_TIMEOUT_MS);

        ws.on("message", (raw, isBinary) => {
            const buffer = raw as Buffer;
            let message: ClientMessage;
            try {
                if (!isBinary) {
                    throw new Error("Text frames are not supported");
                }
                message = decode(buffer) as ClientMessage;
                if (!message || typeof message !== "object" || typeof message.t !== "string") {
                    throw new Error("Invalid message");
                }
            } catch {
                peer.send({ t: "error", code: "bad_request", message: "Malformed message" });
                return;
            }

            if (!room) {
                if (message.t !== "hello") {
                    peer.send({ t: "error", code: "bad_request", message: "Expected hello" });
                    return;
                }
                clearTimeout(helloTimeout);
                const candidate = rooms.get(String(message.worldId));
                if (!candidate) {
                    peer.send({ t: "error", code: "world_not_found", message: "World not found" });
                    ws.close(4000, "world_not_found");
                    return;
                }
                if (candidate.join(peer, message)) {
                    room = candidate;
                }
                return;
            }

            try {
                room.handleMessage(peer, message, buffer.byteLength);
            } catch (err) {
                app.log.error({ err }, "failed to handle message");
                peer.send({ t: "error", code: "internal", message: "Internal error" });
            }
        });

        ws.on("close", () => {
            clearTimeout(helloTimeout);
            room?.leave(peer);
        });
        ws.on("error", err => app.log.warn({ err }, "websocket error"));
    }

    return {
        app,
        store,
        rooms,
        async close() {
            clearInterval(sweepTimer);
            rooms.shutdown();
            for (const client of wss.clients) {
                client.terminate();
            }
            wss.close();
            await app.close();
            store.close();
        },
    };
}
