import { expect, test, type Page } from "@playwright/test";
import {
    createWorldApi,
    dispatch,
    expectInSync,
    getNetInfo,
    joinAsPlayer,
    mulberry32,
    randomActivity,
    waitInGame,
} from "../helpers/mp.ts";
import { startLatencyProxy } from "../helpers/latency_proxy.ts";
import { startCoopServer, type CoopServerProcess } from "../helpers/server.ts";

/**
 * Layer 7, scenarios 3-7: the multiplayer game recovers by itself from
 * network outages, desyncs, server restarts and bad connections.
 */
test.describe.configure({ mode: "serial" });

let server: CoopServerProcess;

test.beforeAll(async () => {
    server = await startCoopServer({ SNAPSHOT_INTERVAL_TURNS: "100" });
});

test.afterAll(async () => {
    await server?.stop();
});

test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("server-log", { body: server.logs.join(""), contentType: "text/plain" });
    }
});

async function buildSomething(page: Page, seed: number, steps = 20) {
    const random = mulberry32(seed);
    for (let i = 0; i < steps; ++i) {
        await randomActivity(page, random);
        await page.waitForTimeout(100);
    }
}

/** Marks the page, a reload would lose the marker */
async function markPage(page: Page) {
    await page.evaluate(() => ((window as any).__e2eMarker = 42));
}

async function isSamePage(page: Page) {
    return page.evaluate(() => (window as any).__e2eMarker === 42);
}

test("3: a client offline for 30 s catches up without reloading", async ({ browser }) => {
    test.setTimeout(240_000);
    const world = await createWorldApi(server.baseURL, "quick");
    const a = await joinAsPlayer(browser, world.url, "Online");
    const b = await joinAsPlayer(browser, world.url, "Offline");
    await markPage(b.page);

    await b.context.setOffline(true);
    await buildSomething(a.page, 3, 30);
    await a.page.waitForTimeout(30_000);
    const turnWhileOffline = (await getNetInfo(a.page)).latestTurn;
    await b.context.setOffline(false);

    // Back online: the client reconnects (or the browser delivers the queued
    // messages) and catches up, without reloading the page
    await expectInSync([a.page, b.page], turnWhileOffline + 20);
    expect(await isSamePage(b.page)).toBe(true);
    await Promise.all([a, b].map(p => p.context.close()));
});

test("4: a forced desync is detected and repaired", async ({ browser }) => {
    test.setTimeout(240_000);
    const world = await createWorldApi(server.baseURL, "quick");
    const players = [];
    for (const name of ["One", "Two", "Three"]) {
        players.push(await joinAsPlayer(browser, world.url, name));
    }
    const pages = players.map(p => p.page);
    await buildSomething(pages[0], 4, 10);

    const victim = pages[2];
    await victim.evaluate(() => (window as any).__coop.setFakeDesync());
    const corruptedAt = (await getNetInfo(victim)).turn;

    // The server notices at the next hash turn (every 5 s) and sends a snapshot
    await expect.poll(() => server.logs.join("").includes("desync detected"), { timeout: 20_000 }).toBe(true);
    await waitInGame(victim);
    await expectInSync(pages, corruptedAt + 100);
    expect(players.flatMap(p => p.errors)).toEqual([]);
    await Promise.all(players.map(p => p.context.close()));
});

test("5: the world survives a server crash", async ({ browser }) => {
    test.setTimeout(240_000);
    const world = await createWorldApi(server.baseURL, "quick");
    const a = await joinAsPlayer(browser, world.url, "Crash");
    const b = await joinAsPlayer(browser, world.url, "Test");
    await markPage(a.page);
    await buildSomething(a.page, 5, 20);
    await a.page.waitForTimeout(2000);
    const before = await getNetInfo(a.page);

    await server.kill();
    await a.page.waitForTimeout(3000);
    await server.start();

    // Clients reconnect on their own, resume their sessions and continue
    await expectInSync([a.page, b.page], before.latestTurn + 60);
    expect(await isSamePage(a.page)).toBe(true);
    expect(server.logs.join("")).toMatch(/"resumed":true/);
    const after = await getNetInfo(a.page);
    expect(after.entities).toBeGreaterThanOrEqual(before.entities - 0);

    // A new player gets the same state from the restored server
    const c = await joinAsPlayer(browser, world.url, "Newcomer");
    await expectInSync([a.page, b.page, c.page], (await getNetInfo(c.page)).latestTurn + 10);
    await Promise.all([a, b, c].map(p => p.context.close()));
});

test("6: when everybody leaves, the world freezes and continues at the same tick", async ({ browser }) => {
    test.setTimeout(240_000);
    const world = await createWorldApi(server.baseURL, "fresh");
    const a = await joinAsPlayer(browser, world.url, "Leaver");
    await dispatch(a.page, [
        {
            type: "placeBuilding",
            payload: {
                x: -2,
                y: 4,
                building: "miner",
                variant: "default",
                rotation: 0,
                tunnelSmartplace: true,
            },
        },
        {
            type: "placeBuilding",
            payload: {
                x: -2,
                y: 3,
                building: "belt",
                variant: "default",
                rotation: 0,
                tunnelSmartplace: true,
            },
        },
        {
            type: "placeBuilding",
            payload: {
                x: -2,
                y: 2,
                building: "belt",
                variant: "default",
                rotation: 0,
                tunnelSmartplace: true,
            },
        },
    ]);
    await a.page.waitForTimeout(12_000);
    const left = await a.page.evaluate(() => (window as any).__coop.getInfo());
    const leftTurn = (await getNetInfo(a.page)).latestTurn;
    await a.context.close();

    // Nobody is online for a while
    await new Promise(r => setTimeout(r, 5000));

    const b = await joinAsPlayer(browser, world.url, "Returner");
    const info = await getNetInfo(b.page);
    // The server stopped right after the last turn the client saw (+ the one in flight)
    expect(info.latestTurn - leftTurn).toBeLessThanOrEqual(20);
    const back = await b.page.evaluate(() => (window as any).__coop.getInfo());
    expect(back.timeSeconds).toBeGreaterThanOrEqual(left.timeSeconds - 0.1);
    expect(back.timeSeconds - left.timeSeconds).toBeLessThan(3);
    await b.context.close();
});

test("7: latency of 150 ms ± 100 ms keeps everybody in sync", async ({ browser }) => {
    test.setTimeout(240_000);
    const proxy = await startLatencyProxy(server.port, 150, 100);
    try {
        const world = await createWorldApi(server.baseURL, "quick");
        // Only the game connection goes through the proxy, the assets load directly
        const url = `${world.url}&ws=${encodeURIComponent(`ws://127.0.0.1:${proxy.port}/ws`)}`;
        const a = await joinAsPlayer(browser, url, "Slow");
        const b = await joinAsPlayer(browser, world.url, "Fast");
        const c = await joinAsPlayer(browser, url, "Slower");
        const pages = [a.page, b.page, c.page];

        const end = Date.now() + 20_000;
        const randoms = pages.map((_, i) => mulberry32(77 + i));
        while (Date.now() < end) {
            await Promise.all(pages.map((page, i) => randomActivity(page, randoms[i])));
            await a.page.waitForTimeout(200);
        }
        const last = Math.max(...(await Promise.all(pages.map(getNetInfo))).map(i => i.latestTurn));
        await expectInSync(pages, last + 10);
        await Promise.all([a, b, c].map(p => p.context.close()));
    } finally {
        await proxy.close();
    }
});
