import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { MAX_PLAYERS_PER_WORLD, type ServerMessage } from "../../shared/protocol.ts";
import { Bot, createWorld, FakeClock, startServer, type TestServer } from "./helpers.ts";

const servers: TestServer[] = [];
async function setup(options: Parameters<typeof startServer>[0] = {}) {
    const clock = new FakeClock();
    const server = await startServer({ clock, ...options });
    servers.push(server);
    return { server, clock };
}

after(async () => {
    for (const server of servers) {
        await server.close().catch(() => {});
    }
});

const place = (x: number) => ({
    type: "placeBuilding" as const,
    payload: { x, y: 0, building: "belt", variant: "default", rotation: 0, tunnelSmartplace: true },
});

describe("HTTP API", () => {
    it("creates worlds and returns metadata only with the invite key", async () => {
        const { server } = await setup();
        const created = await createWorld(server, { name: "Hrátky", startMode: "quick" });
        assert.match(created.inviteKey, /^[A-Za-z0-9_-]{22}$/);
        assert.equal(created.path, `/w/${created.world.id}?k=${created.inviteKey}`);

        const ok = await fetch(`${server.httpUrl}/api/worlds/${created.world.id}?k=${created.inviteKey}`);
        const meta = (await ok.json()) as { world: { name: string; params: { startLevel: number } } };
        assert.equal(meta.world.name, "Hrátky");
        assert.equal(meta.world.params.startLevel, 7);

        const denied = await fetch(`${server.httpUrl}/api/worlds/${created.world.id}?k=wrong`);
        assert.equal(denied.status, 404);
    });

    it("requires the server password when configured", async () => {
        const { server } = await setup({ password: "secret" });
        const res = await fetch(`${server.httpUrl}/api/worlds`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ startMode: "fresh" }),
        });
        assert.equal(res.status, 403);
        const created = await createWorld(server, { password: "secret" });
        assert.ok(created.world.id);
    });

    it("reports health", async () => {
        const { server } = await setup();
        const res = await fetch(`${server.httpUrl}/healthz`);
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as { ok: boolean }).ok, true);
    });
});

describe("Joining", () => {
    it("rejects invalid invite keys and versions", async () => {
        const { server } = await setup({ buildId: "abc" });
        const world = await createWorld(server);

        const badKey = await Bot.join(server, { ...world, inviteKey: "nope" }, { clientVersion: "1/abc" });
        assert.equal(badKey.of("error")[0].code, "invalid_invite");

        const badVersion = await Bot.join(server, world, { clientVersion: "1/old" });
        assert.equal(badVersion.of("error")[0].code, "version_mismatch");

        const ok = await Bot.join(server, world, { clientVersion: "1/abc" });
        assert.ok(ok.welcome);
        ok.close();
    });

    it("limits the number of players", async () => {
        const { server } = await setup();
        const world = await createWorld(server);
        const bots = [];
        for (let i = 0; i < MAX_PLAYERS_PER_WORLD; ++i) {
            bots.push(await Bot.join(server, world));
        }
        const extra = await Bot.join(server, world);
        assert.equal(extra.of("error")[0].code, "world_full");
        bots.forEach(b => b.close());
    });

    it("keeps the player identity with the player token", async () => {
        const { server } = await setup();
        const world = await createWorld(server);
        const first = await Bot.join(server, world, { name: "Pavel" });
        const { playerId, playerToken, color } = first.welcome!;
        first.close();
        await new Promise(r => setTimeout(r, 50));

        const again = await Bot.join(server, world, { name: "Pavel 2", playerToken });
        assert.equal(again.welcome!.playerId, playerId);
        assert.equal(again.welcome!.color, color);
        assert.equal(again.welcome!.players.find(p => p.id === playerId)!.name, "Pavel 2");
        again.close();
    });
});

describe("Turns", () => {
    it("closes a turn every 100 ms with the actions in arrival order", async () => {
        const { server, clock } = await setup();
        const world = await createWorld(server);
        const a = await Bot.join(server, world);
        const b = await Bot.join(server, world);

        a.send({ t: "action", clientSeq: 1, ...place(1) });
        await a.sync();
        b.send({ t: "action", clientSeq: 1, ...place(2) });
        await b.sync();
        a.send({ t: "action", clientSeq: 2, ...place(3) });
        await a.sync();

        clock.advance(99);
        await a.sync();
        assert.equal(a.turns.length, 0, "turn closed too early");

        clock.advance(1);
        await a.waitFor(m => m.t === "turn");
        await b.waitFor(m => m.t === "turn");

        for (const bot of [a, b]) {
            const [turn] = bot.turns;
            assert.equal(turn.n, 0);
            assert.deepEqual(
                turn.actions.map(x => [x.playerId, x.clientSeq, (x.payload as { x: number }).x]),
                [
                    [a.welcome!.playerId, 1, 1],
                    [b.welcome!.playerId, 1, 2],
                    [a.welcome!.playerId, 2, 3],
                ]
            );
        }

        clock.advance(500);
        await a.waitFor(m => m.t === "turn" && m.n === 5);
        assert.deepEqual(
            a.turns.map(t => t.n),
            [0, 1, 2, 3, 4, 5]
        );
        a.close();
        b.close();
    });

    it("rejects malformed and unknown actions", async () => {
        const { server } = await setup();
        const world = await createWorld(server);
        const bot = await Bot.join(server, world);
        bot.send({ t: "action", clientSeq: 1, type: "launchRocket", payload: {} } as never);
        await bot.waitFor(m => m.t === "error");
        assert.equal(bot.of("error")[0].code, "bad_request");
        bot.close();
    });

    it("drops actions which were resent after a reconnect", async () => {
        const { server, clock } = await setup();
        const world = await createWorld(server);
        const bot = await Bot.join(server, world);
        bot.send({ t: "action", clientSeq: 5, ...place(1) });
        bot.send({ t: "action", clientSeq: 5, ...place(1) });
        bot.send({ t: "action", clientSeq: 4, ...place(1) });
        bot.send({ t: "action", clientSeq: 6, ...place(2) });
        await bot.sync();
        clock.advance(100);
        const turn = (await bot.waitFor(m => m.t === "turn")) as { actions: Array<{ clientSeq: number }> };
        assert.deepEqual(
            turn.actions.map(a => a.clientSeq),
            [5, 6]
        );
        bot.close();
    });

    it("rate limits actions", async () => {
        const { server } = await setup();
        const world = await createWorld(server);
        const bot = await Bot.join(server, world);
        for (let i = 0; i < 400; ++i) {
            bot.send({ t: "action", clientSeq: i, ...place(i) });
        }
        await bot.sync();
        assert.ok(bot.of("error").some(e => e.code === "rate_limited"));
        bot.close();
    });

    it("freezes the world when everybody left and continues at the same turn", async () => {
        const { server, clock } = await setup();
        const world = await createWorld(server);
        const bot = await Bot.join(server, world);
        clock.advance(1000);
        await bot.waitFor(m => m.t === "turn" && m.n === 9);
        bot.close();
        await new Promise(r => setTimeout(r, 50));

        const room = server.rooms.get(world.world.id)!;
        assert.equal(room.isRunning, false);
        clock.advance(10_000);
        assert.equal(room.nextTurn, 10, "turns advanced while frozen");

        const again = await Bot.join(server, world);
        assert.equal(again.welcome!.nextTurn, 10);
        again.close();
    });
});

describe("Persistence", () => {
    it("restores the world from the database after a restart", async () => {
        const clock = new FakeClock();
        const first = await startServer({ clock });
        const world = await createWorld(first);
        const bot = await Bot.join(first, world);
        clock.advance(100);
        bot.send({ t: "action", clientSeq: 1, ...place(7) });
        await bot.sync();
        clock.advance(200);
        await bot.waitFor(m => m.t === "turn" && m.n === 2);
        const actionTurn = bot.turns.find(t => t.actions.length > 0)!.n;

        // Crash: a second server opens the database while the first one never
        // shut down the room cleanly
        servers.push(first);
        const second = await startServer({ clock, dbPath: first.dbPath });
        servers.push(second);
        const late = await Bot.join(second, world);
        const welcome = late.welcome!;
        assert.equal(welcome.snapshot, null);
        assert.equal(welcome.startTurn, 0);
        assert.ok(welcome.nextTurn > 2, "turn numbers must not be reused after a crash");
        assert.deepEqual(
            welcome.turns.map(t => t.n),
            [actionTurn]
        );
        assert.equal((welcome.turns[0].actions[0].payload as { x: number }).x, 7);
        late.close();
    });

    it("joins from the latest snapshot and prunes old data", async () => {
        const { server, clock } = await setup();
        const world = await createWorld(server);
        const leader = await Bot.join(server, world);

        for (let i = 0; i < 5; ++i) {
            leader.send({ t: "action", clientSeq: i, ...place(i) });
            await leader.sync();
            clock.advance(100);
            // A snapshot of turn n is taken before the actions of turn n are applied,
            // so the client always knows turn n already
            const turn = i;
            leader.send({ t: "snapshot", turn, data: new Uint8Array([turn]), hash: "h" + turn });
            await leader.sync();
        }
        clock.advance(100);
        await leader.sync();

        const late = await Bot.join(server, world);
        const welcome = late.welcome!;
        assert.equal(welcome.snapshot!.turn, 4);
        assert.deepEqual([...welcome.snapshot!.data], [4]);
        assert.equal(welcome.startTurn, 4);
        assert.deepEqual(
            welcome.turns.map(t => t.n),
            [4]
        );

        // Only 3 snapshots are kept and the action log before them is gone
        const remaining = server.store.getTurns(world.world.id, 0, 100).map(t => t.n);
        assert.deepEqual(remaining, [2, 3, 4]);
        leader.close();
        late.close();
    });

    it("ignores snapshots from players who are not the leader", async () => {
        const { server, clock } = await setup();
        const world = await createWorld(server);
        const leader = await Bot.join(server, world);
        const other = await Bot.join(server, world);
        clock.advance(300);
        other.send({ t: "snapshot", turn: 2, data: new Uint8Array([9]), hash: "x" });
        await other.sync();
        assert.equal(server.store.getLatestSnapshot(world.world.id), null);
        leader.close();
        other.close();
    });
});

describe("Desync handling", () => {
    it("detects a minority hash and resyncs it from the leader's snapshot", async () => {
        const { server, clock } = await setup();
        const world = await createWorld(server);
        const leader = await Bot.join(server, world);
        const good = await Bot.join(server, world);
        const bad = await Bot.join(server, world);

        clock.advance(5100);
        await leader.waitFor(m => m.t === "turn" && m.n === 50);

        leader.send({ t: "hash", turn: 50, hash: "aaaa" });
        good.send({ t: "hash", turn: 50, hash: "aaaa" });
        bad.send({ t: "hash", turn: 50, hash: "bbbb" });
        await Promise.all([leader.sync(), good.sync(), bad.sync()]);

        const request = (await leader.waitFor(m => m.t === "requestSnapshot")) as Extract<
            ServerMessage,
            { t: "requestSnapshot" }
        >;
        assert.equal(good.of("requestSnapshot").length, 0);
        await bad.waitFor(m => m.t === "notice" && m.kind === "desync");

        clock.advance((request.turn - 50) * 100 + 100);
        await leader.sync();
        leader.send({ t: "snapshot", turn: request.turn, data: new Uint8Array([1, 2, 3]), hash: "aaaa" });
        await leader.sync();

        const resync = (await bad.waitFor(m => m.t === "resync")) as Extract<ServerMessage, { t: "resync" }>;
        assert.equal(resync.snapshot.turn, request.turn);
        assert.equal(resync.startTurn, request.turn);
        assert.equal(good.of("resync").length, 0);
        [leader, good, bad].forEach(b => b.close());
    });

    it("resolves a tie in favor of the leader", async () => {
        const { server, clock } = await setup();
        const world = await createWorld(server);
        const leader = await Bot.join(server, world);
        const other = await Bot.join(server, world);
        clock.advance(5100);
        await other.waitFor(m => m.t === "turn" && m.n === 50);

        leader.send({ t: "hash", turn: 50, hash: "aaaa" });
        other.send({ t: "hash", turn: 50, hash: "bbbb" });
        await Promise.all([leader.sync(), other.sync()]);
        await leader.waitFor(m => m.t === "requestSnapshot");
        await other.waitFor(m => m.t === "notice" && m.kind === "desync");
        leader.close();
        other.close();
    });
});

describe("Reconnect", () => {
    it("resumes a session with only the missing turns", async () => {
        const { server, clock } = await setup();
        const world = await createWorld(server);
        const stay = await Bot.join(server, world);
        const flaky = await Bot.join(server, world);
        const { playerToken } = flaky.welcome!;

        clock.advance(300);
        await flaky.waitFor(m => m.t === "turn" && m.n === 2);
        flaky.close();
        await new Promise(r => setTimeout(r, 50));

        stay.send({ t: "action", clientSeq: 1, ...place(42) });
        await stay.sync();
        clock.advance(500);
        await stay.waitFor(m => m.t === "turn" && m.n === 7);

        const back = await Bot.join(server, world, { playerToken, resumeFromTurn: 3 });
        const welcome = back.welcome!;
        assert.equal(welcome.resumed, true);
        assert.equal(welcome.snapshot, null);
        assert.equal(welcome.startTurn, 3);
        assert.equal(welcome.nextTurn, 8);
        assert.deepEqual(
            welcome.turns.map(t => t.n),
            [3]
        );
        stay.close();
        back.close();
    });
});
