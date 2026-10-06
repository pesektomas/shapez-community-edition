import { expect, type Browser, type Page } from "@playwright/test";
import type { Action } from "../../shared/protocol.ts";

export async function createWorldApi(baseURL: string, startMode = "fresh", name = "E2E") {
    const res = await fetch(`${baseURL}/api/worlds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, startMode }),
    });
    const data = (await res.json()) as { world: { id: string }; inviteKey: string; path: string };
    return { ...data, url: baseURL + data.path };
}

/**
 * Opens the invite link in a new browser context and joins like a player would
 */
export async function joinAsPlayer(browser: Browser, url: string, name: string) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", err => errors.push(err.message));
    await page.goto(url);
    await page.locator(".joinPanel input.nickname").fill(name, { timeout: 120_000 });
    await page.locator(".joinButton").click();
    await waitInGame(page);
    return { page, context, errors };
}

export async function waitInGame(page: Page, timeout = 120_000) {
    await page.waitForFunction(
        () => {
            const api = (window as any).__coop;
            try {
                return document.body.id === "state_InGameState" && api && api.getNetInfo().turn >= 0;
            } catch {
                return false;
            }
        },
        null,
        { timeout }
    );
}

export async function getNetInfo(page: Page) {
    return page.evaluate(() => (window as any).__coop.getNetInfo());
}

export async function dispatch(page: Page, actions: Action[]) {
    await page.evaluate(actions => {
        for (const action of actions) {
            (window as any).__coop.dispatch(action);
        }
    }, actions);
}

/**
 * Waits until all pages computed a state hash for a common turn at or after
 * minTurn, and returns the hashes of that turn
 */
export async function waitForCommonHash(pages: Page[], minTurn: number, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const histories = await Promise.all(
            pages.map(page =>
                page.evaluate(() => (window as any).__coop.getHashHistory() as Record<string, string>)
            )
        );
        const common = Object.keys(histories[0])
            .map(Number)
            .filter(turn => turn >= minTurn && histories.every(h => h[turn] !== undefined))
            .sort((a, b) => b - a);
        if (common.length > 0) {
            const turn = common[0];
            return { turn, hashes: histories.map(h => h[turn]) };
        }
        if (Date.now() > deadline) {
            throw new Error(
                "No common hash turn >= " + minTurn + ": " + JSON.stringify(histories.map(Object.keys))
            );
        }
        await new Promise(r => setTimeout(r, 500));
    }
}

export async function expectInSync(pages: Page[], minTurn: number) {
    const { turn, hashes } = await waitForCommonHash(pages, minTurn);
    expect(new Set(hashes).size, `hashes at turn ${turn}: ${hashes.join(", ")}`).toBe(1);
    return turn;
}

/** Seeded PRNG for reproducible random actions */
export function mulberry32(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const BUILDINGS: Array<[string, string]> = [
    ["belt", "default"],
    ["belt", "default"],
    ["belt", "default"],
    ["miner", "default"],
    ["cutter", "default"],
    ["trash", "default"],
    ["balancer", "default"],
    ["underground_belt", "default"],
];

/**
 * Random building activity of one player in an area overlapping the others
 */
export async function randomActivity(page: Page, random: () => number) {
    const x = Math.floor(random() * 24) - 12;
    const y = Math.floor(random() * 24) - 4;
    const roll = random();
    if (roll < 0.7) {
        const [building, variant] = BUILDINGS[Math.floor(random() * BUILDINGS.length)];
        const rotation = [0, 90, 180, 270][Math.floor(random() * 4)];
        await dispatch(page, [
            {
                type: "placeBuilding",
                payload: { x, y, building, variant, rotation, tunnelSmartplace: random() < 0.5 },
            },
        ]);
    } else {
        await page.evaluate(
            ({ x, y }) => {
                const api = (window as any).__coop;
                const uids = api.getUidsInArea({ x, y, w: 3, h: 3 });
                if (uids.length > 0) {
                    api.dispatch({ type: "deleteBuildings", payload: { uids } });
                }
            },
            { x, y }
        );
    }
}
