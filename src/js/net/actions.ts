import type { ActionPayloads, BlueprintEntityData, TurnAction } from "../../../shared/protocol";
import { gMetaBuildingRegistry } from "../core/global_registries";
import { Logger } from "../core/logging";
import { Vector } from "../core/vector";
import type { BaseItem } from "../game/base_item";
import { gBuildingVariants, getBuildingDataFromCode } from "../game/building_codes";
import { MetaHubBuilding } from "../game/buildings/hub";
import type { Entity } from "../game/entity";
import { itemResolverSingleton, typeItemSingleton } from "../game/item_resolver";
import type { MetaBuilding } from "../game/meta_building";
import type { GameRoot } from "../game/root";
import { ShapeDefinition } from "../game/shape_definition";
import { enumHubGoalRewards } from "../game/tutorial_goals";

const logger = new Logger("coop/actions");

const VALID_ROTATIONS = [0, 90, 180, 270];
const MAX_COORDINATE = 1_000_000;
const MAX_ENTITIES_PER_ACTION = 20_000;

/**
 * Applies an action to the game. This runs on every client in the same order
 * at the same tick, so it must only depend on the simulation state and the
 * action itself. Invalid actions are ignored (on every client alike).
 *
 * @returns Whether the action changed anything
 */
export function applyAction(root: GameRoot, action: TurnAction): boolean {
    try {
        switch (action.type) {
            case "placeBuilding":
                return applyPlaceBuilding(root, action.payload, action);
            case "restoreBuildings":
                return applyRestoreBuildings(root, action.payload);
            case "deleteBuildings":
                return applyDeleteBuildings(root, action.payload);
            case "clearBelts":
                return applyClearBelts(root, action.payload);
            case "pasteBlueprint":
                return applyPasteBlueprint(root, action.payload);
            case "unlockUpgrade":
                return applyUnlockUpgrade(root, action.payload);
            case "setConstantSignal":
                return applySetConstantSignal(root, action.payload);
            case "toggleLever":
                return applyToggleLever(root, action.payload);
            case "addWaypoint":
                return applyAddWaypoint(root, action.payload, action);
            case "removeWaypoint":
                return applyRemoveWaypoint(root, action.payload);
            case "renameWaypoint":
                return applyRenameWaypoint(root, action.payload);
            default:
                logger.warn("Ignoring unknown action", (action as TurnAction).type);
                return false;
        }
    } catch (err) {
        // Validation is based on the deterministic state, so every client
        // throws (and ignores the action) alike
        logger.error("Action failed:", action.type, err);
        return false;
    }
}

/////////////////// HELPERS ///////////////////

function isTileCoordinate(value: unknown): value is number {
    return Number.isInteger(value) && Math.abs(value as number) <= MAX_COORDINATE;
}

function isRotation(value: unknown): value is number {
    return VALID_ROTATIONS.includes(value as number);
}

function findMetaBuilding(id: string): MetaBuilding | null {
    return gMetaBuildingRegistry.getEntries().find(meta => meta.getId() === id) ?? null;
}

export function serializeItem(item: BaseItem | null): unknown {
    return item ? typeItemSingleton.serialize(item) : null;
}

export function deserializeItem(root: GameRoot, value: unknown): BaseItem | null {
    if (!value || typeof value !== "object") {
        return null;
    }
    const data = value as { $: string; data: unknown };
    if (data.$ === "shape" && !ShapeDefinition.isValidShortKey(String(data.data))) {
        throw new Error("Invalid shape key: " + data.data);
    }
    const item = itemResolverSingleton(root, data);
    if (!item) {
        throw new Error("Invalid item: " + JSON.stringify(data));
    }
    return item;
}

/**
 * Captures everything needed to re-create the entity (used by blueprints and undo)
 */
export function serializeEntityData(entity: Entity, offset: Vector | null = null): BlueprintEntityData {
    const staticComp = entity.components.StaticMapEntity;
    const data: BlueprintEntityData = {
        code: staticComp.code as number,
        x: staticComp.origin.x - (offset ? offset.x : 0),
        y: staticComp.origin.y - (offset ? offset.y : 0),
        rotation: staticComp.rotation,
        originalRotation: staticComp.originalRotation,
    };
    if (entity.components.ConstantSignal) {
        data.signal = serializeItem(entity.components.ConstantSignal.signal);
    }
    if (entity.components.Lever) {
        data.toggled = entity.components.Lever.toggled;
    }
    return data;
}

/**
 * Creates (but does not register) an entity from the serialized data
 */
export function createEntityFromData(root: GameRoot, data: BlueprintEntityData): Entity {
    if (!Object.prototype.hasOwnProperty.call(gBuildingVariants, data.code)) {
        throw new Error("Invalid building code: " + data.code);
    }
    if (!isTileCoordinate(data.x) || !isTileCoordinate(data.y)) {
        throw new Error("Invalid position");
    }
    if (!isRotation(data.rotation) || !isRotation(data.originalRotation)) {
        throw new Error("Invalid rotation");
    }

    const buildingData = getBuildingDataFromCode(data.code);
    if (buildingData.metaClass === MetaHubBuilding) {
        throw new Error("Can not create a hub");
    }

    const entity = buildingData.metaInstance.createEntity({
        root,
        origin: new Vector(data.x, data.y),
        rotation: data.rotation,
        originalRotation: data.originalRotation,
        rotationVariant: buildingData.rotationVariant,
        variant: buildingData.variant,
    });

    if (entity.components.ConstantSignal && data.signal !== undefined) {
        entity.components.ConstantSignal.signal = deserializeItem(root, data.signal);
    }
    if (entity.components.Lever && data.toggled !== undefined) {
        entity.components.Lever.toggled = Boolean(data.toggled);
    }
    return entity;
}

/**
 * Places the given entities at an offset, like a blueprint paste. Entities which
 * can not be placed are skipped. Returns how many entities were placed.
 */
function placeEntities(root: GameRoot, entities: Entity[], offset: Vector): number {
    return root.logic.performBulkOperation(() =>
        root.logic.performImmutableOperation(() => {
            let count = 0;
            for (const entity of entities) {
                if (!root.logic.checkCanPlaceEntity(entity, { offset })) {
                    continue;
                }
                const clone = entity.clone();
                clone.components.StaticMapEntity.origin.addInplace(offset);
                root.logic.freeEntityAreaBeforeBuild(clone);
                root.map.placeStaticEntity(clone);
                root.entityMgr.registerEntity(clone);
                count++;
            }
            return count;
        })
    );
}

function getValidEntityList(list: unknown): BlueprintEntityData[] {
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ENTITIES_PER_ACTION) {
        throw new Error("Invalid entity list");
    }
    return list as BlueprintEntityData[];
}

function getValidUidList(list: unknown): number[] {
    if (!Array.isArray(list) || list.length > MAX_ENTITIES_PER_ACTION) {
        throw new Error("Invalid uid list");
    }
    return list.filter(uid => Number.isInteger(uid));
}

/////////////////// ACTIONS ///////////////////

function applyPlaceBuilding(root: GameRoot, payload: ActionPayloads["placeBuilding"], action: TurnAction) {
    const { x, y, rotation, variant } = payload;
    if (!isTileCoordinate(x) || !isTileCoordinate(y) || !isRotation(rotation)) {
        return false;
    }

    const metaBuilding = findMetaBuilding(payload.building);
    if (
        !metaBuilding ||
        metaBuilding instanceof MetaHubBuilding ||
        !metaBuilding.getIsUnlocked(root) ||
        root.gameMode.isBuildingExcluded(metaBuilding.constructor as typeof MetaBuilding) ||
        !metaBuilding.getAvailableVariants(root).includes(variant)
    ) {
        return false;
    }

    const tile = new Vector(x, y);

    // The effective rotation depends on the surroundings (e.g. belt curves),
    // so it is computed when the action is applied
    const optimal = metaBuilding.computeOptimalDirectionAndRotationVariantAtTile({
        root,
        tile,
        rotation,
        variant,
        layer: metaBuilding.getLayer(),
    });

    const entity = root.logic.tryPlaceBuilding({
        origin: tile,
        rotation: optimal.rotation,
        rotationVariant: optimal.rotationVariant,
        originalRotation: rotation,
        building: metaBuilding,
        variant,
    });

    if (!entity) {
        return false;
    }

    // Listeners read the per-action flags through root.coop.currentAction
    assert(root.coop.currentAction === action, "Current action not set");
    root.signals.entityManuallyPlaced.dispatch(entity);
    return true;
}

function applyRestoreBuildings(root: GameRoot, payload: ActionPayloads["restoreBuildings"]) {
    const list = getValidEntityList(payload.entities);
    const entities = list.map(data => createEntityFromData(root, data));
    return placeEntities(root, entities, new Vector(0, 0)) > 0;
}

function applyDeleteBuildings(root: GameRoot, payload: ActionPayloads["deleteBuildings"]) {
    const uids = getValidUidList(payload.uids);

    const deleteAll = () => {
        let count = 0;
        for (const uid of uids) {
            const entity = root.entityMgr.findByUid(uid, false);
            if (entity && root.logic.tryDeleteBuilding(entity)) {
                count++;
            }
        }
        return count;
    };

    const count = uids.length > 1 ? root.logic.performBulkOperation(deleteAll) : deleteAll();
    return count > 0;
}

function applyClearBelts(root: GameRoot, payload: ActionPayloads["clearBelts"]) {
    const uids = getValidUidList(payload.uids);
    let any = false;
    for (const uid of uids) {
        const entity = root.entityMgr.findByUid(uid, false);
        if (!entity) {
            continue;
        }
        for (const component of Object.values(entity.components)) {
            component.clear();
        }
        any = true;
    }
    return any;
}

function applyPasteBlueprint(root: GameRoot, payload: ActionPayloads["pasteBlueprint"]) {
    const { x, y } = payload;
    if (!isTileCoordinate(x) || !isTileCoordinate(y)) {
        return false;
    }

    const cost = payload.cost;
    if (!Number.isInteger(cost) || cost < 0) {
        return false;
    }

    const effectivelyFree = root.gameMode.getHasFreeCopyPaste() || Boolean(payload.free) || cost === 0;
    if (!effectivelyFree) {
        if (!root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_blueprints)) {
            return false;
        }
        if (root.hubGoals.getShapesStoredByKey(root.gameMode.getBlueprintShapeKey()) < cost) {
            return false;
        }
    }

    const list = getValidEntityList(payload.entities);
    const entities = list.map(data => createEntityFromData(root, data));

    const placed = placeEntities(root, entities, new Vector(x, y));
    if (placed > 0 && !effectivelyFree) {
        root.hubGoals.takeShapeByKey(root.gameMode.getBlueprintShapeKey(), cost);
    }
    return placed > 0;
}

function applyUnlockUpgrade(root: GameRoot, payload: ActionPayloads["unlockUpgrade"]) {
    const upgrades = root.gameMode.getUpgrades();
    if (typeof payload.upgradeId !== "string" || !Object.hasOwn(upgrades, payload.upgradeId)) {
        return false;
    }
    return root.hubGoals.tryUnlockUpgrade(payload.upgradeId);
}

function applySetConstantSignal(root: GameRoot, payload: ActionPayloads["setConstantSignal"]) {
    const entity = root.entityMgr.findByUid(payload.uid, false);
    const constantComp = entity?.components.ConstantSignal;
    if (!constantComp) {
        return false;
    }
    constantComp.signal = deserializeItem(root, payload.signal);
    return true;
}

function applyToggleLever(root: GameRoot, payload: ActionPayloads["toggleLever"]) {
    const entity = root.entityMgr.findByUid(payload.uid, false);
    const leverComp = entity?.components.Lever;
    if (!leverComp) {
        return false;
    }
    leverComp.toggled = !leverComp.toggled;
    return true;
}

function getWaypointsHud(root: GameRoot) {
    return root.hud.parts.waypoints ?? null;
}

function findWaypoint(root: GameRoot, label: string, x: number, y: number) {
    return (
        getWaypointsHud(root)?.waypoints.find(
            waypoint => waypoint.label === label && waypoint.center.x === x && waypoint.center.y === y
        ) ?? null
    );
}

function applyAddWaypoint(root: GameRoot, payload: ActionPayloads["addWaypoint"], action: TurnAction) {
    const hud = getWaypointsHud(root);
    const { label, x, y, zoomLevel, layer } = payload;
    if (
        !hud ||
        typeof label !== "string" ||
        label.length === 0 ||
        label.length > 200 ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(zoomLevel) ||
        (layer !== "regular" && layer !== "wires")
    ) {
        return false;
    }

    hud.waypoints.push({ label, center: { x, y }, zoomLevel, layer });
    hud.sortWaypoints();
    hud.rerenderWaypointList();
    root.coop.onWaypointAdded(action);
    return true;
}

function applyRemoveWaypoint(root: GameRoot, payload: ActionPayloads["removeWaypoint"]) {
    const waypoint = findWaypoint(root, payload.label, payload.x, payload.y);
    if (!waypoint) {
        return false;
    }
    getWaypointsHud(root).deleteWaypoint(waypoint);
    return true;
}

function applyRenameWaypoint(root: GameRoot, payload: ActionPayloads["renameWaypoint"]) {
    const waypoint = findWaypoint(root, payload.oldLabel, payload.x, payload.y);
    if (!waypoint || typeof payload.label !== "string" || payload.label.length === 0) {
        return false;
    }
    waypoint.label = payload.label;
    const hud = getWaypointsHud(root);
    hud.sortWaypoints();
    hud.rerenderWaypointList();
    return true;
}
