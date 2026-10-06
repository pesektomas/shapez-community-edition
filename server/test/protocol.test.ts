import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Bot, createWorld, FakeClock, startServer, type TestServer } from "./helpers.ts";

const servers: TestServer[] = [];
after(async () => {
    for (const server of servers) {
        await server.close().catch(() => {});
    }
});

/** Small seeded PRNG so failures can be reproduced */
function mulberry32(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe("Protocol with bots", () => {
    it("delivers identical turns to 10 bots sending actions concurrently", async () => {
        const clock = new FakeClock();
        const server = await startServer({ clock });
        servers.push(server);
        const world = await createWorld(server);

        const bots: Bot[] = [];
        for (let i = 0; i < 10; ++i) {
            bots.push(await Bot.join(server, world, { name: "bot" + i }));
        }

        const random = mulberry32(Number(process.env.SEED ?? 1234));
        const TURNS = 50;
        for (let turn = 0; turn < TURNS; ++turn) {
            for (const [i, bot] of bots.entries()) {
                if (random() < 0.5) {
                    bot.send({
                        t: "action",
                        clientSeq: turn,
                        type: "deleteBuildings",
                        payload: { uids: [i, turn] },
                    });
                }
            }
            await Promise.all(bots.map(b => b.sync()));
            clock.advance(100);
        }
        await Promise.all(bots.map(b => b.waitFor(m => m.t === "turn" && m.n === TURNS - 1)));

        const reference = JSON.stringify(bots[0].turns);
        for (const bot of bots) {
            assert.equal(JSON.stringify(bot.turns), reference);
        }
        const total = bots[0].turns.reduce((sum, t) => sum + t.actions.length, 0);
        assert.ok(total > 100, "expected many actions, got " + total);

        // A late joiner gets the same turns from the action log (the world is full, make room)
        bots.pop()!.close();
        await new Promise(r => setTimeout(r, 30));
        const late = await Bot.join(server, world);
        const fromLog = late.welcome!.turns;
        assert.deepEqual(
            fromLog,
            bots[0].turns.filter(t => t.actions.length > 0).map(({ n, actions }) => ({ n, actions }))
        );
        [...bots, late].forEach(b => b.close());
    });

    it("does not lose turns across a reconnect", async () => {
        const clock = new FakeClock();
        const server = await startServer({ clock });
        servers.push(server);
        const world = await createWorld(server);
        const stay = await Bot.join(server, world);
        let flaky = await Bot.join(server, world);
        const token = flaky.welcome!.playerToken;

        const seen = new Map<number, string>();
        const record = (bot: Bot) => bot.turns.forEach(t => seen.set(t.n, JSON.stringify(t.actions)));

        for (let round = 0; round < 3; ++round) {
            stay.send({
                t: "action",
                clientSeq: round * 2,
                type: "toggleLever",
                payload: { uid: round },
            });
            await stay.sync();
            clock.advance(300);
            await flaky.waitFor(m => m.t === "turn" && m.n === stay.turns[stay.turns.length - 1]?.n);
            record(flaky);
            const lastSeen = Math.max(...seen.keys());
            flaky.close();
            await new Promise(r => setTimeout(r, 30));

            // Turns happen while disconnected
            stay.send({
                t: "action",
                clientSeq: round * 2 + 1,
                type: "toggleLever",
                payload: { uid: 100 + round },
            });
            await stay.sync();
            clock.advance(200);
            await stay.sync();

            flaky = await Bot.join(server, world, { playerToken: token, resumeFromTurn: lastSeen + 1 });
            const welcome = flaky.welcome!;
            assert.equal(welcome.resumed, true);
            for (let n = welcome.startTurn; n < welcome.nextTurn; ++n) {
                const turn = welcome.turns.find(t => t.n === n);
                seen.set(n, JSON.stringify(turn ? turn.actions : []));
            }
        }

        clock.advance(100);
        await flaky.waitFor(m => m.t === "turn");
        record(flaky);
        await stay.sync();

        // The resumed bot knows every turn exactly as the bot which stayed
        const lastTurn = Math.max(...seen.keys());
        for (let n = 0; n <= lastTurn; ++n) {
            const expected = stay.turns.find(t => t.n === n);
            assert.equal(seen.get(n), JSON.stringify(expected ? expected.actions : []), "turn " + n);
        }
        stay.close();
        flaky.close();
    });
});
