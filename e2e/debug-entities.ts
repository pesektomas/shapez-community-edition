// Debug helper: runs a scenario and prints all buildings with their state
import { chromium } from "@playwright/test";
import { SCENARIOS } from "./scenarios/index.ts";

const [name, turnArg] = process.argv.slice(2);
const scenario = SCENARIOS.find(s => s.name.startsWith(name));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(process.env.E2E_BASE_URL ?? "http://localhost:3010/");
await page.waitForFunction(() => (window as any).__coop && document.body.id === "state_CoopState");
await page.evaluate(s => (window as any).__coop.newWorld(s), {
    seed: scenario.seed,
    startLevel: scenario.startLevel,
});
const result = await page.evaluate(
    ({ steps, toTurn }) => (window as any).__coop.runScenario({ steps, toTurn, checkpointEveryTicks: 0 }),
    { steps: scenario.steps, toTurn: Number(turnArg ?? scenario.turns) }
);
console.log(JSON.stringify(result.info));
const lines = await page.evaluate(() => {
    const root = (window as any).globalRoot;
    const out = [];
    for (const e of root.entityMgr.entities.values()) {
        const s = e.components.StaticMapEntity;
        const meta = s.getMetaBuilding().getId();
        let extra = "";
        if (e.components.Belt) extra += " path:" + e.components.Belt.assignedPath?.items.length;
        if (e.components.ItemEjector)
            extra +=
                " ej:" +
                e.components.ItemEjector.slots
                    .map(sl => (sl.item ? sl.item.getAsCopyableKey() : "-"))
                    .join(",");
        if (e.components.ItemProcessor)
            extra +=
                " charges:" +
                e.components.ItemProcessor.ongoingCharges.length +
                " in:" +
                e.components.ItemProcessor.inputSlots.size;
        if (e.components.UndergroundBelt)
            extra +=
                " ug:" +
                e.components.UndergroundBelt.mode +
                " pend:" +
                e.components.UndergroundBelt.pendingItems.length;
        if (e.components.WiredPins)
            extra +=
                " pins:" +
                e.components.WiredPins.slots
                    .map(p => (p.value ? p.value.getAsCopyableKey() : "null"))
                    .join(",");
        out.push(
            `${e.uid} ${meta}/${s.code} @${s.origin.x},${s.origin.y} r${s.rotation} L:${e.layer}${extra}`
        );
    }
    return out;
});
console.log(lines.join("\n"));
await browser.close();
