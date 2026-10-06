import { expect, test, type Page } from "@playwright/test";
import { createWorldApi, expectInSync, getNetInfo, joinAsPlayer } from "../helpers/mp.ts";
import { startCoopServer, type CoopServerProcess } from "../helpers/server.ts";

/**
 * Layer 7, scenario 8: real mouse input goes through the action layer and
 * shows up for the other player. The dev build asserts if the HUD changes
 * entities directly, which would fail the test with a page error.
 */
test.describe.configure({ mode: "serial" });

let server: CoopServerProcess;

test.beforeAll(async () => {
    server = await startCoopServer();
});

test.afterAll(async () => {
    await server?.stop();
});

/** Screen position of the center of a tile */
async function tileToScreen(page: Page, x: number, y: number) {
    return page.evaluate(
        ({ x, y }) => {
            const root = (window as any).globalRoot;
            const Vector = (window as any).shapez.Vector;
            const screen = root.camera.worldToScreen(new Vector((x + 0.5) * 32, (y + 0.5) * 32));
            return { x: screen.x, y: screen.y };
        },
        { x, y }
    );
}

async function entityAt(page: Page, x: number, y: number) {
    return page.evaluate(
        ({ x, y }) => {
            const entity = (window as any).globalRoot.map.getLayerContentXY(x, y, "regular");
            return entity ? entity.components.StaticMapEntity.getMetaBuilding().getId() : null;
        },
        { x, y }
    );
}

test("8: building and deleting with the mouse reaches the other player", async ({ browser }) => {
    test.setTimeout(180_000);
    const world = await createWorldApi(server.baseURL, "fresh", "UI");
    const builder = await joinAsPlayer(browser, world.url, "Builder");
    const watcher = await joinAsPlayer(browser, world.url, "Watcher");
    const page = builder.page;

    // Players list shows both
    await expect(watcher.page.locator("#ingame_HUD_CoopPlayers .player")).toHaveCount(2);

    // Select the belt (hotkey 1) and drag a line of belts with the mouse
    await page.mouse.move(640, 400);
    await page.keyboard.press("1");
    const from = await tileToScreen(page, 3, 4);
    const to = await tileToScreen(page, 6, 4);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press("Escape");

    for (const x of [3, 4, 5, 6]) {
        await expect.poll(() => entityAt(watcher.page, x, 4), { timeout: 10_000 }).toBe("belt");
    }

    // Delete one belt with a right click
    const target = await tileToScreen(page, 4, 4);
    await page.mouse.click(target.x, target.y, { button: "right" });
    await expect.poll(() => entityAt(watcher.page, 4, 4), { timeout: 10_000 }).toBe(null);
    expect(await entityAt(page, 4, 4)).toBe(null);

    // Undo restores it for everybody
    await page.keyboard.press("Control+z");
    await expect.poll(() => entityAt(watcher.page, 4, 4), { timeout: 10_000 }).toBe("belt");

    // Chat
    await watcher.page.keyboard.press("Enter");
    await watcher.page.keyboard.type("ahoj");
    await watcher.page.keyboard.press("Enter");
    await expect(page.locator("#ingame_HUD_CoopChat .message").last()).toContainText("ahoj");

    // Cursor of the builder is drawn for the watcher (cursor data arrives)
    const info = await getNetInfo(page);
    await expectInSync([page, watcher.page], info.latestTurn + 10);
    expect([...builder.errors, ...watcher.errors]).toEqual([]);
    await builder.context.close();
    await watcher.context.close();
});
