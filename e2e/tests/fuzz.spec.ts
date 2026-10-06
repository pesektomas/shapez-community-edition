import { expect, test } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Action } from "../../shared/protocol.ts";
import { dumpState, findFirstDifference, newWorld, openGame, runScenario } from "../helpers/game.ts";
import { mulberry32 } from "../helpers/mp.ts";
import type { Scenario, ScenarioStep } from "../scenarios/dsl.ts";

/**
 * Layer 6: thousands of random actions, valid and invalid, replayed in two
 * instances must give the same state. Reproduce a failure locally with
 * FUZZ_SEED=<seed> npx playwright test fuzz
 */
const SEEDS = process.env.FUZZ_SEED
    ? [Number(process.env.FUZZ_SEED)]
    : Array.from(
          { length: Number(process.env.FUZZ_RUNS ?? 2) },
          (_, i) => 1 + i + Number(process.env.FUZZ_OFFSET ?? 0)
      );
const TURNS = Number(process.env.FUZZ_TURNS ?? 400);

const BUILDINGS: Array<[string, string[]]> = [
    ["belt", ["default"]],
    ["miner", ["default", "chainable"]],
    ["cutter", ["default", "quad"]],
    ["rotator", ["default", "ccw", "rotate180"]],
    ["stacker", ["default"]],
    ["painter", ["default", "mirrored", "double", "quad"]],
    ["mixer", ["default"]],
    ["trash", ["default"]],
    ["balancer", ["default", "merger", "merger-inverse", "splitter", "splitter-inverse"]],
    ["underground_belt", ["default", "tier2"]],
    ["storage", ["default"]],
    ["filter", ["default"]],
    ["reader", ["default"]],
    ["lever", ["default"]],
    ["display", ["default"]],
    ["wire", ["default", "second"]],
    ["constant_signal", ["default"]],
    ["logic_gate", ["default", "not", "xor", "or"]],
    ["wire_tunnel", ["default"]],
    ["virtual_processor", ["default", "rotator", "unstacker", "stacker", "painter"]],
    ["analyzer", ["default"]],
    ["comparator", ["default"]],
    ["transistor", ["default", "mirrored"]],
    // Invalid ones
    ["hub", ["default"]],
    ["nonexistent", ["default"]],
    ["belt", ["nonexistent"]],
];

const SIGNALS = [
    { $: "shape", data: "CuCuCuCu" },
    { $: "shape", data: "RuRuRuRu" },
    { $: "shape", data: "not a shape" },
    { $: "color", data: "red" },
    { $: "boolean_item", data: 1 },
    null,
];

export function generateFuzzScenario(seed: number, turns: number): Scenario {
    const random = mulberry32(seed);
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)];
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));

    const steps: ScenarioStep[] = [];
    for (let turn = 0; turn < turns; ++turn) {
        const actions: Action[] = [];
        const count = random() < 0.3 ? int(1, 12) : 0;
        for (let i = 0; i < count; ++i) {
            const roll = random();
            if (roll < 0.6) {
                const [building, variants] = pick(BUILDINGS);
                actions.push({
                    type: "placeBuilding",
                    payload: {
                        x: int(-15, 15),
                        y: int(-12, 15),
                        building,
                        variant: pick(variants),
                        rotation: pick([0, 90, 180, 270, 45]),
                        tunnelSmartplace: random() < 0.5,
                    },
                });
            } else if (roll < 0.7) {
                actions.push({ type: "deleteBuildings", payload: { uids: [int(9990, 10000 + turn * 3)] } });
            } else if (roll < 0.75) {
                actions.push({
                    type: "unlockUpgrade",
                    payload: { upgradeId: pick(["belt", "miner", "processors", "painting", "nope"]) },
                });
            } else if (roll < 0.8) {
                actions.push({ type: "toggleLever", payload: { uid: int(10000, 10000 + turn * 3) } });
            } else if (roll < 0.85) {
                actions.push({
                    type: "setConstantSignal",
                    payload: { uid: int(10000, 10000 + turn * 3), signal: pick(SIGNALS) },
                });
            } else if (roll < 0.9) {
                actions.push({ type: "clearBelts", payload: { uids: [int(10000, 10000 + turn * 3)] } });
            } else {
                actions.push({
                    type: "addWaypoint",
                    payload: {
                        label: "W" + int(0, 9),
                        x: int(-500, 500),
                        y: int(-500, 500),
                        zoomLevel: 1,
                        layer: "regular",
                    },
                });
            }
        }
        const step: ScenarioStep = { turn, playerId: int(1, 3), actions };
        if (random() < 0.03) {
            step.deleteArea = { x: int(-15, 10), y: int(-12, 10), w: int(1, 8), h: int(1, 8) };
        }
        if (random() < 0.03) {
            // Pastes partially over existing buildings and over the hub
            step.blueprint = {
                area: { x: int(-15, 10), y: int(-12, 10), w: int(2, 8), h: int(2, 8) },
                to: { x: int(-12, 12), y: int(-12, 12) },
                free: random() < 0.7,
                cost: int(0, 20),
            };
        }
        if (actions.length > 0 || step.deleteArea || step.blueprint) {
            steps.push(step);
        }
    }

    return { name: "fuzz-" + seed, seed: 42, startLevel: pick([1, 12, 27]), turns, steps };
}

for (const seed of SEEDS) {
    test(`fuzz seed ${seed}: two instances agree`, async ({ browser }) => {
        test.setTimeout(10 * 60_000);
        const scenario = generateFuzzScenario(seed, TURNS);
        const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
        const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
        const errors = await Promise.all(pages.map(openGame));
        await Promise.all(pages.map(page => newWorld(page, scenario.seed, scenario.startLevel)));
        const [a, b] = await Promise.all(
            pages.map(page => runScenario(page, scenario, { checkpointEveryTicks: 300 }))
        );

        if (a.hash !== b.hash) {
            const [stateA, stateB] = await Promise.all(pages.map(dumpState));
            const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test-results", "desync");
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `fuzz-${seed}-a.json`), JSON.stringify(stateA));
            writeFileSync(join(dir, `fuzz-${seed}-b.json`), JSON.stringify(stateB));
            throw new Error(`Seed ${seed} diverged: ` + findFirstDifference(stateA, stateB));
        }
        expect(a.checkpoints).toEqual(b.checkpoints);
        expect(a.info.entities).toBeGreaterThan(1);
        // Invalid actions must be ignored, not crash the game
        expect(errors.flat()).toEqual([]);
        await Promise.all(contexts.map(ctx => ctx.close()));
    });
}
