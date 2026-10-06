import { expect, test } from "@playwright/test";
import {
    createWorldApi,
    dispatch,
    expectInSync,
    getNetInfo,
    joinAsPlayer,
    mulberry32,
    randomActivity,
} from "../helpers/mp.ts";
import { startCoopServer, type CoopServerProcess } from "../helpers/server.ts";

/**
 * Layer 7: real server, real clients. Durations are short on PRs and can be
 * raised for nightly runs with MP_DURATION_S.
 */
const DURATION_MS = Number(process.env.MP_DURATION_S ?? 20) * 1000;

test.describe.configure({ mode: "serial" });

let server: CoopServerProcess;

test.beforeAll(async () => {
    // Snapshots every 10 s, so late joiners load a snapshot in short tests
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

test("1: concurrent building by 3 players stays in sync", async ({ browser }) => {
    test.setTimeout(DURATION_MS + 180_000);
    const world = await createWorldApi(server.baseURL, "quick");
    const players = [];
    for (const name of ["Anna", "Bob", "Cyril"]) {
        players.push(await joinAsPlayer(browser, world.url, name));
    }
    const pages = players.map(p => p.page);

    const end = Date.now() + DURATION_MS;
    const randoms = pages.map((_, i) => mulberry32(1000 + i));
    while (Date.now() < end) {
        await Promise.all(pages.map((page, i) => randomActivity(page, randoms[i])));
        await pages[0].waitForTimeout(150);
    }

    const lastTurn = Math.max(...(await Promise.all(pages.map(getNetInfo))).map(i => i.latestTurn));
    await expectInSync(pages, lastTurn + 10);

    const counts = await Promise.all(pages.map(getNetInfo));
    expect(counts[0].entities).toBeGreaterThan(5);
    expect(players.flatMap(p => p.errors)).toEqual([]);
    await Promise.all(players.map(p => p.context.close()));
});

test("2: a late joiner catches up from the snapshot and matches", async ({ browser }) => {
    test.setTimeout(DURATION_MS + 180_000);
    const world = await createWorldApi(server.baseURL, "fresh");
    const first = await joinAsPlayer(browser, world.url, "Early");
    const second = await joinAsPlayer(browser, world.url, "Bird");

    // Build a working line, so the snapshot contains items on belts and in the hub
    await dispatch(first.page, [
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

    const random = mulberry32(7);
    const end = Date.now() + Math.max(DURATION_MS, 15_000);
    while (Date.now() < end) {
        await randomActivity(second.page, random);
        await second.page.waitForTimeout(300);
    }

    // At least one snapshot (every 100 turns) exists by now
    const late = await joinAsPlayer(browser, world.url, "Late");
    const lateInfo = await getNetInfo(late.page);
    expect(lateInfo.turn).toBeGreaterThan(100);

    const pages = [first.page, second.page, late.page];
    await expectInSync(pages, lateInfo.latestTurn + 10);
    expect([...first.errors, ...second.errors, ...late.errors]).toEqual([]);
    expect(server.logs.join("")).toContain("snapshot stored");
    await Promise.all([first, second, late].map(p => p.context.close()));
});
