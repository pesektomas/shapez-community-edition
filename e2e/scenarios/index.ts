import { beltLine, place, repeat, shapeSignal, wireLine, type Scenario } from "./dsl.ts";

/**
 * World layout for seed 42 (relevant resources):
 *  - circles (CuCuCuCu): x -12..-6, y 5..8
 *  - rectangles (RuRuRuRu): x 3..7, y -10..-4
 *  - red: x 4..8, y 5..10
 *  - hub: x -2..1, y -2..1
 */
const SEED = 42;

/**
 * Miners on the circle patch feeding a belt row at y=9 which moves right.
 * Belts only accept items from behind, so regular miners all eject into the
 * start of the row (only the first one contributes). Chainable miners pass
 * their items along the row instead.
 */
function circleSupply(toX: number, minerVariant = "default") {
    if (minerVariant === "chainable") {
        return [
            ...[-10, -9, -8, -7, -6].map(x => place("miner", x, 8, 90, minerVariant)),
            place("belt", -5, 8, 180),
            ...beltLine(-5, 9, toX, 9),
        ];
    }
    return [
        ...[-10, -9, -8, -7, -6].map(x => place("miner", x, 8, 180, minerVariant)),
        ...beltLine(-10, 9, toX, 9),
    ];
}

/** Basic line: circles into the hub from below at x=-2 */
function basicLine(minerVariant = "default") {
    return [...circleSupply(-3, minerVariant), ...beltLine(-2, 9, -2, 2)];
}

/** From level 11 on, only chainable miners are available */
const CHAINABLE = "chainable";

export const SCENARIOS: Scenario[] = [
    {
        name: "01-basic-line",
        seed: SEED,
        startLevel: 1,
        turns: 1000,
        steps: [{ turn: 0, actions: basicLine() }],
        check: info => (info.level >= 2 ? null : "Level 1 was not completed"),
    },
    {
        name: "02-processing",
        seed: SEED,
        startLevel: 11,
        turns: 1000,
        steps: [
            {
                turn: 0,
                actions: [
                    // Circles -> cutter -> rotator / straight -> stacker -> hub
                    ...circleSupply(-2),
                    ...beltLine(-1, 9, -1, 8),
                    place("cutter", -1, 7, 0),
                    place("rotator", -1, 6, 0),
                    place("belt", 0, 6, 0),
                    place("belt", -1, 5, 0),
                    place("belt", 0, 5, 0),
                    place("stacker", -1, 4, 0),
                    ...beltLine(-1, 3, -1, 2),

                    // Rectangles + red -> painter -> hub from the right
                    place("miner", 7, -9, 90),
                    ...beltLine(8, -9, 8, 2),
                    ...beltLine(8, 3, 6, 3),
                    place("painter", 5, 3, 180),
                    place("miner", 4, 5, 0),
                    place("belt", 4, 4, 0),
                    place("belt", 3, 3, 270),
                    ...beltLine(2, 3, 2, 2),
                    place("belt", 2, 1, 270),
                ],
            },
        ],
        check: info => {
            const keys = Object.keys(info.storedShapes);
            if (!keys.some(key => key.includes("r") && key.startsWith("Rr"))) {
                return "No painted rectangles delivered: " + keys.join(",");
            }
            if (!keys.some(key => key !== "CuCuCuCu" && key.includes("Cu"))) {
                return "No processed circles delivered: " + keys.join(",");
            }
            return null;
        },
    },
    {
        name: "03-logistics",
        seed: SEED,
        startLevel: 26,
        turns: 800,
        steps: [
            {
                turn: 0,
                actions: [
                    ...circleSupply(-4, CHAINABLE),
                    place("belt", -3, 9, 0),
                    place("belt", -3, 8, 0),
                    // Balancer splits into two lanes
                    place("balancer", -3, 7, 0),
                    place("belt", -2, 8, 0),
                    // Lane A: tunnel tier 1, lane B: tunnel tier 2
                    place("underground_belt", -3, 6, 0),
                    // Exits are placed facing backwards, like the HUD does after placing an entrance
                    place("underground_belt", -3, 3, 180),
                    place("underground_belt", -2, 6, 0, "tier2"),
                    place("underground_belt", -2, 3, 180, "tier2"),
                    place("belt", -3, 2, 90),
                    // Merger joins both lanes into the hub
                    place("balancer", -2, 2, 0, "merger-inverse"),
                    // Idle splitter to cover its code paths
                    place("balancer", 4, 2, 0, "splitter"),
                ],
            },
        ],
        check: info => ((info.storedShapes["CuCuCuCu"] ?? 0) > 20 ? null : "Too few circles delivered"),
    },
    {
        name: "04-wires-logic",
        seed: SEED,
        startLevel: 26,
        turns: 800,
        steps: [
            {
                turn: 0,
                actions: [
                    // Filter controlled by a constant signal
                    ...circleSupply(-3, CHAINABLE),
                    ...beltLine(-2, 9, -2, 7),
                    place("filter", -2, 6, 0),
                    ...beltLine(-2, 5, -2, 2),
                    ...beltLine(0, 6, 0, 2),
                    place("constant_signal", -3, 8, 0),
                    ...wireLine(-3, 7, -3, 6),

                    // Lever -> display
                    place("lever", 3, -4, 0),
                    ...wireLine(3, -5, 3, -6),
                    place("display", 3, -7, 0),

                    // Lever AND constant -> display
                    place("lever", 5, -2, 0),
                    ...wireLine(5, -3, 5, -4),
                    place("constant_signal", 7, -2, 0),
                    ...wireLine(7, -3, 7, -4),
                    place("logic_gate", 6, -4, 0),
                    ...wireLine(6, -5, 6, -6),
                    place("display", 6, -7, 0),
                ],
            },
            // Let circles pass the filter, later switch to rectangles (circles go right)
            { turn: 1, signalAt: { x: -3, y: 8, signal: shapeSignal("CuCuCuCu") } },
            { turn: 1, signalAt: { x: 7, y: -2, signal: { $: "boolean_item", data: 1 } } },
            { turn: 100, toggleAt: { x: 3, y: -4 } },
            { turn: 120, toggleAt: { x: 5, y: -2 } },
            { turn: 300, signalAt: { x: -3, y: 8, signal: shapeSignal("RuRuRuRu") } },
            { turn: 400, toggleAt: { x: 5, y: -2 } },
        ],
        check: info => {
            const circles = info.storedShapes["CuCuCuCu"] ?? 0;
            return circles > 10 ? null : "Too few circles delivered: " + circles;
        },
    },
    {
        name: "05-blueprint",
        seed: SEED,
        startLevel: 13,
        turns: 600,
        steps: [
            { turn: 0, actions: basicLine(CHAINABLE) },
            // Copy the miners and the belt row next to the line (free, like after a cut)
            {
                turn: 200,
                blueprint: { area: { x: -10, y: 8, w: 8, h: 2 }, to: { x: -10, y: 12 }, free: true },
            },
            // Not affordable: the blueprint shape was never delivered
            { turn: 210, blueprint: { area: { x: -10, y: 8, w: 8, h: 2 }, to: { x: -10, y: 16 }, cost: 50 } },
            // Overlapping paste: only free tiles get placed
            { turn: 220, blueprint: { area: { x: -2, y: 2, w: 1, h: 8 }, to: { x: -2, y: 5 }, free: true } },
        ],
    },
    {
        name: "06-mass-delete",
        seed: SEED,
        startLevel: 1,
        turns: 700,
        steps: [
            { turn: 0, actions: basicLine() },
            // Belts are full by now
            { turn: 300, deleteArea: { x: -8, y: 9, w: 4, h: 1 } },
            { turn: 320, deleteArea: { x: -2, y: 4, w: 1, h: 3 } },
            { turn: 400, actions: [...beltLine(-8, 9, -5, 9), ...beltLine(-2, 6, -2, 4)] },
        ],
    },
    {
        name: "07-level-and-upgrade",
        seed: SEED,
        startLevel: 1,
        turns: 900,
        steps: [
            { turn: 0, actions: basicLine() },
            // Try to buy the belt upgrade often, it succeeds as soon as it is affordable
            ...repeat(50, 850, 7, () => [{ type: "unlockUpgrade", payload: { upgradeId: "belt" } }]),
        ],
    },
    {
        name: "08-freeplay",
        seed: SEED,
        startLevel: 27,
        turns: 600,
        steps: [{ turn: 0, actions: basicLine(CHAINABLE) }],
        check: info => (info.level >= 27 ? null : "Not in freeplay"),
    },
    {
        name: "09-conflicts",
        seed: SEED,
        startLevel: 26,
        turns: 300,
        steps: [
            { turn: 0, actions: basicLine(CHAINABLE) },
            // Two players build on the same tile in the same turn, the first one wins
            { turn: 5, playerId: 1, actions: [place("belt", 3, 5, 0)] },
            { turn: 5, playerId: 2, actions: [place("miner", 3, 5, 90)] },
            // Both delete the same belt
            { turn: 50, playerId: 2, deleteArea: { x: -2, y: 5, w: 1, h: 1 } },
            { turn: 50, playerId: 1, deleteArea: { x: -2, y: 5, w: 1, h: 1 } },
            // Invalid actions are ignored everywhere
            {
                turn: 60,
                playerId: 2,
                actions: [
                    place("hub", 10, 10, 0),
                    place("nonexistent", 0, 0, 0),
                    place("belt", 0.5, 3, 0),
                    { type: "deleteBuildings", payload: { uids: [999999, -1] } },
                    { type: "unlockUpgrade", payload: { upgradeId: "__proto__" } },
                    { type: "setConstantSignal", payload: { uid: 10001, signal: shapeSignal("XXXX") } },
                ],
            },
            // Rebuild the deleted belt
            { turn: 70, playerId: 2, actions: [place("belt", -2, 5, 0)] },
        ],
    },
];
