import type { Page } from "@playwright/test";
import type { Scenario, ScenarioInfo } from "../scenarios/dsl.ts";

export interface ScenarioResult {
    checkpoints: Array<{ tick: number; hash: string }>;
    hash: string;
    info: ScenarioInfo;
}

/**
 * Opens the game and waits until the test hooks are available
 */
export async function openGame(page: Page) {
    const errors: string[] = [];
    page.on("pageerror", err => errors.push(err.message));
    await page.goto("/");
    await page.waitForFunction(
        () => (window as any).__coop && document.body.id === "state_MainMenuState",
        null,
        {
            timeout: 120_000,
        }
    );
    return errors;
}

export async function newWorld(page: Page, seed: number, startLevel: number) {
    await page.evaluate(({ seed, startLevel }) => (window as any).__coop.newWorld({ seed, startLevel }), {
        seed,
        startLevel,
    });
}

export async function runScenario(
    page: Page,
    scenario: Scenario,
    { toTurn = scenario.turns, checkpointEveryTicks = 1000 } = {}
): Promise<ScenarioResult> {
    return page.evaluate(
        ({ steps, toTurn, checkpointEveryTicks }) =>
            (window as any).__coop.runScenario({ steps, toTurn, checkpointEveryTicks }),
        { steps: scenario.steps, toTurn, checkpointEveryTicks }
    );
}

export async function getSnapshot(page: Page) {
    return page.evaluate(() => (window as any).__coop.getSnapshot());
}

export async function loadSnapshot(page: Page, snapshot: unknown) {
    await page.evaluate(snapshot => (window as any).__coop.loadSnapshot(snapshot), snapshot);
}

export async function dumpState(page: Page) {
    return page.evaluate(() => (window as any).__coop.dumpState());
}

/**
 * Returns the first path at which two JSON values differ, for diagnostics
 */
export function findFirstDifference(a: unknown, b: unknown, path = "$"): string | null {
    if (a === b) {
        return null;
    }
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
        return `${path}: ${JSON.stringify(a)?.slice(0, 200)} !== ${JSON.stringify(b)?.slice(0, 200)}`;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return `${path}: array mismatch`;
    }
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const key of keys) {
        const diff = findFirstDifference((a as any)[key], (b as any)[key], `${path}.${key}`);
        if (diff) {
            return diff;
        }
    }
    return null;
}
