import type { Action } from "../../shared/protocol.ts";

export type Rotation = 0 | 90 | 180 | 270;

export interface ScenarioStep {
    turn: number;
    playerId?: number;
    actions?: Action[];
    blueprint?: {
        area: { x: number; y: number; w: number; h: number };
        to: { x: number; y: number };
        free?: boolean;
        cost?: number;
    };
    deleteArea?: { x: number; y: number; w: number; h: number };
    deleteLayer?: string;
    /** Sets the signal of the constant signal at the tile (wires layer) */
    signalAt?: { x: number; y: number; signal: unknown };
    /** Toggles the lever at the tile */
    toggleAt?: { x: number; y: number };
}

export interface Scenario {
    name: string;
    seed: number;
    startLevel: number;
    /** How many turns to simulate (1 turn = 6 ticks) */
    turns: number;
    steps: ScenarioStep[];
    /** Sanity checks on the final state, so scenarios keep testing what they claim */
    check?: (info: ScenarioInfo) => string | null;
}

export interface ScenarioInfo {
    tick: number;
    turn: number;
    entities: number;
    level: number;
    timeSeconds: number;
    storedShapes: Record<string, number>;
}

export function place(
    building: string,
    x: number,
    y: number,
    rotation: Rotation = 0,
    variant = "default",
    tunnelSmartplace = true
): Action {
    return {
        type: "placeBuilding",
        payload: { x, y, building, variant, rotation, tunnelSmartplace },
    };
}

/**
 * Straight line of belts from (x1, y1) to (x2, y2) inclusive, moving in the
 * direction of the line
 */
export function beltLine(x1: number, y1: number, x2: number, y2: number, building = "belt"): Action[] {
    const actions: Action[] = [];
    const dx = Math.sign(x2 - x1);
    const dy = Math.sign(y2 - y1);
    assertStraight(dx, dy);
    const rotation: Rotation = dx > 0 ? 90 : dx < 0 ? 270 : dy > 0 ? 180 : 0;
    let x = x1;
    let y = y1;
    for (;;) {
        actions.push(place(building, x, y, rotation));
        if (x === x2 && y === y2) {
            break;
        }
        x += dx;
        y += dy;
    }
    return actions;
}

/** Straight line of wires (wires layer) */
export function wireLine(x1: number, y1: number, x2: number, y2: number): Action[] {
    return beltLine(x1, y1, x2, y2, "wire");
}

export function shapeSignal(key: string) {
    return { $: "shape", data: key };
}

function assertStraight(dx: number, dy: number) {
    if (dx !== 0 && dy !== 0) {
        throw new Error("Only straight lines are supported");
    }
}

/** Repeats an action every `every` turns */
export function repeat(from: number, to: number, every: number, actions: () => Action[]): ScenarioStep[] {
    const steps: ScenarioStep[] = [];
    for (let turn = from; turn <= to; turn += every) {
        steps.push({ turn, actions: actions() });
    }
    return steps;
}
