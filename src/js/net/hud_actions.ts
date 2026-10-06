/**
 * Helpers used by the HUD in co-op games. Instead of changing the game state
 * directly, the HUD sends actions which are applied on every client at the
 * same tick. These helpers only predict whether the action will succeed, so
 * the HUD can give immediate feedback (sounds, placement mode).
 */
import type { BaseItem } from "../game/base_item";
import type { Blueprint } from "../game/blueprint";
import type { Entity } from "../game/entity";
import type { MetaBuilding } from "../game/meta_building";
import type { GameRoot } from "../game/root";
import type { Vector } from "../core/vector";
import { serializeEntityData, serializeItem } from "./actions";

/**
 * Sends a placement. Returns whether it is expected to succeed.
 */
export function coopPlaceBuilding(
    root: GameRoot,
    {
        tile,
        rotation,
        variant,
        building,
    }: { tile: Vector; rotation: number; variant: string; building: MetaBuilding }
): boolean {
    // Predict with the current state, the action is validated again when applied
    const optimal = building.computeOptimalDirectionAndRotationVariantAtTile({
        root,
        tile,
        rotation,
        variant,
        layer: building.getLayer(),
    });
    const preview = building.createEntity({
        root,
        origin: tile,
        rotation: optimal.rotation,
        originalRotation: rotation,
        rotationVariant: optimal.rotationVariant,
        variant,
    });
    if (!root.logic.checkCanPlaceEntity(preview, {})) {
        return false;
    }

    root.coop.dispatch({
        type: "placeBuilding",
        payload: {
            x: tile.x,
            y: tile.y,
            building: building.getId(),
            variant,
            rotation,
            tunnelSmartplace: Boolean(root.app.settings.getAllSettings().enableTunnelSmartplace),
            editSignal: true,
        },
    });
    return true;
}

/**
 * Sends a deletion of the given entities. Returns whether anything will be deleted.
 */
export function coopDeleteEntities(root: GameRoot, entities: Entity[]): boolean {
    const uids = entities
        .filter(entity => entity && !entity.queuedForDestroy && !entity.destroyed)
        .filter(entity => root.logic.canDeleteBuilding(entity))
        .map(entity => entity.uid)
        .filter(uid => !root.coop.isDeletePending(uid));

    if (uids.length === 0) {
        return false;
    }
    root.coop.dispatch({ type: "deleteBuildings", payload: { uids } });
    return true;
}

export function coopDeleteUids(root: GameRoot, uids: number[]): boolean {
    return coopDeleteEntities(root, uids.map(uid => root.entityMgr.findByUid(uid, false)).filter(Boolean));
}

export function coopClearBelts(root: GameRoot, uids: number[]) {
    root.coop.dispatch({ type: "clearBelts", payload: { uids } });
}

/**
 * Sends a blueprint paste. Returns whether it is expected to place anything.
 */
export function coopPasteBlueprint(root: GameRoot, blueprint: Blueprint, tile: Vector): boolean {
    if (!blueprint.canPlace(root, tile)) {
        return false;
    }

    // @ts-expect-error The entities are private, but needed for the action
    const entities: Entity[] = blueprint.entities;

    root.coop.dispatch({
        type: "pasteBlueprint",
        payload: {
            x: tile.x,
            y: tile.y,
            entities: entities.map(entity => serializeEntityData(entity)),
            free: blueprint.getIsEffectivelyFree(root),
            cost: blueprint.getCost(),
        },
    });
    blueprint.isNextPasteFree = false;
    return true;
}

export function coopUnlockUpgrade(root: GameRoot, upgradeId: string): boolean {
    if (!root.hubGoals.canUnlockUpgrade(upgradeId)) {
        return false;
    }
    root.coop.dispatch({ type: "unlockUpgrade", payload: { upgradeId } });
    return true;
}

export function coopSetConstantSignal(root: GameRoot, uid: number, signal: BaseItem | null) {
    root.coop.dispatch({ type: "setConstantSignal", payload: { uid, signal: serializeItem(signal) } });
}

export function coopToggleLever(root: GameRoot, uid: number) {
    root.coop.dispatch({ type: "toggleLever", payload: { uid } });
}

export function coopAddWaypoint(root: GameRoot, label: string, position: Vector) {
    root.coop.dispatch({
        type: "addWaypoint",
        payload: {
            label,
            x: position.x,
            y: position.y,
            zoomLevel: root.camera.zoomLevel,
            layer: root.currentLayer,
        },
    });
}

export function coopRemoveWaypoint(
    root: GameRoot,
    waypoint: { label: string; center: { x: number; y: number } }
) {
    root.coop.dispatch({
        type: "removeWaypoint",
        payload: { label: waypoint.label, x: waypoint.center.x, y: waypoint.center.y },
    });
}

export function coopRenameWaypoint(
    root: GameRoot,
    waypoint: { label: string; center: { x: number; y: number } },
    label: string
) {
    root.coop.dispatch({
        type: "renameWaypoint",
        payload: { oldLabel: waypoint.label, x: waypoint.center.x, y: waypoint.center.y, label },
    });
}
