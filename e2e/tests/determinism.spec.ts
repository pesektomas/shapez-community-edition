import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "../scenarios/index.ts";
import {
    dumpState,
    findFirstDifference,
    getSnapshot,
    loadSnapshot,
    newWorld,
    openGame,
    runScenario,
} from "../helpers/game.ts";

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_FILE = join(here, "..", "golden-hashes.json");
const ARTIFACTS = join(here, "..", "..", "test-results", "desync");

function readGolden(): Record<string, string> {
    try {
        return JSON.parse(readFileSync(GOLDEN_FILE, "utf-8"));
    } catch {
        return {};
    }
}

for (const scenario of SCENARIOS) {
    test.describe(scenario.name, () => {
        /**
         * Layer 3: two independent game instances replay the same actions and
         * must have identical state hashes at every checkpoint
         */
        test("replay is deterministic in two instances", async ({ browser }) => {
            const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
            const pages = await Promise.all(contexts.map(ctx => ctx.newPage()));
            const errors = await Promise.all(pages.map(openGame));

            await Promise.all(pages.map(page => newWorld(page, scenario.seed, scenario.startLevel)));
            const [a, b] = await Promise.all(pages.map(page => runScenario(page, scenario)));

            if (a.hash !== b.hash) {
                const [stateA, stateB] = await Promise.all(pages.map(dumpState));
                mkdirSync(ARTIFACTS, { recursive: true });
                writeFileSync(join(ARTIFACTS, `${scenario.name}-a.json`), JSON.stringify(stateA, null, 1));
                writeFileSync(join(ARTIFACTS, `${scenario.name}-b.json`), JSON.stringify(stateB, null, 1));
                const firstCheckpoint = a.checkpoints.find((c, i) => c.hash !== b.checkpoints[i]?.hash);
                throw new Error(
                    `Desync, first differing checkpoint at tick ${firstCheckpoint?.tick}: ` +
                        findFirstDifference(stateA, stateB)
                );
            }
            expect(a.checkpoints).toEqual(b.checkpoints);

            const failure = scenario.check?.(a.info);
            expect(failure ?? null, "scenario sanity check").toBeNull();
            expect(errors.flat()).toEqual([]);
            await Promise.all(contexts.map(ctx => ctx.close()));
        });

        /**
         * Layer 5 (golden hashes) and layer 4 (cross browser): the final hash
         * must match the hash stored in the repository, in every engine
         */
        test("matches the golden hash", async ({ page }) => {
            const errors = await openGame(page);
            await newWorld(page, scenario.seed, scenario.startLevel);
            const result = await runScenario(page, scenario, { checkpointEveryTicks: 0 });

            const golden = readGolden();
            if (process.env.UPDATE_GOLDEN) {
                golden[scenario.name] = result.hash;
                writeFileSync(GOLDEN_FILE, JSON.stringify(golden, Object.keys(golden).sort(), 4) + "\n");
            } else {
                expect(golden[scenario.name], "golden hash missing, run with UPDATE_GOLDEN=1").toBeDefined();
                expect(result.hash).toBe(golden[scenario.name]);
            }
            expect(errors).toEqual([]);
        });

        /**
         * Save/load equivalence: restoring a snapshot in the middle of the
         * scenario must continue exactly like the original game
         */
        test("snapshot restore continues identically", async ({ browser }) => {
            const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
            const [original, restored] = await Promise.all(contexts.map(ctx => ctx.newPage()));
            await Promise.all([openGame(original), openGame(restored)]);

            const half = Math.floor(scenario.turns / 2);
            await newWorld(original, scenario.seed, scenario.startLevel);
            await runScenario(original, scenario, { toTurn: half, checkpointEveryTicks: 0 });

            const snapshot = await getSnapshot(original);
            await loadSnapshot(restored, snapshot);

            const [a, b] = await Promise.all([
                runScenario(original, scenario, { checkpointEveryTicks: 60 }),
                runScenario(restored, scenario, { checkpointEveryTicks: 60 }),
            ]);

            if (a.hash !== b.hash) {
                const [stateA, stateB] = await Promise.all([dumpState(original), dumpState(restored)]);
                const firstCheckpoint = a.checkpoints.find((c, i) => c.hash !== b.checkpoints[i]?.hash);
                throw new Error(
                    `Restored game diverged, first at tick ${firstCheckpoint?.tick}: ` +
                        findFirstDifference(stateA, stateB)
                );
            }
            expect(a.checkpoints).toEqual(b.checkpoints);
            await Promise.all(contexts.map(ctx => ctx.close()));
        });
    });
}
