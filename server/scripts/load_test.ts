/**
 * Load test (layer 8): many worlds with many bots sending actions.
 * Measures how regular the turns arrive (jitter against the 100 ms clock),
 * how long an action takes until it is part of a turn, and the memory.
 *
 *   npm run bots                                  # in-process server, 50 worlds x 10 bots, 60 s
 *   WORLDS=5 BOTS=3 DURATION_S=10 npm run bots    # quick run
 *   SERVER_URL=http://host:8080 npm run bots      # against a running server
 */
import { decode, encode } from "@msgpack/msgpack";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, TURN_MS, type ServerMessage } from "../../shared/protocol.ts";
import { createServer } from "../src/app.ts";
import { tempDbPath } from "../test/helpers.ts";

const WORLDS = Number(process.env.WORLDS ?? 50);
const BOTS = Number(process.env.BOTS ?? 10);
const DURATION_S = Number(process.env.DURATION_S ?? 60);
const ACTIONS_PER_S = Number(process.env.ACTIONS_PER_S ?? 2);
const MAX_JITTER_P99_MS = Number(process.env.MAX_JITTER_P99_MS ?? 20);

function percentile(values: number[], p: number) {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
    let baseUrl = process.env.SERVER_URL;
    let close: (() => Promise<void>) | null = null;
    if (!baseUrl) {
        const server = await createServer({ dbPath: tempDbPath(), logLevel: "warn" });
        await server.app.listen({ port: 0, host: "127.0.0.1" });
        const address = server.app.server.address();
        baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        close = () => server.close();
    }
    const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";
    console.log(
        `Load test: ${WORLDS} worlds x ${BOTS} bots, ${DURATION_S} s, ${ACTIONS_PER_S} actions/s per bot`
    );

    const jitter: number[] = [];
    const actionLatency: number[] = [];
    const sockets: WebSocket[] = [];
    let actionsSent = 0;
    let turnsReceived = 0;
    const rssStart = process.memoryUsage().rss;

    for (let w = 0; w < WORLDS; ++w) {
        const res = await fetch(`${baseUrl}/api/worlds`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                name: "load-" + w,
                startMode: "fresh",
                password: process.env.SERVER_PASSWORD,
            }),
        });
        const world = (await res.json()) as { world: { id: string }; inviteKey: string };

        for (let b = 0; b < BOTS; ++b) {
            const ws = new WebSocket(wsUrl);
            sockets.push(ws);
            const sentAt = new Map<number, number>();
            let lastTurnAt = 0;
            let playerId = 0;
            let seq = Date.now() * 1000 + b;

            ws.on("open", () => {
                ws.send(
                    encode({
                        t: "hello",
                        worldId: world.world.id,
                        inviteKey: world.inviteKey,
                        name: `bot${w}-${b}`,
                        clientVersion: `${PROTOCOL_VERSION}/load-test`,
                        password: process.env.SERVER_PASSWORD,
                    })
                );
            });
            ws.on("message", data => {
                const message = decode(data as Buffer) as ServerMessage;
                const now = performance.now();
                if (message.t === "welcome") {
                    playerId = message.playerId;
                } else if (message.t === "turn") {
                    turnsReceived++;
                    // Only measure the first bot of each world, the others see the same
                    if (b === 0 && lastTurnAt > 0) {
                        jitter.push(Math.abs(now - lastTurnAt - TURN_MS));
                    }
                    lastTurnAt = now;
                    for (const action of message.actions) {
                        if (action.playerId === playerId && sentAt.has(action.clientSeq)) {
                            actionLatency.push(now - sentAt.get(action.clientSeq)!);
                            sentAt.delete(action.clientSeq);
                        }
                    }
                }
            });

            const timer = setInterval(() => {
                if (ws.readyState !== ws.OPEN) {
                    return;
                }
                const clientSeq = ++seq;
                sentAt.set(clientSeq, performance.now());
                actionsSent++;
                ws.send(
                    encode({
                        t: "action",
                        clientSeq,
                        type: "placeBuilding",
                        payload: {
                            x: Math.floor(Math.random() * 40),
                            y: Math.floor(Math.random() * 40),
                            building: "belt",
                            variant: "default",
                            rotation: 0,
                            tunnelSmartplace: true,
                        },
                    })
                );
            }, 1000 / ACTIONS_PER_S);
            ws.on("close", () => clearInterval(timer));
        }
    }

    await new Promise(r => setTimeout(r, DURATION_S * 1000));
    sockets.forEach(ws => ws.close());
    await new Promise(r => setTimeout(r, 500));

    const rssEnd = process.memoryUsage().rss;
    const report = {
        worlds: WORLDS,
        bots: WORLDS * BOTS,
        actionsSent,
        turnsReceived,
        turnJitterMs: {
            p50: +percentile(jitter, 50).toFixed(2),
            p99: +percentile(jitter, 99).toFixed(2),
            max: +Math.max(0, ...jitter).toFixed(2),
        },
        actionToTurnMs: {
            p50: +percentile(actionLatency, 50).toFixed(1),
            p99: +percentile(actionLatency, 99).toFixed(1),
        },
        rssMb: close ? { start: Math.round(rssStart / 1e6), end: Math.round(rssEnd / 1e6) } : "remote server",
    };
    console.log(JSON.stringify(report, null, 2));
    await close?.();

    if (report.turnJitterMs.p99 > MAX_JITTER_P99_MS) {
        console.error(`Turn jitter p99 ${report.turnJitterMs.p99} ms exceeds ${MAX_JITTER_P99_MS} ms`);
        process.exit(1);
    }
}

await main();
